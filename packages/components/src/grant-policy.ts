import {
  accessModesCover,
  instancesCover,
  scopeCovers,
} from '@janeirodigital/interop-authorization-agent'
import {
  grantAccessModes,
  grantAssigner,
  grantDataOwner,
  grantGrantee,
  grantRegistration,
  grantShapeTree,
  grantStorage,
} from '@janeirodigital/interop-data-model'
import type { FinalGrantData, GrantData, OdrlPolicy } from '@janeirodigital/interop-data-model'
import { CONTEXT, asScopeTerm } from '@janeirodigital/interop-utils'

/** The data owner encoded in an ODRL policy target. */
export function firstDataOwner(policy: OdrlPolicy): string {
  return policy.permission[0]?.target.owner ?? ''
}

/**
 * Convert one ODRL policy into the grant read model used by the grant
 * registry, delegation endpoint, and delegated-claim validation. The read
 * model is the wire shape, so no target facts are copied onto it — the
 * `grant*` helpers read them from the policy tree.
 */
export function grantFromPolicy(
  policy: OdrlPolicy,
  id: string,
  envelopeScope: string
): FinalGrantData {
  return {
    id,
    type: [CONTEXT.AccessGrant],
    access: [policy],
    scopeOfGrant: asScopeTerm(policy.scopeOfGrant) ?? asScopeTerm(envelopeScope) ?? '',
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
  if (grantAssigner(claim) && grantAssigner(claim) !== grantAssigner(grant)) {
    return false
  }
  // Every claim carries its shape tree; only AllFromAgent targets are not
  // registration-scoped. A missing field is malformed, never a wildcard.
  const claimShapeTree = grantShapeTree(claim)
  const grantShapeTreeValue = grantShapeTree(grant)
  if (!grantShapeTreeValue || !claimShapeTree) {
    return false
  }
  const claimRegistration = grantRegistration(claim)
  const grantRegistrationValue = grantRegistration(grant)
  const needsRegistration =
    asScopeTerm(grant.scopeOfGrant) !== CONTEXT.AllFromAgent &&
    asScopeTerm(claim.scopeOfGrant) !== CONTEXT.AllFromAgent
  if (needsRegistration && (!grantRegistrationValue || !claimRegistration)) {
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
    grantDataOwner(grant) === grantDataOwner(claim) &&
    assigneeMatches &&
    grantShapeTreeValue === claimShapeTree &&
    grantRegistrationValue === claimRegistration &&
    grantStorage(grant) === grantStorage(claim) &&
    scopeCovers(grant.scopeOfGrant, claim.scopeOfGrant) &&
    accessModesCover(grantAccessModes(grant), grantAccessModes(claim)) &&
    instancesCover(grant, claim)
  )
}
