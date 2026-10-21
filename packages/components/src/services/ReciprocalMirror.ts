import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { localSparqlTransport, presentGraphs } from '@janeirodigital/interop-authorization-agent'
import type { SocialAgentRegistrationData } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  type WhatwgFetch,
  documentValues,
  fetchJsonLd,
  toNQuads,
} from '@janeirodigital/interop-utils'
import { arrayifyStream } from '@solid/community-server'
import { type IBindings, SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { DataFactory, Parser, Writer } from 'n3'
import type { Quad } from 'n3'

/**
 * Read-only local copies of peer-side registry data (org-context-sparql.md
 * phase 1).
 *
 * For every registration in the org's Agent Registry that carries a
 * `reciprocalRegistration` link, the mirror holds:
 *
 * - the reciprocal registration body (the peer's registration *of the org*)
 *   in a graph **named after the resource's own IRI** — the same IRI we
 *   would otherwise HTTP-GET;
 * - each data grant linked from it (`interop:hasDataGrant`) likewise in a
 *   graph named after its own IRI.
 *
 * This covers everything org-context reads would otherwise dereference on
 * the peer's server (where the admin's credentials match no ACR policy):
 * `buildSocialAgentProfile`, `getSocialAgents` pass 2,
 * `findDataGrantIndex` (its reciprocal-leg reads now resolve via the
 * registry plane, docs/sparql.md).
 *
 * **Single-writer invariant:** mirrors are written only by server-side sync
 * (`syncReciprocalMirror`) using the context's own session; UI/service code
 * treats them strictly read-only.
 *
 * Where the writes come from (openwiki/architecture/federation.md):
 *
 * - **initial mirror** — both invitation legs, `establishReciprocal` (inviter)
 *   and `acceptInvitation` (acceptor), before their activity is marked done;
 * - **refresh** — the per-`(webId, peerId)` delegated-grants consumer, which
 *   runs this sync as its first step and only then regenerates grants, so
 *   `done` on a `delegatedGrantsUpdated` activity means "mirror current";
 * - **removal** — `deleteReciprocalMirror`, still without a caller (the
 *   unregister flow does not exist yet).
 *
 * Consequence: the mirror is the only peer source for the registry plane.
 * `generateDelegatedDataGrants` reads it without any peer dereference and
 * raises `MirrorIncompleteError` when a reciprocal-linked graph is absent, and
 * webhook delivery is the only refresh path (the drift scan/backfill in
 * `docs/plans/pod-isolation-followup.md` A1 is the recovery for missed ones).
 */

const fetcher = new SparqlEndpointFetcher()

/**
 * Convert N-Quads to `GRAPH <g> { <triples> }` blocks. SPARQL `INSERT DATA`
 * only accepts triples or `GRAPH` blocks — 4-term N-Quads lines are invalid
 * (Fuseki rejects them with 400; Oxigraph happened to accept them).
 */
export async function toGraphBlocks(nquads: string): Promise<string> {
  const quads = new Parser({ format: 'N-Quads' }).parse(nquads)
  const byGraph = new Map<string, Quad[]>()
  for (const quad of quads) {
    const graph = quad.graph.termType === 'DefaultGraph' ? '' : quad.graph.value
    const bucket = byGraph.get(graph)
    if (bucket) bucket.push(quad)
    else byGraph.set(graph, [quad])
  }
  const blocks: string[] = []
  for (const [graph, graphQuads] of byGraph) {
    const triples = await new Promise<string>((resolve, reject) => {
      const writer = new Writer({ format: 'N-Triples' })
      // strip the graph term (the N-Triples writer would otherwise emit quads)
      writer.addQuads(
        graphQuads.map((quad) => DataFactory.quad(quad.subject, quad.predicate, quad.object))
      )
      writer.end((error, result) => (error ? reject(error) : resolve(result)))
    })
    blocks.push(graph ? `GRAPH <${graph}> {\n${triples}}` : triples)
  }
  return blocks.join('\n')
}

/** Fetch a resource with the given credentials as JSON-LD (expanded). */
async function fetchDoc(iri: string, fetch: WhatwgFetch): Promise<unknown> {
  return fetchJsonLd(iri, fetch)
}

/**
 * Replace the mirror graphs for `registration.reciprocalRegistration` with
 * the current content fetched from the peer (using the session's
 * credentials — the org's own session when called from server-side flows).
 *
 * One SPARQL UPDATE per call: the reciprocal registration graph is always
 * DROPped and re-inserted — its body mutates (label, access-need links) and
 * its grant links are the drift signal. Grant graphs already present in the
 * mirror are neither re-fetched nor re-inserted: grants are immutable
 * (minted with a fresh IRI on change, unlinked on replace, DELETEd on
 * revocation), so "already mirrored" means "still current". Newly linked
 * grants are fetched and inserted; no-longer-linked ones are DROPped.
 * Idempotent — re-running produces the same store content.
 *
 * Presence, not content: immutability makes a
 * mirrored grant body either current or absent, so the only gap left is a graph
 * that is linked but has no body — produced by writers outside this function
 * (the fixture/backfill splitter copies graph by graph, an ops restore can take
 * a single graph), or by a backend where one multi-operation UPDATE is not one
 * transaction. Such a grant is treated as not-yet-mirrored and fetched again;
 * left alone it would stay missing forever, because the link-based oracle never
 * re-fetches a listed grant.
 *
 * `meta:` twins: CSS keeps some bodies in `meta:<iri>`, and `graphDoc` reads
 * `GRAPH <iri>` UNION `GRAPH <meta:iri>`. Every DROP here covers both names, so
 * a seeded/restored `meta:` copy cannot shadow the fresh resource graph (which
 * would resurrect stale `hasDataGrant` links through the union).
 *
 * Crash-safety: everything before the single UPDATE is reads + an in-memory
 * diff, so a worker failure at any await leaves no partial state and the
 * activity re-runs from scratch. Writes replace whole graphs (never patch),
 * so concurrent writers converge last-writer-wins per graph; the residual
 * race is a stale-drop from an older snapshot dropping a graph a concurrent
 * newer sync just re-linked — healed by the next sync. Runtime refreshes are
 * serialized per (webId, peerId) by the delegated-grants consumer
 * (openwiki/architecture/federation.md); the invitation-time initial syncs are
 * per-pair and non-overlapping.
 */
export async function updateReciprocalMirror(
  saiSession: AuthorizationAgent,
  registration: SocialAgentRegistrationData,
  sparqlEndpoint: string
): Promise<void> {
  const reciprocalIri = registration.reciprocalRegistration
  if (!reciprocalIri) throw new Error(`registration ${registration.id} has no reciprocal`)

  const reciprocalDoc = await fetchDoc(reciprocalIri, saiSession.fetch)

  // document-wide scan — the reciprocal registration is the only node
  // carrying `hasDataGrant` in its body
  const grantIris = await documentValues(reciprocalDoc, reciprocalIri, INTEROP.hasDataGrant)

  // Existence oracle: the mirror's reciprocal graph lists the grants the last
  // sync wrote, and reciprocal + grants are written in one atomic UPDATE — so
  // a grant already listed there is still current and can be skipped (the
  // reciprocal graph is re-inserted with the full current link set every run,
  // keeping the oracle valid). Only newly linked grants need a peer fetch.
  const mirroredGrantIris = await mirroredGrants(sparqlEndpoint, reciprocalIri)
  const mirroredGrantSet = new Set(mirroredGrantIris)

  // set-difference both ways: newly linked grants (fresh ∖ mirrored) need a
  // peer fetch + insert; no-longer-linked ones (mirrored ∖ fresh) get
  // dropped. `Set.prototype.difference` is ES2025 — needs Node ≥ 22 (worker
  // runs node:24); fallback would be filter + has().
  const grantIrisSet = new Set(grantIris)

  // Still linked AND claimed as mirrored — verify the body is really there
  // (see "Presence, not content" above); missing ones fall back into the
  // to-fetch set.
  const stillLinked = [...mirroredGrantSet].filter((iri) => grantIrisSet.has(iri))
  if (stillLinked.length > 0) {
    const present = await presentGraphs(localSparqlTransport(sparqlEndpoint), stillLinked)
    for (const iri of stillLinked) {
      if (!present.has(iri)) mirroredGrantSet.delete(iri)
    }
  }

  const toInsert = [...grantIrisSet.difference(mirroredGrantSet)]
  const staleGraphs = [...mirroredGrantSet.difference(grantIrisSet)]

  const grantDocs = new Map<string, unknown>()
  for (const grantIri of toInsert) {
    grantDocs.set(grantIri, await fetchDoc(grantIri, saiSession.fetch))
  }

  const drops = [reciprocalIri, ...staleGraphs]
    .flatMap((iri) => [iri, `meta:${iri}`])
    .map((iri) => `DROP SILENT GRAPH <${iri}>;`)
    .join('\n')

  // each document becomes a named graph — as a `GRAPH <…> { … }` block, which
  // is what SPARQL `INSERT DATA` accepts (N-Quads lines are invalid there)
  const inserts: string[] = []
  for (const [graphIri, doc] of [[reciprocalIri, reciprocalDoc], ...grantDocs.entries()] as [
    string,
    unknown,
  ][]) {
    inserts.push(await toGraphBlocks(await toNQuads({ '@id': graphIri, '@graph': doc })))
  }

  await fetcher.fetchUpdate(sparqlEndpoint, `${drops}\nINSERT DATA {\n${inserts.join('\n')}\n}`)
}

/**
 * Grant IRIs currently linked in the mirrored reciprocal registration.
 *
 * Reads the resource graph **and** its `meta:` twin — the same union `graphDoc`
 * frames. With the resource-graph read alone, a meta-only mirror (the seed and
 * `applyReciprocalMirrors` write both, CSS may keep bodies only in `meta:`)
 * reports "nothing mirrored": every sync would re-fetch the whole grant list
 * and stale grants would never be dropped.
 */
async function mirroredGrants(sparqlEndpoint: string, reciprocalIri: string): Promise<string[]> {
  const bindingsStream = await fetcher.fetchBindings(
    sparqlEndpoint,
    `SELECT DISTINCT ?grant WHERE {
  { GRAPH <${reciprocalIri}> { <${reciprocalIri}> <${INTEROP.hasDataGrant}> ?grant . } }
  UNION
  { GRAPH <meta:${reciprocalIri}> { <${reciprocalIri}> <${INTEROP.hasDataGrant}> ?grant . } }
}`
  )
  const bindings = await arrayifyStream<IBindings>(bindingsStream)
  return bindings.map((binding) => binding.grant.value)
}

/**
 * Drop the mirror graphs of `registration.reciprocalRegistration` — the
 * registration graph and every grant graph still linked in it, each with its
 * `meta:` twin (see the union note in `mirroredGrants`). Needs no credentials:
 * it only ever removes data this org mirrored itself.
 */
export async function deleteReciprocalMirror(
  registration: SocialAgentRegistrationData,
  sparqlEndpoint: string
): Promise<void> {
  const reciprocalIri = registration.reciprocalRegistration
  if (!reciprocalIri) return

  const grantIris = await mirroredGrants(sparqlEndpoint, reciprocalIri)
  const drops = [reciprocalIri, ...grantIris]
    .flatMap((iri) => [iri, `meta:${iri}`])
    .map((iri) => `DROP SILENT GRAPH <${iri}>;`)
    .join('\n')
  await fetcher.fetchUpdate(sparqlEndpoint, drops)
}
