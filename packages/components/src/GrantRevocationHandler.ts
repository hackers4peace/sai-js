import {
  type RevokedGrant,
  type RevocationErrorCode,
  RevocationError,
  isRevocationError,
  localSparqlTransport,
  revokeGrantsClosure,
} from '@janeirodigital/interop-authorization-agent'
import type {
  AccessRevocationMessage,
  GrantId,
  SocialAgentId,
} from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import {
  APPLICATION_JSON,
  BadRequestHttpError,
  BasicRepresentation,
  OkResponseDescription,
  ResponseDescription,
} from '@solid/community-server'
import type { CredentialsExtractor, OperationHttpHandlerInput } from '@solid/community-server'

import type { PodEndpointStore } from './PodEndpointStore.js'
import { Temporal } from './temporal/client.js'
import { revokeGrants } from './temporal/workflows/grants.js'

type Credentials = Awaited<ReturnType<CredentialsExtractor['handleSafe']>>

/**
 * HTTP status per typed refusal (C4 / D11). `unknown` and `wrong-data-owner`
 * are malformed requests (the listed grant does not resolve to a registry /
 * belongs to a different owner's registry); `mixed-owner` is the B2
 * all-or-nothing refusal; `unauthorized` is an authority failure;
 * `not-delegable` is a chain-state conflict (reserved — the issuance path
 * produces it).
 */
const REVOCATION_HTTP_STATUS: Record<RevocationErrorCode, number> = {
  unknown: 400,
  'wrong-data-owner': 400,
  unauthorized: 403,
  'not-delegable': 409,
  'mixed-owner': 400,
}

/** Machine-readable error body: `{ code, grants, message }`. */
export function revocationFailureDescription(
  error: { code: RevocationErrorCode; grants: string[]; message: string },
  operation: OperationHttpHandlerInput['operation']
): ResponseDescription {
  const doc = JSON.stringify({
    code: error.code,
    grants: error.grants,
    message: error.message,
  })
  const representation = new BasicRepresentation(doc, operation.target, APPLICATION_JSON)
  return new ResponseDescription(
    REVOCATION_HTTP_STATUS[error.code],
    representation.metadata,
    representation.data
  )
}

/**
 * Revocation of delegated grants at the data-owner boundary.
 *
 * Mirrors issuance on the same delegation endpoint (dispatched on message
 * `type`). All-or-nothing: the whole request is validated (every listed grant
 * is SPARQL-loaded and authority-checked) before anything is deleted. The C1
 * closure (listed grants + every grant invalidated by their removal + the
 * same-request inheriting children) is computed over the **owner's** grant
 * registry — the endpoint is resolved from the grant IRI, so an org admin's
 * request reads/deletes in the org's registry, not their personal one (B1).
 * Deletion runs through Temporal with the data owner's own session (owner
 * rights — no ACR/403 problem), and clears the owner's registration
 * projection for the removed grants. Revoking an already-removed grant is a
 * no-op: the response echoes the request's grant IRIs.
 *
 * Authority (C4): the requester's client is the UAS of the grant's
 * `grantedBy` (grantor branch) or the requester is the data owner. Grantee
 * self-revocation is deliberately not offered (D17 — grants are projections of
 * authorizations; the grantee's future options are shadowing or a need-based
 * revocation request). Refusals are typed (`RevocationError`) and mapped to a
 * status + JSON body — no message substring matching.
 */
export class GrantRevocationHandler {
  public constructor(private readonly endpointStore: PodEndpointStore) {}

  public async revoke(
    message: AccessRevocationMessage,
    credentials: Credentials,
    operation: OperationHttpHandlerInput['operation']
  ): Promise<ResponseDescription> {
    const { grants } = message
    try {
      await this.revokeGrants(grants, credentials.agent?.webId)
    } catch (err) {
      if (isRevocationError(err)) return revocationFailureDescription(err, operation)
      throw err
    }

    // response = removed list; under all-or-nothing that equals the request's
    // `grants` (already-removed entries are echoed too — idempotent no-op)
    const doc = JSON.stringify(grants)
    const representation = new BasicRepresentation(doc, operation.target, APPLICATION_JSON)
    return new OkResponseDescription(representation.metadata, representation.data)
  }

  /**
   * The delegation endpoint's core (the projection transport): resolve the
   * owner's endpoint from the grant IRIs, compute the C1 closure with the
   * owner-bound core, then delete the closure through Temporal with the owner's
   * session. There is no grant-level RPC (D18): the only in-app callers are
   * `requestRevocations` inside `reconcileGrantsForGrantee`. Idempotent:
   * already-removed grants are skipped and echoed by the caller.
   *
   * The B2 mixed-owner check runs on the **requested** set: every requested
   * grant must resolve to a known registry pod, and all to the same one. A
   * request that spans owners fails as a whole before anything is loaded or
   * deleted; an already-removed grant still resolves by pod prefix (so the
   * idempotent echo keeps working), while a grant IRI from no known pod is a
   * typed `unknown` (400) instead of a silent echo.
   */
  public async revokeGrants(
    grants: string[],
    requesterWebId: string | undefined
  ): Promise<RevokedGrant[]> {
    if (grants.length === 0) {
      throw new BadRequestHttpError('AccessRevocation requires at least one grant')
    }

    // resolve every requested grant's registry pod up front; group by owner
    // (B2 — the requested set, not the loaded subset)
    const records = await Promise.all(
      grants.map(async (grant) => ({
        grant,
        record: await this.endpointStore.findSparqlByIri(grant),
      }))
    )
    const unresolved = records.filter(({ record }) => !record)
    if (unresolved.length > 0) {
      throw new RevocationError(
        'unknown',
        unresolved.map(({ grant }) => grant),
        `no SPARQL endpoint for grant ${unresolved[0].grant}`
      )
    }
    const endpoints = new Set(records.map(({ record }) => record!.endpoint))
    if (endpoints.size > 1) {
      throw new RevocationError('mixed-owner', grants, 'all grants must have the same dataOwner')
    }

    const record = records[0].record!
    const transport = localSparqlTransport(record.endpoint)
    // grants are direct children of the grant registry container
    const grantRegistryIri = grants[0].replace(/[^/]*$/, '')

    const revoked = await revokeGrantsClosure(transport, grantRegistryIri, grants, requesterWebId)

    // delete through Temporal, mirroring issuance: the worker runs the deletes
    // with the data owner's own session (owner rights), with activity-retry
    // semantics; the response only returns once the closure is gone and the
    // owner's registration projection no longer links the removed grants
    if (revoked.length > 0) {
      const owner: SocialAgentId = {
        id: revoked[0].dataOwner,
        type: [INTEROP.SocialAgent],
      }
      const toDelete: GrantId[] = revoked.map((grant) => ({
        id: grant.iri,
        type: [INTEROP.DataGrant],
      }))
      // group the removed grants by grantee for the owner-side projection
      // patch (the owner's registry links them from each grantee's
      // registration; a role grantee has no registration and is skipped there)
      const projectionByGrantee = new Map<string, string[]>()
      for (const grant of revoked) {
        const group = projectionByGrantee.get(grant.grantee) ?? []
        group.push(grant.iri)
        projectionByGrantee.set(grant.grantee, group)
      }
      const projection = [...projectionByGrantee].map(([grantee, iris]) => ({
        grantee,
        grants: iris,
      }))
      const temporal = new Temporal()
      await temporal.init()
      await temporal.client.workflow.execute(revokeGrants, {
        taskQueue: 'create-grants',
        workflowId: crypto.randomUUID(),
        args: [{ webId: owner, grants: toDelete, projection }],
      })
    }

    return revoked
  }
}
