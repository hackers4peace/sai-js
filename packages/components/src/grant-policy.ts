import {
  accessModesCover,
  instancesCover,
  scopeCovers,
} from '@janeirodigital/interop-authorization-agent'
import {
  type FinalGrantData,
  type GrantData,
  type OdrlPolicy,
  grantAccessModes,
  grantGrantee,
  registrationOfTarget,
  shapeTreeOfTarget,
} from '@janeirodigital/interop-data-model'
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
  const registration = registrationOfTarget(target)
  return {
    id,
    type: [LWS.AccessGrant],
    access: [policy],
    scopeOfGrant: policy.scopeOfGrant ?? envelopeScope,
    storage: target?.storage ?? '',
    dataOwner: target?.owner ?? '',
    grantedBy: permission?.assigner ?? '',
    registeredShapeTree: shapeTreeOfTarget(target),
    hasDataRegistration: registration,
    ...(instances.length ? { hasDataInstance: instances } : {}),
  }
}

/**
 * Whether one grant covers a (possibly narrower) access-claim policy.
 *
 * Claim validation is coverage, not equality: a delegation step may narrow
 * scope, actions, or selected instances. The grant is the authority; every
 * claim field has to stay within it. The claim's assigner is optional (ID-JAGs
 * omit it), while the assignee is the visible subject at that hop.
 */
export interface GrantClaimCoverageOptions {
  /**
   * Assignees accepted at this hop. The caller passes the token subject and
   * client: a claim bound to the subject may be covered by an app-specific
   * grant issued to that client.
   */
  assignees?: Iterable<string>
}

export function grantCoversClaim(
  grant: GrantData,
  policy: OdrlPolicy,
  options: GrantClaimCoverageOptions = {}
): boolean {
  const claim = grantFromPolicy(policy, 'urn:sai:access-claim', policy.scopeOfGrant ?? '')
  if (claim.grantedBy && claim.grantedBy !== grant.grantedBy) return false
  // Every claim carries its shape tree; only AllFromAgent targets are not
  // registration-scoped. A missing field is malformed, never a wildcard.
  if (!grant.registeredShapeTree || !claim.registeredShapeTree) return false
  const needsRegistration =
    grant.scopeOfGrant !== INTEROP.AllFromAgent && claim.scopeOfGrant !== INTEROP.AllFromAgent
  if (needsRegistration && (!grant.hasDataRegistration || !claim.hasDataRegistration)) {
    return false
  }
  const assignees = options.assignees ? new Set(options.assignees) : undefined
  const claimGrantee = grantGrantee(claim)
  const grantGranteeValue = grantGrantee(grant)
  const assigneeMatches =
    assignees !== undefined
      ? !!claimGrantee &&
        assignees.has(claimGrantee) &&
        !!grantGranteeValue &&
        assignees.has(grantGranteeValue)
      : grantGranteeValue === claimGrantee
  return (
    grant.dataOwner === claim.dataOwner &&
    assigneeMatches &&
    grant.registeredShapeTree === claim.registeredShapeTree &&
    grant.hasDataRegistration === claim.hasDataRegistration &&
    grant.storage === claim.storage &&
    scopeCovers(grant.scopeOfGrant, claim.scopeOfGrant) &&
    accessModesCover(grantAccessModes(grant), grantAccessModes(claim)) &&
    instancesCover(grant, claim)
  )
}
