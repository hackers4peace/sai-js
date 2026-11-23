import { INTEROP, LWS } from '@janeirodigital/interop-utils'
import { BadRequestHttpError } from '@solid/community-server'

import { accessModes, values } from './need-based-access-request.js'
import type { NeedBasedAccessRequestInput } from './need-based-access-request.js'

/**
 * Plain LWS ODRL access request (issue w3c/lws-protocol#303 shape):
 * `AccessRequest` + `Request` policies, `permission[]`, and
 * `Asset`/`AssetCollection` targets. It carries none of the SAI access-need
 * extensions (`accessNeedGroup`, `inheritsFromNeed`, `registeredShapeTree`).
 */
export interface PlainLwsTarget {
  type: Array<string>
  source: Array<string>
  partOf?: Array<string>
}

export interface PlainLwsResolvedTarget {
  registeredShapeTree: string
  hasDataRegistration?: string
  hasDataInstance?: Array<string>
}

/** Resolves one LWS target to SAI need scope using the owner's registry view. */
export type PlainLwsTargetResolver = (
  target: PlainLwsTarget
) => Promise<Array<PlainLwsResolvedTarget>>

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function targetOf(permission: Record<string, unknown>): Record<string, unknown> {
  const target = record(permission.target)
  if (!target) {
    throw new BadRequestHttpError('plain LWS access policy has no target')
  }
  return target
}

function permissionsOf(policy: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = policy.permission
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  if (list.length === 0) {
    throw new BadRequestHttpError('plain LWS access policy has no permission')
  }
  return list.map((permission) => {
    const parsed = record(permission)
    if (!parsed) {
      throw new BadRequestHttpError('invalid plain LWS permission')
    }
    return parsed
  })
}

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

/**
 * Whether a document is the plain LWS ODRL request (no SAI
 * `NeedBasedAccessRequest` type, not a delegation/revocation request).
 */
export function isPlainLwsAccessRequest(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const message = value as Record<string, unknown>
  const types = values(message.type)
  const accessRequest = types.some((type) => type === 'AccessRequest' || type === LWS.AccessRequest)
  const needBased = types.some(
    (type) => type === 'NeedBasedAccessRequest' || type === INTEROP.NeedBasedAccessRequest
  )
  const other = types.some(
    (type) => type.endsWith('DelegationRequest') || type.endsWith('AccessRevocationRequest')
  )
  return accessRequest && !needBased && !other && Array.isArray(message.access)
}

function plainTarget(permission: Record<string, unknown>): PlainLwsTarget {
  const target = targetOf(permission)
  const sources = values(target.source)
  if (sources.length === 0) {
    throw new BadRequestHttpError('plain LWS access target has no source')
  }
  const partOf = values(target.partOf)
  return {
    type: values(target.type),
    source: sources,
    ...(partOf.length ? { partOf } : {}),
  }
}

interface Candidate {
  registeredShapeTree: string
  hasDataRegistration?: string
  hasDataInstance: Set<string>
  accessMode: Array<string>
}

function candidateKey(candidate: Candidate): string {
  return [
    candidate.registeredShapeTree,
    candidate.hasDataRegistration ?? '',
    [...candidate.accessMode].toSorted().join(','),
  ].join('\u0000')
}

/**
 * Map a plain LWS ODRL request to the embedded need-based request. The owner
 * side resolves each target to a shape tree/registration/instance set (plain
 * LWS does not itself know shape trees); permissions with the same resolved
 * scope and action set become one access need.
 */
export async function plainLwsAccessRequestToNeedBased(
  message: Record<string, unknown>,
  requesterWebId: string,
  dataOwner: string,
  resolveTarget: PlainLwsTargetResolver
): Promise<NeedBasedAccessRequestInput> {
  const rawPolicies = Array.isArray(message.access) ? message.access : []
  if (rawPolicies.length === 0) {
    throw new BadRequestHttpError('access request has no access policies')
  }

  const candidates = new Map<string, Candidate>()
  for (const rawPolicy of rawPolicies) {
    const policy = record(rawPolicy)
    if (!policy) {
      throw new BadRequestHttpError('invalid access policy')
    }
    const permissions = permissionsOf(policy)
    rejectConstraints(policy, permissions)
    for (const permission of permissions) {
      if (permission.assignee !== requesterWebId) {
        throw new BadRequestHttpError('invalid grantedBy/grantee')
      }
      // a plain LWS request is a self-request through the requester's UAS;
      // `assigner` is optional in the LWS ODRL profile
      if (permission.assigner !== undefined && permission.assigner !== requesterWebId) {
        throw new BadRequestHttpError('invalid requester')
      }
      const modes = accessModes(permission.action)
      const target = plainTarget(permission)
      const resolved = await resolveTarget(target)
      if (resolved.length === 0) {
        throw new BadRequestHttpError('access target does not resolve to a data registration')
      }
      for (const resolution of resolved) {
        const candidate: Candidate = {
          registeredShapeTree: resolution.registeredShapeTree,
          ...(resolution.hasDataRegistration
            ? { hasDataRegistration: resolution.hasDataRegistration }
            : {}),
          hasDataInstance: new Set(resolution.hasDataInstance ?? []),
          accessMode: modes,
        }
        const key = candidateKey(candidate)
        const existing = candidates.get(key)
        if (existing) {
          for (const instance of candidate.hasDataInstance) {
            existing.hasDataInstance.add(instance)
          }
        } else {
          candidates.set(key, candidate)
        }
      }
    }
  }

  if (candidates.size === 0) {
    throw new BadRequestHttpError('access request has no usable access targets')
  }

  const needs = [...candidates.values()].map((candidate) => ({
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: [INTEROP.AccessNeed],
    registeredShapeTree: candidate.registeredShapeTree,
    required: INTEROP.AccessRequired,
    accessMode: candidate.accessMode,
    ...(candidate.hasDataInstance.size ? { hasDataInstance: [...candidate.hasDataInstance] } : {}),
    ...(candidate.hasDataRegistration
      ? { hasDataRegistration: candidate.hasDataRegistration }
      : {}),
  }))

  return {
    type: [INTEROP.NeedBasedAccessRequest],
    grantee: requesterWebId,
    grantedBy: requesterWebId,
    dataOwner,
    hasAccessNeedGroup: {
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: [INTEROP.AccessNeedGroup],
      hasAccessNeed: needs,
    },
  }
}
