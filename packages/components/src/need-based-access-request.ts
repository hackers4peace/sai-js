import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import type {
  EmbeddedNeedBasedAccessRequest,
  NeedBasedAccessRequestGroup,
  NeedBasedAccessRequestReceived,
} from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import {
  BadRequestHttpError,
  ForbiddenHttpError,
  ResponseDescription,
} from '@solid/community-server'

import type { SessionManager } from './SessionManager.js'

/** The request-to-be, before the owner mints its real id. */
export type NeedBasedAccessRequestInput = Omit<EmbeddedNeedBasedAccessRequest, 'id'>

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** Normalize the compact action terms the frozen payload may carry. */
const ACTION_ALIASES: Record<string, string> = {
  read: ACCESS_ACTIONS.read,
  modify: ACCESS_ACTIONS.modify,
  create: ACCESS_ACTIONS.create,
  delete: ACCESS_ACTIONS.delete,
  'odrl:read': ACCESS_ACTIONS.read,
  'odrl:modify': ACCESS_ACTIONS.modify,
  'lws:create': ACCESS_ACTIONS.create,
  'odrl:delete': ACCESS_ACTIONS.delete,
}

function accessModes(value: unknown): string[] {
  return strings(value).map((action) => ACTION_ALIASES[action] ?? action)
}

/**
 * Narrow a request body to the frozen ODRL needs request:
 * `AccessRequest` + `NeedBasedAccessRequest` with ODRL `access[]` policies.
 */
export function isOdrlNeedBasedAccessRequest(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const types = strings((value as Record<string, unknown>).type)
  return (
    (types.includes(INTEROP.NeedBasedAccessRequest) || types.includes('NeedBasedAccessRequest')) &&
    Array.isArray((value as Record<string, unknown>).access)
  )
}

/**
 * Map the frozen needs request policies back to the embedded need-group
 * representation the owner-side activity and workflow materialize. Need IDs,
 * shape trees, and inherited children ride the ODRL policies; the wire does
 * not carry envelope-level `grantee`/`grantedBy`/`dataOwner`.
 */
export function needBasedAccessRequestFromOdrl(
  message: Record<string, unknown>,
  requesterWebId: string,
  expectedDataOwner?: string
): NeedBasedAccessRequestInput {
  const policies = Array.isArray(message.access)
    ? (message.access as Record<string, unknown>[])
    : []
  if (policies.length === 0) {
    throw new BadRequestHttpError('access request has no access policies')
  }
  const nodes = policies.map((policy) => {
    const permission = (
      Array.isArray(policy.permission) ? policy.permission[0] : policy.permission
    ) as Record<string, unknown> | undefined
    const target = (permission?.target as Record<string, unknown> | undefined) ?? {}
    const types = strings(policy.type)
    return {
      id: (policy.uid ?? policy.id) as string,
      type: types,
      registeredShapeTree: (policy.registeredShapeTree ??
        (Array.isArray(target.source) ? target.source[0] : target.source)) as string,
      required: types.includes(INTEROP.AccessRequired) || types.includes('AccessRequired'),
      accessMode: accessModes(permission?.action),
      inheritsFromNeed: policy.inheritsFromNeed as string | undefined,
      group: policy.accessNeedGroup as string | undefined,
      assignee: permission?.assignee as string,
      assigner: permission?.assigner as string,
      owner: target.owner as string | undefined,
    }
  })
  const first = nodes[0]
  if (!first.assigner || first.assigner !== requesterWebId) {
    throw new BadRequestHttpError('invalid requester')
  }
  if (first.assignee !== first.assigner) {
    throw new BadRequestHttpError('invalid grantedBy/grantee')
  }
  if (expectedDataOwner && first.owner !== expectedDataOwner) {
    throw new BadRequestHttpError('invalid dataOwner')
  }
  const groupId = first.group ?? `urn:uuid:${crypto.randomUUID()}`
  const childrenOf = (id: string) => nodes.filter((node) => node.inheritsFromNeed === id)
  const toNeed = (node: (typeof nodes)[number]): Record<string, unknown> => ({
    id: node.id,
    type: [INTEROP.AccessNeed],
    registeredShapeTree: node.registeredShapeTree,
    required: node.required ? INTEROP.AccessRequired : INTEROP.AccessOptional,
    accessMode: node.accessMode,
    ...(childrenOf(node.id).length ? { hasInheritingNeed: childrenOf(node.id).map(toNeed) } : {}),
  })
  const group: NeedBasedAccessRequestGroup = {
    id: groupId,
    type: [INTEROP.AccessNeedGroup],
    hasAccessNeed: nodes.filter((node) => !node.inheritsFromNeed).map(toNeed),
  }
  return {
    type: [INTEROP.NeedBasedAccessRequest],
    grantee: first.assignee,
    grantedBy: first.assigner,
    dataOwner: first.owner!,
    hasAccessNeedGroup: group,
  }
}

