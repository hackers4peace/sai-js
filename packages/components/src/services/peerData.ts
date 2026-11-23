import {
  DataRegistration,
  Grant,
  ShapeTree,
  childIris,
  frameDataInstanceFromDoc,
} from '@janeirodigital/interop-data-model'
import type { GrantData, ShapeTreeData } from '@janeirodigital/interop-data-model'
import { INTEROP, fetchJsonLd, loader } from '@janeirodigital/interop-utils'

import type { ResolvedContext } from './Context.js'
import { getReciprocalGrants, sparqlTransportFor } from './queries/org.js'
import { listSocialAgentRegistrations } from './SocialAgentRegistry.js'

const loadShapeTree = loader(ShapeTree.fromJsonLd)

/**
 * Raised when a peer document cannot be read: an unusable IRI, a failed
 * impersonation prerequisite (no admin authority, no org grant) or an upstream
 * non-2xx. Carries the upstream status when there is one.
 */
export class PeerProxyError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'PeerProxyError'
  }
}

/**
 * Reads one peer document through the context's storage fetch.
 *
 * Personal context: the user's own session, which holds the grants.
 * Org context: `ctx.storageFetch` either presents the admin's own credential
 * (the org's own pods → `scope: admin`, read-only) or performs the read-only
 * org impersonation for a peer storage — in both cases server-side, with no
 * document-proxy endpoint involved.
 */
export async function fetchPeerDocument(
  ctx: ResolvedContext,
  storage: string,
  targetId: string
): Promise<unknown> {
  let storageFetch: Awaited<ReturnType<ResolvedContext['storageFetch']>>
  try {
    storageFetch = await ctx.storageFetch(storage)
  } catch (error: unknown) {
    throw new PeerProxyError(`no access to ${targetId} on ${storage}: ${(error as Error).message}`)
  }
  try {
    // `fetchJsonLd` normalizes the document: the storage serves containers in
    // expanded/array JSON-LD form, which the framers do not read directly.
    return await fetchJsonLd(targetId, storageFetch)
  } catch (error: unknown) {
    // `fetchJsonLd` reports a non-2xx as `HttpStatusError` with `status`
    const status = (error as { status?: number }).status
    throw new PeerProxyError(
      status === undefined
        ? `no access to ${targetId} on ${storage}: ${(error as Error).message}`
        : `upstream ${status} for ${targetId}: ${(error as Error).message}`,
      status
    )
  }
}

/**
 * The peer data registration an instance belongs to, for the org context.
 *
 * The flat store keeps containment in the peer pod's `meta:` graph
 * (`lws:partOf`) and the instance *document* does not carry it, so a grantee
 * can not read it: storage isolation keeps the peer pod out of the context's
 * endpoint allowlist, and the peer's policy engine treats an auxiliary
 * (`.meta`) read as an unknown resource (deny). Instead, ask the registrations
 * the context's grants name — the peer's own containment is authoritative.
 *
 * Returns the registration IRI **and its storage** (the grant's `lws:storage`,
 * which scopes the peer read), or `undefined` when no granted registration
 * contains the instance.
 */
export async function peerRegistrationOfInstance(
  ctx: ResolvedContext,
  instanceIri: string
): Promise<{ id: string; storage: string } | undefined> {
  const transport = sparqlTransportFor(ctx)
  const seen = new Set<string>()
  for (const registration of await listSocialAgentRegistrations(ctx)) {
    if (!registration.reciprocalRegistration) {
      continue
    }
    const grants = await getReciprocalGrants(transport, registration.reciprocalRegistration)
    for (const grant of grants) {
      const candidate = grant.hasDataRegistration
      if (!candidate || seen.has(candidate)) {
        continue
      }
      seen.add(candidate)
      if ((await dataRegistrationContains(ctx, grant.storage, candidate)).includes(instanceIri)) {
        return { id: candidate, storage: grant.storage }
      }
    }
  }
  return undefined
}

/**
 * The `contains` of a data registration, read with the credential the context
 * holds for that storage. Used by the `getDescriptions` `AllFromRegistry` counts
 * and by `peerInstanceIris`'s `AllFromRegistry` branch.
 */
export async function dataRegistrationContains(
  ctx: ResolvedContext,
  storage: string,
  registrationIri: string
): Promise<string[]> {
  const doc = await fetchPeerDocument(ctx, storage, registrationIri)
  return (await DataRegistration.fromJsonLd(doc, registrationIri)).contains
}

/**
 * Frame an already-fetched peer data instance document.
 */
export async function peerInstanceNode(
  ctx: ResolvedContext,
  storage: string,
  instanceId: string,
  shapeTree: ShapeTreeData
): Promise<Record<string, unknown>> {
  return frameDataInstanceFromDoc(
    await fetchPeerDocument(ctx, storage, instanceId),
    instanceId,
    shapeTree
  )
}

/**
 * Data-instance IRIs covered by an access grant in **org context** — the
 * counterpart of the AA's `dataInstanceIrisForGrant` (which derefs peer docs
 * with the session's factory): `contains` via `dataRegistrationContains`,
 * `SelectedFromRegistry` from grant metadata, and `Inherited` walks the parent
 * grant and the parent instance content. Personal context keeps the AA's
 * `dataInstanceIrisForGrant`.
 */
export async function* peerInstanceIris(
  ctx: ResolvedContext,
  accessGrant: GrantData
): AsyncIterable<string> {
  switch (accessGrant.scopeOfGrant) {
    case INTEROP.AllFromRegistry:
      yield* await dataRegistrationContains(
        ctx,
        accessGrant.storage,
        accessGrant.hasDataRegistration
      )
      break
    case INTEROP.SelectedFromRegistry:
      yield* accessGrant.hasDataInstance ?? []
      break
    case INTEROP.Inherited: {
      // the parent grant lives in the peer's registry — refetched from the
      // grant's storage (SAPI supports one level of inheritance today)
      const parentGrant = await Grant.fromJsonLd(
        await fetchPeerDocument(ctx, accessGrant.storage, accessGrant.inheritsFromGrant!),
        accessGrant.inheritsFromGrant!
      )
      for await (const parentIri of peerInstanceIris(ctx, parentGrant)) {
        const parentShapeTree = await loadShapeTree(
          parentGrant.registeredShapeTree,
          ctx.session.fetch
        )
        yield* childIris(
          await peerInstanceNode(ctx, accessGrant.storage, parentIri, parentShapeTree),
          parentShapeTree,
          accessGrant.registeredShapeTree
        )
      }
      break
    }
    default:
      throw new Error(`Unknown scope: ${accessGrant.scopeOfGrant}`)
  }
}
