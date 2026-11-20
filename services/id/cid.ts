import { documentLoader } from '@janeirodigital/interop-utils'
import * as jsonldNs from 'jsonld'
import { Parser, Reasoner, Store } from 'n3'
import type { Quad } from 'n3'

// CJS/ESM interop: jsonld is a CJS package; grab the full object so all
// properties (fromRDF, frame, compact, …) are available regardless of import style.
const jsonld = (jsonldNs as any).default ?? jsonldNs

export const CID_CONTEXT = 'https://www.w3.org/ns/cid/v1'

/**
 * Reasoning rules turning the WebID profile graph into a CID document.
 * Currently: a `solid:oidcIssuer` is exposed as an `lws:OpenIdProvider`
 * service, and `interop:hasAuthorizationAgent` as an `interop:AuthorizationAgent`
 * service (both via w3c `did:service` / `did:serviceEndpoint`). Direct
 * `did:service` entries already present in the profile — including the owner
 * access request/grant services — pass through framing unchanged. Add more
 * rules here as the CID document grows (verification methods, Multikeys, …).
 */
const rules = `
  PREFIX solid: <http://www.w3.org/ns/solid/terms#>
  PREFIX interop: <http://www.w3.org/ns/solid/interop#>
  PREFIX lws: <https://www.w3.org/ns/lws#>
  PREFIX did: <https://www.w3.org/ns/did#>

  {
    ?id solid:oidcIssuer ?issuer .
  }
  =>
  {
    ?id did:service [ a lws:OpenIdProvider ; did:serviceEndpoint ?issuer ] .
  } .
  {
    ?id interop:hasAuthorizationAgent ?agent .
  }
  =>
  {
    ?id did:service [ a interop:AuthorizationAgent ; did:serviceEndpoint ?agent ] .
  } .
`

// Parsed once, shared across requests
const rulesDataset = new Store(new Parser({ format: 'text/n3' }).parse(rules))

export type CidService = {
  type: string
  serviceEndpoint: string
}

export type CidDocument = {
  '@context': string
  id: string
  service: CidService[]
}

/**
 * Derive a CID document from the WebID profile triples.
 *
 * The naive n3 reasoner instantiates rule-head blank nodes once per rule, so
 * with several source predicates all endpoints land on one service node per
 * rule; the frame still emits one entry per (type, endpoint) pair.
 *
 * The derived graph is framed in a single pass: the frame carries the cid
 * context, so the output is already compacted (JSON-LD 1.1 framing), with
 * `@explicit` keeping only `service` and `@embed: '@always'` inlining the
 * service nodes.  The frame covers the whole fetched graph, not the requested
 * resource URL — the profile subject (e.g. `https://alice.id.docker`) can
 * differ from the resource that serves it (`https://id.docker/alice`), and
 * that subject becomes the document `id` (stable across aliases).
 *
 * Returns `undefined` when nothing was derived (no services) — the caller
 * responds 404.  The cid context declares no `@container: '@set'` on
 * `service`, so a single service compacts to a scalar and is wrapped in an
 * array here.
 *
 * (Reuses `documentLoader` from `@janeirodigital/interop-utils`, which embeds
 * the cid context locally — no network fetch.)
 */
export async function toCidDocument(triples: Iterable<Quad>): Promise<CidDocument | undefined> {
  const dataset = new Store([...triples])
  new Reasoner(dataset).reason(rulesDataset)
  const frame = {
    '@context': CID_CONTEXT,
    '@explicit': true,
    service: { '@embed': '@always' },
  }
  const framed = (await jsonld.frame(await jsonld.fromRDF([...dataset]), frame, {
    documentLoader,
  })) as { service?: CidService | CidService[] }
  // the cid context declares no `@container: '@set'` on `service`, so a single
  // service compacts to a scalar — normalize to the array shape
  if (framed.service && !Array.isArray(framed.service)) {
    framed.service = [framed.service]
  }
  return framed as CidDocument
}
