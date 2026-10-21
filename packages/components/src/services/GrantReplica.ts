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
 * No drops: stale replica graphs are invisible to reads (only current
 * registration links are read) and are cleaned up together with the orphaned
 * grant resources (`revoke-delegation-chain` follow-up 10).
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
