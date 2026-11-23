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
  RepresentationMetadata,
  ResponseDescription,
  SOLID_HTTP,
} from '@solid/community-server'

import type { SessionManager } from './SessionManager.js'

/** The request-to-be, before the owner mints its real id. */
export type NeedBasedAccessRequestInput = Omit<EmbeddedNeedBasedAccessRequest, 'id'>

export function values(value: unknown): Array<string> {
  if (typeof value === 'string') {
    return [value]
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/** Normalize the compact action terms the frozen payload may carry. */
const ACTION_ALIASES: Record<string, string> = {
  read: ACCESS_ACTIONS.read,
  modify: ACCESS_ACTIONS.modify,
  create: ACCESS_ACTIONS.create,
  delete: ACCESS_ACTIONS.delete,
  'odrl:read': ACCESS_ACTIONS.read,
  'odrl:modify': ACCESS_ACTIONS.modify,
  'odrl:create': ACCESS_ACTIONS.create,
  'lws:create': ACCESS_ACTIONS.create,
  'odrl:delete': ACCESS_ACTIONS.delete,
  'http://www.w3.org/ns/odrl/2/create': ACCESS_ACTIONS.create,
}

const KNOWN_ACTIONS = new Set<string>(Object.values(ACCESS_ACTIONS))

/** Normalize and validate the access actions of one or more permissions. */
export function accessModes(value: unknown): Array<string> {
  const actions = values(value)
  if (actions.length === 0) {
    throw new BadRequestHttpError('access need permission has no action')
  }
  const modes = actions.map((action) => {
    const normalized = ACTION_ALIASES[action] ?? action
    if (!KNOWN_ACTIONS.has(normalized)) {
      throw new BadRequestHttpError(`unsupported access action ${action}`)
    }
    return normalized
  })
  return [...new Set(modes)]
}

/**
 * Match a target type by its compact term, prefixed term, or full IRI. The
 * LWS/source payloads mix `Asset`, `odrl:Asset`, and the ODRL IRI.
 */
export function targetHasType(types: ReadonlyArray<string>, term: string, iri: string): boolean {
  return types.some(
    (value) =>
      value === term ||
      value === iri ||
      value.endsWith(`#${term}`) ||
      value.endsWith(`/${term}`) ||
      value.endsWith(`:${term}`)
  )
}

function targetOf(permission: Record<string, unknown>): Record<string, unknown> {
  const target = record(permission.target)
  if (!target) {
    throw new BadRequestHttpError('access need permission has no target')
  }
  return target
}

function targetTypes(target: Record<string, unknown>): Array<string> {
  return values(target.type)
}

function targetSources(target: Record<string, unknown>): Array<string> {
  return values(target.source)
}

function permissionsOf(policy: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = policy.permission
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  if (list.length === 0) {
    throw new BadRequestHttpError('access need has no permission')
  }
  return list.map((permission) => {
    const parsed = record(permission)
    if (!parsed) {
      throw new BadRequestHttpError('invalid access need permission')
    }
    return parsed
  })
}

/** ODRL constraints have no SAI needs representation yet. */
function rejectConstraints(
  policy: Record<string, unknown>,
  permissions: ReadonlyArray<Record<string, unknown>>
): void {
  if (
    policy.constraint !== undefined ||
    permissions.some((permission) => permission.constraint !== undefined)
  ) {
    throw new BadRequestHttpError(
      'ODRL constraints are not supported by the SAI access request profile'
    )
  }
}

const ODRL_ASSET = 'http://www.w3.org/ns/odrl/2/Asset'
const ODRL_ASSET_COLLECTION = 'http://www.w3.org/ns/odrl/2/AssetCollection'
const SHAPE_TREE = 'https://www.w3.org/ns/shapetrees#ShapeTree'

function isAssetTarget(target: Record<string, unknown>): boolean {
  return targetHasType(targetTypes(target), 'Asset', ODRL_ASSET)
}

function isCollectionTarget(target: Record<string, unknown>): boolean {
  return targetHasType(targetTypes(target), 'AssetCollection', ODRL_ASSET_COLLECTION)
}

function isShapeTreeTarget(target: Record<string, unknown>): boolean {
  return targetHasType(targetTypes(target), 'ShapeTree', SHAPE_TREE)
}

function isRegistrationTarget(target: Record<string, unknown>): boolean {
  return targetHasType(targetTypes(target), 'DataRegistration', INTEROP.DataRegistration)
}

interface ParsedPolicy {
  id: string
  types: Array<string>
  registeredShapeTree: string
  required: boolean
  accessMode: Array<string>
  inheritsFromNeed?: string
  group?: string
  assignee: string
  assigner: string
  owner?: string
  hasDataInstance?: Array<string>
  hasDataRegistration?: string
}

function parsePolicy(
  policy: Record<string, unknown>,
  requesterWebId: string,
  expectedDataOwner?: string
): ParsedPolicy {
  if (policy.registeredShapeTree !== undefined) {
    throw new BadRequestHttpError('registeredShapeTree belongs on the target, not the policy')
  }
  const permissions = permissionsOf(policy)
  rejectConstraints(policy, permissions)

  const assigners = new Set<string>()
  const assignees = new Set<string>()
  const owners = new Set<string>()
  for (const permission of permissions) {
    const target = targetOf(permission)
    const assigner = permission.assigner
    const assignee = permission.assignee
    if (typeof assigner !== 'string' || assigner !== requesterWebId) {
      throw new BadRequestHttpError('invalid requester')
    }
    if (typeof assignee !== 'string' || assignee !== assigner) {
      throw new BadRequestHttpError('invalid grantedBy/grantee')
    }
    assigners.add(assigner)
    assignees.add(assignee)
    if (typeof target.owner === 'string') {
      owners.add(target.owner)
    } else if (expectedDataOwner) {
      throw new BadRequestHttpError('invalid dataOwner')
    }
  }
  if (assigners.size !== 1 || assignees.size !== 1) {
    throw new BadRequestHttpError('inconsistent authorization assignee/assigner')
  }
  const owner = expectedDataOwner ?? [...owners][0]
  if (expectedDataOwner && owners.size > 0 && !owners.has(expectedDataOwner)) {
    throw new BadRequestHttpError('invalid dataOwner')
  }

  const instanceTargets = permissions.filter((permission) => isAssetTarget(targetOf(permission)))
  const collectionTargets = permissions.filter((permission) =>
    isCollectionTarget(targetOf(permission))
  )
  if (instanceTargets.length > 0 && collectionTargets.length > 0) {
    throw new BadRequestHttpError('access need mixes instance and collection targets')
  }
  if (instanceTargets.length === 0 && collectionTargets.length === 0) {
    throw new BadRequestHttpError('access need target is neither an Asset nor an AssetCollection')
  }

  const types = values(policy.type)
  const required = targetHasType(types, 'AccessRequired', INTEROP.AccessRequired)
  const id =
    (typeof policy.uid === 'string' && policy.uid) ||
    (typeof policy.id === 'string' && policy.id) ||
    `urn:uuid:${crypto.randomUUID()}`

  if (instanceTargets.length > 0) {
    if (instanceTargets.some((permission) => targetOf(permission).partOf !== undefined)) {
      throw new BadRequestHttpError('instance access needs use hasDataRegistration, not partOf')
    }
    const registeredShapeTree = targetOf(instanceTargets[0]!).registeredShapeTree
    if (typeof registeredShapeTree !== 'string' || !registeredShapeTree) {
      throw new BadRequestHttpError('instance access needs require registeredShapeTree')
    }
    const instances = [
      ...new Set(instanceTargets.flatMap((permission) => targetSources(targetOf(permission)))),
    ]
    if (instances.length === 0) {
      throw new BadRequestHttpError('instance access need has no source instance')
    }
    const registrations = [
      ...new Set(
        instanceTargets.flatMap((permission) => values(targetOf(permission).hasDataRegistration))
      ),
    ]
    if (registrations.length > 1) {
      throw new BadRequestHttpError('instance access need spans multiple registrations')
    }
    return {
      id,
      types,
      registeredShapeTree,
      required,
      accessMode: [
        ...new Set(instanceTargets.flatMap((permission) => accessModes(permission.action))),
      ],
      inheritsFromNeed: policy.inheritsFromNeed as string | undefined,
      group: policy.accessNeedGroup as string | undefined,
      assignee: [...assignees][0],
      assigner: [...assigners][0],
      ...(owner ? { owner } : {}),
      hasDataInstance: instances,
      ...(registrations[0] ? { hasDataRegistration: registrations[0] } : {}),
    }
  }

  const registrations = [
    ...new Set(
      collectionTargets
        .filter((permission) => isRegistrationTarget(targetOf(permission)))
        .flatMap((permission) => targetSources(targetOf(permission)))
    ),
  ]
  if (registrations.length > 1) {
    throw new BadRequestHttpError('access need spans multiple registrations')
  }
  const shapeTrees = [
    ...new Set(
      collectionTargets
        .filter((permission) => isShapeTreeTarget(targetOf(permission)))
        .flatMap((permission) => targetSources(targetOf(permission)))
    ),
  ]
  if (registrations.length > 0 && shapeTrees.length > 0) {
    throw new BadRequestHttpError('access need mixes registration and shape-tree targets')
  }
  if (shapeTrees.length > 1) {
    throw new BadRequestHttpError('access need spans multiple shape trees')
  }
  const declaredShapeTree = collectionTargets
    .map((permission) => targetOf(permission).registeredShapeTree)
    .find((value): value is string => typeof value === 'string' && value !== '')
  if (declaredShapeTree && shapeTrees[0] && declaredShapeTree !== shapeTrees[0]) {
    throw new BadRequestHttpError('access need shape tree does not match its target')
  }
  const registeredShapeTree = declaredShapeTree ?? shapeTrees[0]
  if (!registeredShapeTree) {
    throw new BadRequestHttpError('access need has no registeredShapeTree')
  }
  return {
    id,
    types,
    registeredShapeTree,
    required,
    accessMode: [
      ...new Set(collectionTargets.flatMap((permission) => accessModes(permission.action))),
    ],
    inheritsFromNeed: policy.inheritsFromNeed as string | undefined,
    group: policy.accessNeedGroup as string | undefined,
    assignee: [...assignees][0],
    assigner: [...assigners][0],
    ...(owner ? { owner } : {}),
    ...(registrations[0] ? { hasDataRegistration: registrations[0] } : {}),
  }
}

/**
 * Narrow a request body to the frozen ODRL needs request:
 * `AccessRequest` + `NeedBasedAccessRequest` with ODRL `access[]` policies.
 */
export function isOdrlNeedBasedAccessRequest(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const types = values((value as Record<string, unknown>).type)
  return (
    (types.includes(INTEROP.NeedBasedAccessRequest) || types.includes('NeedBasedAccessRequest')) &&
    Array.isArray((value as Record<string, unknown>).access)
  )
}

/**
 * Map the frozen needs request policies back to the embedded need-group
 * representation the owner-side activity and workflow materialize. Need IDs,
 * shape trees, requested instances/registrations, and inherited children ride
 * the ODRL policies; the wire does not carry envelope-level
 * `grantee`/`grantedBy`/`dataOwner`.
 */
export function needBasedAccessRequestFromOdrl(
  message: Record<string, unknown>,
  requesterWebId: string,
  expectedDataOwner?: string
): NeedBasedAccessRequestInput {
  const rawPolicies = Array.isArray(message.access) ? message.access : []
  const policies = rawPolicies.map((policy) => {
    const parsed = record(policy)
    if (!parsed) {
      throw new BadRequestHttpError('invalid access policy')
    }
    return parsed
  })
  if (policies.length === 0) {
    throw new BadRequestHttpError('access request has no access policies')
  }
  const nodes = policies.map((policy) => parsePolicy(policy, requesterWebId, expectedDataOwner))
  const groups = [...new Set(nodes.map((node) => node.group).filter(Boolean))]
  if (groups.length > 1) {
    throw new BadRequestHttpError('access request has multiple access need groups')
  }
  const owners = [...new Set(nodes.map((node) => node.owner).filter(Boolean))]
  if (expectedDataOwner && owners.length > 0 && !owners.includes(expectedDataOwner)) {
    throw new BadRequestHttpError('invalid dataOwner')
  }
  const dataOwner = expectedDataOwner ?? owners[0]
  if (!dataOwner) {
    throw new BadRequestHttpError('invalid dataOwner')
  }

  const groupId = groups[0] ?? `urn:uuid:${crypto.randomUUID()}`
  const childrenOf = (id: string) => nodes.filter((node) => node.inheritsFromNeed === id)
  const toNeed = (node: ParsedPolicy): Record<string, unknown> => ({
    id: node.id,
    type: [INTEROP.AccessNeed],
    registeredShapeTree: node.registeredShapeTree,
    required: node.required ? INTEROP.AccessRequired : INTEROP.AccessOptional,
    accessMode: node.accessMode,
    ...(node.hasDataInstance ? { hasDataInstance: node.hasDataInstance } : {}),
    ...(node.hasDataRegistration ? { hasDataRegistration: node.hasDataRegistration } : {}),
    ...(childrenOf(node.id).length ? { hasInheritingNeed: childrenOf(node.id).map(toNeed) } : {}),
  })
  const group: NeedBasedAccessRequestGroup = {
    id: groupId,
    type: [INTEROP.AccessNeedGroup],
    hasAccessNeed: nodes.filter((node) => !node.inheritsFromNeed).map(toNeed),
  }
  return {
    type: [INTEROP.NeedBasedAccessRequest],
    grantee: nodes[0].assignee,
    grantedBy: nodes[0].assigner,
    dataOwner,
    hasAccessNeedGroup: group,
  }
}

export interface AcceptNeedBasedAccessRequestOptions {
  /** LWS requires a `Location` header on a successful request POST. */
  location?: boolean
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
  expectedDataOwner?: string,
  options: AcceptNeedBasedAccessRequestOptions = {}
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
  if (!requestRegistry) {
    throw new Error('access-request registry not found in registry set')
  }
  const requestId = await sai.mintIdentifier(requestRegistry.id)
  const activityRegistry = sai.registrySet.hasActivityRegistry
  if (!activityRegistry) {
    throw new Error('activity registry not found in registry set')
  }
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
  if (!options.location) {
    return new ResponseDescription(202)
  }
  const metadata = new RepresentationMetadata()
  metadata.set(SOLID_HTTP.terms.location, requestId)
  return new ResponseDescription(202, metadata)
}
