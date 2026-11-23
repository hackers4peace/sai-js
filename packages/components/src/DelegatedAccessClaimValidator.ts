import {
  getAccessGrant,
  getAccessGrantsForGrantee,
  getRegistryGrants,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { grantGrantee } from '@janeirodigital/interop-data-model'
import type { GrantData, OdrlPolicy } from '@janeirodigital/interop-data-model'
import { INTEROP, ODRL_ID_JAG_CONTEXT } from '@janeirodigital/interop-utils'

import type { VerifiedAccessClaim } from './access-claim.js'
import { verifyAccessClaim } from './access-claim.js'
import { buildSessionManager } from './builders/sessionManager.js'
import { grantCoversClaim } from './grant-policy.js'

/** Input of one independent UAS validation of an incoming delegated claim. */
export interface AccessClaimValidationInput {
  /** Legacy visible assigner; new ID-JAG claims omit it and the grant supplies it. */
  assigner?: string
  /** Hidden delegatee subject of the incoming ID-JAG (Bob). */
  subject: string
  /** Client of the incoming ID-JAG (Bob's UAS/client). */
  client: string
  /** Compact ODRL policies from the incoming ID-JAG. */
  access: Array<unknown>
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
  /**
   * Whether the ID-JAG is issued for the storage itself (its `audience` is a
   * storage origin) rather than for another authorization server (a delegation
   * hop). Defaults to `true` for direct callers.
   *
   * A storage ID-JAG is exchanged for a storage access token that serves every
   * read in the storage, so its claim must not be narrowed to a single asset. A
   * delegation-hop claim has to stay within one edge the receiving UAS can back
   * with its own grant.
   */
  forStorage?: boolean
}

/** Narrower grant scopes win when the user has several grants for one storage. */
const SCOPE_RANK: Record<string, number> = {
  [INTEROP.SelectedFromRegistry]: 3,
  [INTEROP.Inherited]: 2,
  [INTEROP.AllFromRegistry]: 1,
  [INTEROP.AllFromAgent]: 0,
}

function grantEdgeRank(batch: Array<GrantData>): number {
  return Math.max(...batch.map((grant) => SCOPE_RANK[grant.scopeOfGrant] ?? -1))
}

/**
 * Whether an edge grants access at registration level. A
 * `SelectedFromRegistry` grant covers one asset, not the registration that
 * holds it, so it cannot back the storage-scoped read of a registration.
 */
function isRegistrationLevelEdge(batch: GrantData[]): boolean {
  return batch.some((grant) => grant.scopeOfGrant !== INTEROP.SelectedFromRegistry)
}

/**
 * One ID-JAG carries one delegation edge (one assigner), so pick the most
 * specific grant edge the user has for the storage. All grants of that edge are
 * kept, in a deterministic order, so the claim is stable.
 *
 * A storage-audience ID-JAG (the final hop) yields a token that serves every
 * read in the storage, so an asset-only edge from one assigner must not shadow
 * a registration-level edge from another: the token would cover only that
 * asset, and a storage-scoped read outside it (a registration's `contains`, for
 * example) would be denied. Asset-only edges therefore win only when they are
 * all the user has. A delegation-hop ID-JAG (`forStorage === false`) keeps the
 * narrowest edge, which the receiving UAS can back with its own grant (the
 * Bob → YoYo → ACME chain).
 */
function mostSpecificGrantEdge(grants: Array<GrantData>, forStorage: boolean): Array<GrantData> {
  const byAssigner = new Map<string, Array<GrantData>>()
  for (const grant of grants) {
    const bucket = byAssigner.get(grant.grantedBy)
    if (bucket) {
      bucket.push(grant)
    } else {
      byAssigner.set(grant.grantedBy, [grant])
    }
  }
  const edges = [...byAssigner.entries()]
  const registrationLevel = forStorage
    ? edges.filter(([, batch]) => isRegistrationLevelEdge(batch))
    : []
  const candidates = registrationLevel.length > 0 ? registrationLevel : edges
  const [best] = candidates.toSorted(([assignerA, batchA], [assignerB, batchB]) => {
    const byRank = grantEdgeRank(batchB) - grantEdgeRank(batchA)
    if (byRank !== 0) {
      return byRank
    }
    const bySize = batchB.length - batchA.length
    if (bySize !== 0) {
      return bySize
    }
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

function usableGrants(grants: Array<GrantData>): Array<GrantData> {
  const ids = new Set(grants.map((grant) => grant.id))
  return grants.filter((grant) => !grant.inheritsFromGrant || ids.has(grant.inheritsFromGrant))
}

/**
 * Intersect the assigners of the grants matching every policy of the claim.
 * The claim may omit the assigner; the candidate grant supplies it.
 */
function matchingAssigners(
  access: Array<unknown>,
  grants: Array<GrantData>,
  assignees: Iterable<string>
): Set<string> {
  const usable = usableGrants(grants)
  let matches: Set<string> | undefined
  for (const raw of access) {
    const policy = raw as OdrlPolicy
    const assigners = new Set(
      usable
        .filter((grant) => grantCoversClaim(grant, policy, { assignees }))
        .map((grant) => grant.grantedBy)
    )
    if (assigners.size === 0) {
      return new Set()
    }
    matches = matches
      ? new Set([...matches].filter((assigner) => assigners.has(assigner)))
      : assigners
    if (matches.size === 0) {
      return matches
    }
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
 * policy must be covered by a grant in the assigner's own registry (semantic
 * fields, scope/target/action subset; ids excluded). Full chain validity is
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
    // A storage-audience ID-JAG prefers registration-level edges (asset-only
    // edges only as a fallback); a delegation hop keeps the narrowest edge the
    // receiving UAS can back.
    const received = relevant.filter((grant) => grantGrantee(grant) === input.subject)
    const selected =
      appSpecific.length > 0
        ? appSpecific
        : mostSpecificGrantEdge(received, input.forStorage !== false)
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
      if (
        !matchingAssigners(input.access, grants, [input.subject, input.client]).has(input.assigner)
      ) {
        throw new Error(`no existing grant issued by ${input.assigner} covers the delegated claim`)
      }
      return input.assigner
    }

    // New claims omit the assigner. Find the grant edge in the subject's plane
    // first, then independently confirm that edge in the assigner's registry.
    // A broad source grant may also cover a narrower delegated claim; prefer
    // the most specific matching edge (Selected > Inherited > AllFromRegistry
    // > AllFromAgent), as the derivation does.
    const visible = await this.visibleGrants(input.subject, input.client, input.storage)
    const assignees = [input.subject, input.client]
    const candidates = [...new Set(visible.map((grant) => grant.grantedBy))]
      .map((assigner) => ({
        assigner,
        grants: visible.filter((grant) => grant.grantedBy === assigner),
      }))
      .filter(({ grants }) => matchingAssigners(input.access, grants, assignees).size > 0)
      .toSorted(
        (a, b) =>
          grantEdgeRank(b.grants) - grantEdgeRank(a.grants) || a.assigner.localeCompare(b.assigner)
      )
    if (candidates.length === 0) {
      throw new Error('no existing grant covers the delegated claim')
    }

    for (const { assigner } of candidates) {
      const grants = await this.assignerGrants(assigner)
      if (matchingAssigners(input.access, grants, assignees).has(assigner)) {
        return assigner
      }
    }
    throw new Error('no grant in the assigner registry covers the delegated claim')
  }

  /** Load the grants visible to a subject for one client and storage. */
  private async visibleGrants(
    subject: string,
    client: string,
    storage: string
  ): Promise<Array<GrantData>> {
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
  private async assignerGrants(assigner: string): Promise<Array<GrantData>> {
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