/**
 * Accept an embedded need-based access request: validate the self-request and
 * owner registration, pre-mint the request id in the OWNER's
 * `AccessRequestRegistry`, write the `NeedBasedAccessRequestReceived`
 * activity, and return the empty `202` the frozen contract requires.
 *
 * `expectedDataOwner` is the owner encoded in the owner-scoped endpoint.
 */
export async function acceptNeedBasedAccessRequest(
  sessionManager: SessionManager,
  message: NeedBasedAccessRequestInput,
  requesterWebId: string,
  expectedDataOwner?: string
): Promise<ResponseDescription> {
  // the client-is-requester's-UAS check ran in the handler (403);
  // self-requests only — grantee === grantedBy === the authenticated agent
  if (message.grantedBy !== message.grantee || message.grantedBy !== requesterWebId) {
    throw new BadRequestHttpError('invalid grantedBy/grantee')
  }
  if (expectedDataOwner && message.dataOwner !== expectedDataOwner) {
    throw new BadRequestHttpError('invalid dataOwner')
  }
  // the requester must be registered with the data owner (403)
  const sai = await sessionManager.getSession(message.dataOwner)
  const registration = await sai.findSocialAgentRegistration(requesterWebId)
  if (!registration) {
    throw new ForbiddenHttpError('agent is not registered with the data owner')
  }
  // the received half (authorization-granting.md §6.2): pre-mint the
  // request id in the OWNER's AccessRequestRegistry and write the
  // `NeedBasedAccessRequestReceived` activity (real-id embedded projection
  // at the minted id, `target` = the registry) — the owner-side workflow
  // PUTs the AccessRequest resource there (find-first idempotent). The 202
  // is sent IMMEDIATELY — it awaits nothing beyond the activity write.
  const requestRegistry = sai.registrySet.hasAccessRequestRegistry
  if (!requestRegistry) throw new Error('access-request registry not found in registry set')
  const requestId = await sai.mintIdentifier(requestRegistry.id)
  const activityRegistry = sai.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')
  const object: EmbeddedNeedBasedAccessRequest = {
    id: requestId,
    type: [INTEROP.NeedBasedAccessRequest],
    grantee: message.grantee,
    grantedBy: message.grantedBy,
    dataOwner: message.dataOwner,
    hasAccessNeedGroup: message.hasAccessNeedGroup,
  }
  const activity: Omit<NeedBasedAccessRequestReceived, 'id'> = {
    type: ['Activity', 'NeedBasedAccessRequestReceived'],
    actor: sai.webId,
    target: requestRegistry.id,
    object,
    createdAt: new Date().toISOString(),
  }
  await ActivityRegistry.createActivity(
    activityRegistry,
    {
      fetch: sai.fetch,
      randomUUID: sai.randomUUID,
      identifierStrategies: sai.identifierStrategies,
    },
    activity
  )
  return new ResponseDescription(202)
}
