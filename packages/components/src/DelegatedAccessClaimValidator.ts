import {
  getAccessGrant,
  getAccessGrantsForGrantee,
  getRegistryGrants,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { type GrantData, type OdrlPolicy, grantGrantee } from '@janeirodigital/interop-data-model'
import { INTEROP, ODRL_ID_JAG_CONTEXT } from '@janeirodigital/interop-utils'

import type { VerifiedAccessClaim } from './access-claim.js'
import { verifyAccessClaim } from './access-claim.js'
import { buildSessionManager } from './builders/sessionManager.js'
import { grantFromPolicy } from './grant-policy.js'
import { grantFieldsEqual } from './temporal/activities/check-equivalence.js'

/** Input of one independent UAS validation of an incoming delegated claim. */
export interface AccessClaimValidationInput {
  /** Legacy visible assigner; new ID-JAG claims omit it and the grant supplies it. */
  assigner?: string
  /** Hidden delegatee subject of the incoming ID-JAG (Bob). */
  subject: string
  /** Client of the incoming ID-JAG (Bob's UAS/client). */
  client: string
  /** Compact ODRL policies from the incoming ID-JAG. */
  access: unknown[]
  /** JSON-LD context of `access`. */
  context: string
  /** Storage bound by the claim. */
  storage: string
}

/** The subject/client/storage an ID-JAG access claim has to cover. */
export interface AccessClaimLookupInput {
  /** The authenticated user (the subject of the credential/ID-JAG). */
  subject: string
  /** The client the claim is issued to. */
  client: string
  /** The storage the claim is for. */
  storage: string
}

/** Narrower grant scopes win when the user has several grants for one storage. */
const SCOPE_RANK: Record<string, number> = {
  [INTEROP.SelectedFromRegistry]: 3,
  [INTEROP.Inherited]: 2,
  [INTEROP.AllFromRegistry]: 1,
  [INTEROP.AllFromAgent]: 0,
}

function grantEdgeRank(batch: GrantData[]): number {
  return Math.max(...batch.map((grant) => SCOPE_RANK[grant.scopeOfGrant] ?? -1))
}

/**
 * One ID-JAG carries one delegation edge (one assigner), so pick the most
 * specific grant edge the user has for the storage. All grants of that edge are
 * kept, in a deterministic order, so the claim is stable.
 */
function mostSpecificGrantEdge(grants: GrantData[]): GrantData[] {
  const byAssigner = new Map<string, GrantData[]>()
  for (const grant of grants) {
    const bucket = byAssigner.get(grant.grantedBy)
    if (bucket) bucket.push(grant)
    else byAssigner.set(grant.grantedBy, [grant])
  }
  const [best] = [...byAssigner.entries()].toSorted(([assignerA, batchA], [assignerB, batchB]) => {
    const byRank = grantEdgeRank(batchB) - grantEdgeRank(batchA)
    if (byRank !== 0) return byRank
    const bySize = batchB.length - batchA.length
    if (bySize !== 0) return bySize
    return assignerA.localeCompare(assignerB)
  })
  return best ? best[1] : []
}

/** A UAS-side source and validator of delegated access claims. */
export interface AccessClaimValidator {
  /**
   * Validates the incoming claim against the assigner's grant registry and
   * returns the assigner of the matched grant. New ID-JAGs have no assigner in
   * the claim, so this is where the visible actor is recovered.
   */
  validate(input: AccessClaimValidationInput): Promise<string | undefined>
  /**
   * Finds the grants in the subject's plane for one client and storage and
   * turns them into the compact ODRL claim an ID-JAG carries. Optional so
   * package tests can inject a validator-only stub.
   */
  find?(input: AccessClaimLookupInput): Promise<VerifiedAccessClaim | undefined>
}

/** Fill a missing permission assigner so a claim can be compared to a grant. */
function withClaimAssigner(policy: OdrlPolicy, assigner: string): OdrlPolicy {
  return {
    ...policy,
    permission: (policy.permission ?? []).map((permission) => ({
      ...permission,
      assigner: permission.assigner || assigner,
    })),
  }
}

function usableGrants(grants: GrantData[]): GrantData[] {
  const ids = new Set(grants.map((grant) => grant.id))
  return grants.filter((grant) => !grant.inheritsFromGrant || ids.has(grant.inheritsFromGrant))
}

/**
 * Intersect the assigners of the grants matching every policy of the claim.
 * The claim may omit the assigner; the candidate grant supplies it.
 */
function matchingAssigners(access: unknown[], grants: GrantData[]): Set<string> {
  const usable = usableGrants(grants)
  let matches: Set<string> | undefined
  for (const raw of access) {
    const policy = raw as OdrlPolicy
    const assigners = new Set(
      usable
        .filter((grant) =>
          grantFieldsEqual(
            grant,
            grantFromPolicy(withClaimAssigner(policy, grant.grantedBy), 'urn:claim', '')
          )
        )
        .map((grant) => grant.grantedBy)
    )
    if (assigners.size === 0) return new Set()
    matches = matches
      ? new Set([...matches].filter((assigner) => assigners.has(assigner)))
      : assigners
    if (matches.size === 0) return matches
  }
  return matches ?? new Set()
}

/**
 * C4 item 4: each intermediate UAS independently checks that an incoming
 * delegated claim is backed by a grant the UAS itself issued and stores in its
 * own grant registry.
 *
 * New ID-JAG claims omit the assigner and are assigned to their subject. The
 * grant edge is recovered from the subject's visible grants, then every claim
 * policy must exactly match a grant in the assigner's own registry (semantic
 * fields and ODRL permissions, ids excluded). Full chain validity is
 * intentionally not used here: the upstream source grant belongs to the data
 * owner's registry and is not expected to be present in the assigner's local
 * registry.
 */
export class DelegatedAccessClaimValidator implements AccessClaimValidator {
  /**
   * Derives an access claim from the grants the subject's UAS can see (its own
   * grant registry plus reciprocal mirrors). Only one storage is selected; an
   * app-specific grant (the user -> the client) wins over a delegated grant the
   * user received for that storage.
   */
  public async find(input: AccessClaimLookupInput): Promise<VerifiedAccessClaim | undefined> {
    const relevant = await this.visibleGrants(input.subject, input.client, input.storage)
    const appSpecific = relevant.filter(
      (grant) => grant.grantedBy === input.subject && grantGrantee(grant) === input.client
    )
    // A user can hold several grants for one storage from several assigners
    // (the owner's grant plus an intermediate delegation). Pick one edge: the
    // app-specific grant if there is one, otherwise the narrowest delegation.
    const received = relevant.filter((grant) => grantGrantee(grant) === input.subject)
    const selected = appSpecific.length > 0 ? appSpecific : mostSpecificGrantEdge(received)
    if (selected.length === 0) return undefined

    // The claim must preserve the parent/child relation between selected
    // grants: the policy engine evaluates inheritance from the claim alone.
    // Link the child policy to the parent policy's local id (not the hidden
    // grant IRI); the impersonation rewrite remaps those ids to fresh opaque
    // ids.
    const byId = new Map(selected.map((grant) => [grant.id, grant]))
    const policies = selected.flatMap((grant) => {
      const parent = grant.inheritsFromGrant ? byId.get(grant.inheritsFromGrant) : undefined
      const parentPolicy = parent?.access[0]
      const parentRef = parentPolicy?.uid ?? parentPolicy?.id
      return grant.access.map((policy) => ({
        ...policy,
        ...(parentRef ? { inheritsFromGrant: parentRef } : {}),
      }))
    })

    return verifyAccessClaim(policies, ODRL_ID_JAG_CONTEXT, input.storage)
  }

  public async validate(input: AccessClaimValidationInput): Promise<string | undefined> {
    // A legacy claim still names its assigner: check only that user's registry.
    if (input.assigner) {
      const grants = await this.assignerGrants(input.assigner)
      if (!matchingAssigners(input.access, grants).has(input.assigner)) {
        throw new Error(`no existing grant issued by ${input.assigner} covers the delegated claim`)
      }
      return input.assigner
    }

    // New claims omit the assigner. Find the grant edge in the subject's plane
    // first, then independently confirm that edge in the assigner's registry.
    const visible = await this.visibleGrants(input.subject, input.client, input.storage)
    const candidates = matchingAssigners(input.access, visible)
    if (candidates.size === 0) {
      throw new Error('no existing grant covers the delegated claim')
    }

    const backed: string[] = []
    for (const assigner of candidates) {
      const grants = await this.assignerGrants(assigner)
      if (matchingAssigners(input.access, grants).has(assigner)) backed.push(assigner)
    }
    if (backed.length === 0) {
      throw new Error('no grant in the assigner registry covers the delegated claim')
    }
    if (backed.length > 1) {
      throw new Error('the delegated claim is backed by more than one assigner')
    }
    return backed[0]
  }

  /** Load the grants visible to a subject for one client and storage. */
  private async visibleGrants(
    subject: string,
    client: string,
    storage: string
  ): Promise<GrantData[]> {
    let session: Awaited<ReturnType<ReturnType<typeof buildSessionManager>['getSession']>>
    try {
      session = await buildSessionManager().getSession(subject)
    } catch (error: unknown) {
      throw new Error(
        `no local grant registry for the claim subject ${subject}: ${(error as Error).message}`,
        { cause: error }
      )
    }

    const transport = localSparqlTransport(session.sparqlEndpoint)
    // The mirrored recipient side is not a grant-registry member, so query the
    // whole registry-pod dataset by grantee (the shared dev/test endpoint makes
    // peer grants visible; the mirror backfills them in a split deployment).
    const [subjectGrants, clientGrants] = await Promise.all([
      getAccessGrantsForGrantee(transport, subject),
      getAccessGrantsForGrantee(transport, client),
    ])
    const ids = [...new Set([...subjectGrants, ...clientGrants].map((entry) => entry.grant))]
    const grants = (
      await Promise.all(
        ids.map(async (id) => {
          try {
            return await getAccessGrant(transport, id)
          } catch {
            return undefined
          }
        })
      )
    ).filter((grant): grant is GrantData => grant !== undefined)

    return grants.filter((grant) => grant.storage === storage)
  }

  /** Load all grants in one assigner's own grant registry. */
  private async assignerGrants(assigner: string): Promise<GrantData[]> {
    let session: Awaited<ReturnType<ReturnType<typeof buildSessionManager>['getSession']>>
    try {
      session = await buildSessionManager().getSession(assigner)
    } catch (error: unknown) {
      throw new Error(
        `no local grant registry for the claim assigner ${assigner}: ${(error as Error).message}`,
        { cause: error }
      )
    }

    const transport = localSparqlTransport(session.sparqlEndpoint)
    return getRegistryGrants(transport, session.registrySet.hasGrantRegistry.id)
  }
}
