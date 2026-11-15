import {
  getRegistryGrants,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { type OdrlPolicy, grantGrantee } from '@janeirodigital/interop-data-model'

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

/** A UAS-side validator of delegated access claims. */
export interface AccessClaimValidator {
  validate(input: AccessClaimValidationInput): Promise<void>
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
