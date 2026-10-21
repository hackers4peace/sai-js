import type { FinalGrantData } from '@janeirodigital/interop-data-model'
import { toJsonLd } from '@janeirodigital/interop-data-model'
import { expandedJsonLd, toNQuads } from '@janeirodigital/interop-utils'
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint'

import { toGraphBlocks } from './ReciprocalMirror.js'

const fetcher = new SparqlEndpointFetcher()

/**
 * Store the issued delegated grant bodies in the org's own SPARQL endpoint —
 * the issuer-side replica `checkEquivalence` reads
 * (`docs/plans/check-equivalence.md` §2.1).
 *
 * One named graph per grant IRI, the same convention as the reciprocal mirror
 * (`GRAPH <grantIri>`, read through `graphDoc`). The parent document keeps the
 * reverse `inheritsFromGrant` edges (the context maps `hasInheritingGrant` to
 * the reverse property), so framing the parent surfaces its children; child
 * bodies are written as their own graphs. Grants are immutable — re-writing an
 * already-present body is a no-op.
 *
 * No automatic drops on replacement: stale replica graphs are invisible to
 * reads (only current registration links are read) and are cleaned up by
 * `dropGrantReplicas` together with the orphaned grant resources
 * (`revoke-delegation-chain` C3).
 */
export async function storeGrantReplica(
  sparqlEndpoint: string,
  grants: FinalGrantData[]
): Promise<void> {
  if (grants.length === 0) return
  const blocks: string[] = []
  for (const grant of grants) {
    const expanded = await expandedJsonLd(toJsonLd(grant))
    blocks.push(await toGraphBlocks(await toNQuads({ '@id': grant.id, '@graph': expanded })))
  }
  await fetcher.fetchUpdate(sparqlEndpoint, `INSERT DATA {\n${blocks.join('\n')}\n}`)
}

/**
 * Drop the issuer-side replica graphs of the given grant IRIs — the resource
 * graph and its `meta:` twin. `DROP SILENT GRAPH` is idempotent, so a
 * re-run/retry is safe. Only the grantor's local replica is touched; own
 * grant-registry graphs are never named here.
 */
export async function dropGrantReplicas(
  sparqlEndpoint: string,
  grantIris: string[]
): Promise<void> {
  if (grantIris.length === 0) return
  const drops = grantIris.flatMap((iri) => [
    `DROP SILENT GRAPH <${iri}>`,
    `DROP SILENT GRAPH <meta:${iri}>`,
  ])
  await fetcher.fetchUpdate(sparqlEndpoint, drops.join(';\n'))
}
