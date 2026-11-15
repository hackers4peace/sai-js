import type { FinalGrantData, OdrlPolicy } from '@janeirodigital/interop-data-model'
import { INTEROP, LWS } from '@janeirodigital/interop-utils'

/** The data owner encoded in an ODRL policy target. */
export function firstDataOwner(policy: OdrlPolicy): string {
  return policy.permission[0]?.target.owner ?? ''
}

/**
 * Convert one ODRL policy into the flat `FinalGrantData` shape used by the
 * grant registry, delegation endpoint, and delegated-claim validation.
 */
export function grantFromPolicy(
  policy: OdrlPolicy,
  id: string,
  envelopeScope: string
): FinalGrantData {
  const permission = policy.permission[0]
  const target = permission?.target
  const instances = policy.permission
    .map((candidate) => candidate.target)
    .filter((candidate) => candidate.type.includes('http://www.w3.org/ns/odrl/2/Asset'))
    .map((candidate) => candidate.source[0])
    .filter(Boolean)
  const registration = target?.type.includes(INTEROP.DataRegistration)
    ? target.source[0]
    : (target?.partOf?.[0] ?? '')
  return {
    id,
    type: [LWS.AccessGrant],
    access: [policy],
    scopeOfGrant: policy.scopeOfGrant ?? envelopeScope,
    storage: target?.storage ?? '',
    dataOwner: target?.owner ?? '',
    grantedBy: permission?.assigner ?? '',
    registeredShapeTree: policy.registeredShapeTree ?? '',
    hasDataRegistration: registration,
    ...(instances.length ? { hasDataInstance: instances } : {}),
  }
}
