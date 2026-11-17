import type { GrantData, OdrlPolicy } from '@janeirodigital/interop-data-model'
import { Grant } from '@janeirodigital/interop-data-model'
import { LWS, jsonld } from '@janeirodigital/interop-utils'
import type { Quad } from '@rdfjs/types'
import { DataFactory, Store } from 'n3'

import type {
  AccessClaimValidationInput,
  AccessClaimValidator,
} from './DelegatedAccessClaimValidator.js'
import { grantCoversClaim } from './grant-policy.js'
import type { SaiAuthorizationManager } from './SaiAuthorizationManager.js'

const { namedNode } = DataFactory

/**
 * Storage-AS claim check: the final ID-JAG claim must stay within a grant the
 * data owner issued for the requested storage. This is the exchange-time
 * counterpart of `SaiPermissionsEngine`'s registry path; it reuses the same
 * `SaiAuthorizationManager.getAuthorizationData` query instead of introducing
 * another grant lookup.
 *
 * Unlike the UAS validator, the owner does not validate a delegation edge. It
 * only closes the claim over its own source grant: a claim narrowed at any
 * upstream hop is valid as long as every policy is covered by the owner grant.
 */
export class OwnerAccessClaimValidator implements AccessClaimValidator {
  public constructor(private readonly manager: SaiAuthorizationManager) {}

  public async validate(input: AccessClaimValidationInput): Promise<string | undefined> {
    let data: Awaited<ReturnType<SaiAuthorizationManager['getAuthorizationData']>>
    try {
      data = await this.manager.getAuthorizationData(input.storage)
    } catch (error: unknown) {
      throw new Error(
        `could not read owner grants for ${input.storage}: ${(error as Error).message}`,
        {
          cause: error,
        }
      )
    }
    if (!data) throw new Error(`no owner grants for ${input.storage}`)

    const quads: Quad[] = Array.isArray(data) ? data : [...data]
    const store = new Store(quads)
    const grantIris = [
      ...new Set(store.getSubjects(namedNode(LWS.access), null, null).map((term) => term.value)),
    ]
    const doc = await jsonld.fromRDF(quads)
    const grants: GrantData[] = []
    for (const iri of grantIris) {
      try {
        grants.push(await Grant.fromJsonLd(doc, iri))
      } catch {
        // an unframable graph is not a usable grant; keep evaluating the rest
      }
    }

    const owners = new Set<string>()
    for (const raw of input.access) {
      const policy = raw as OdrlPolicy
      const covering = grants.filter((grant) =>
        grantCoversClaim(grant, policy, { assignees: [input.subject, input.client] })
      )
      if (covering.length === 0) {
        throw new Error('no owner grant covers the access claim')
      }
      for (const grant of covering) owners.add(grant.grantedBy)
    }
    if (owners.size !== 1) {
      throw new Error('the access claim is covered by grants from more than one assigner')
    }
    return [...owners][0]
  }
}
