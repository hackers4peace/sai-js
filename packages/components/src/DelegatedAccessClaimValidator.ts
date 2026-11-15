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
  /** Visible requester / claim assigner (YoYo). */
  assigner: string
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
  validate(input: AccessClaimValidationInput): Promise<void>
  /**
   * Finds the grants in the subject's plane for one client and storage and
   * turns them into the compact ODRL claim an ID-JAG carries. Optional so
   * package tests can inject a validator-only stub.
   */
  find?(input: AccessClaimLookupInput): Promise<VerifiedAccessClaim | undefined>
}

/**
 * C4 item 4: each intermediate UAS independently checks that an incoming
 * delegated claim is backed by a grant the UAS itself issued and stores in its
 * own grant registry.
 *
 * This mirrors the delegation-request authority check at the assigner:
 * the claim's assigner must be the local user, and every claim policy must
 * exactly match a grant in that user's registry (semantic fields and ODRL
 * permissions, ids excluded). Full chain validity is intentionally not used
 * here: the upstream source grant belongs to the data owner's registry and is
 * not expected to be present in the assigner's local registry.
 */
export class DelegatedAccessClaimValidator implements AccessClaimValidator {
  /**
   * Derives an access claim from the grants the subject's UAS can see (its own
   * grant registry plus reciprocal mirrors). Only one storage is selected; an
   * app-specific grant (the user -> the client) wins over a delegated grant the
   * user received for that storage.
   */
  public async find(input: AccessClaimLookupInput): Promise<VerifiedAccessClaim | undefined> {
    let session: Awaited<ReturnType<ReturnType<typeof buildSessionManager>['getSession']>>
    try {
      session = await buildSessionManager().getSession(input.subject)
    } catch (error: unknown) {
      throw new Error(
        `no local grant registry for the claim subject ${input.subject}: ${(error as Error).message}`,
        { cause: error }
      )
    }

    const transport = localSparqlTransport(session.sparqlEndpoint)
    // The mirrored recipient side is not a grant-registry member, so query the
    // whole registry-pod dataset by grantee (the shared dev/test endpoint makes
    // peer grants visible; the mirror backfills them in a split deployment).
    const [subjectGrants, clientGrants] = await Promise.all([
      getAccessGrantsForGrantee(transport, input.subject),
      getAccessGrantsForGrantee(transport, input.client),
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

    const relevant = grants.filter((grant) => grant.storage === input.storage)
    const appSpecific = relevant.filter(
      (grant) => grant.grantedBy === input.subject && grantGrantee(grant) === input.client
    )
    // A user can hold several grants for one storage from several assigners
    // (the owner's grant plus an intermediate delegation). Pick one edge: the
    // app-specific grant if there is one, otherwise the narrowest delegation.
    const received = relevant.filter((grant) => grantGrantee(grant) === input.subject)
    const selected = appSpecific.length > 0 ? appSpecific : mostSpecificGrantEdge(received)
    if (selected.length === 0) return undefined

    return verifyAccessClaim(
      selected.flatMap((grant) => grant.access),
      ODRL_ID_JAG_CONTEXT,
      input.storage
    )
  }

  public async validate(input: AccessClaimValidationInput): Promise<void> {
    let session: Awaited<ReturnType<ReturnType<typeof buildSessionManager>['getSession']>>
    try {
      session = await buildSessionManager().getSession(input.assigner)
    } catch (error: unknown) {
      throw new Error(
        `no local grant registry for the claim assigner ${input.assigner}: ${(error as Error).message}`,
        { cause: error }
      )
    }

    const transport = localSparqlTransport(session.sparqlEndpoint)
    const grants = await getRegistryGrants(transport, session.registrySet.hasGrantRegistry.id)
    const ids = new Set(grants.map((grant) => grant.id))

    for (const [index, raw] of input.access.entries()) {
      const claim = grantFromPolicy(raw as OdrlPolicy, `urn:claim:${index}`, '')
      if (claim.grantedBy !== input.assigner) {
        throw new Error('the delegated claim is not assigned by this UAS user')
      }
      const grantee = grantGrantee(claim)
      if (grantee !== input.subject && grantee !== input.client) {
        throw new Error('the delegated claim is not assigned to the incoming subject/client')
      }
      if (claim.storage !== input.storage) {
        throw new Error('the delegated claim target is not the requested storage')
      }

      const backed = grants.some(
        (grant) =>
          grantFieldsEqual(grant, claim) &&
          (!grant.inheritsFromGrant || ids.has(grant.inheritsFromGrant))
      )
      if (!backed) {
        throw new Error(
          `no existing grant issued by ${input.assigner} to ${grantee} covers the delegated claim`
        )
      }
    }
  }
}
