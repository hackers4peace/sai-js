import { Parser, Writer } from 'n3'
import type { Quad } from 'n3'

/** The dataset that holds the id service's WebID profiles. */
export const ID_DATASET = 'id'

export interface FusekiFixtureOptions {
  /** pod base URL → dataset name (registry pods and data pods) */
  podDatasets: Map<string, string>
  /** origin of the id service's WebID profiles (default `https://id/`) */
  idOrigin?: string
}

/** Pod name used in the dataset name: first path segment, else first host label. */
function podName(podUrl: string): string {
  const url = new URL(podUrl)
  const segment = url.pathname.split('/').filter(Boolean)[0]
  return segment ?? url.hostname.split('.')[0]
}

/** Dataset name for a registry pod (`reg-<handle>`) or data pod (`data-<pod>`). */
export function datasetForPod(podUrl: string, kind: 'registry' | 'data'): string {
  return `${kind === 'registry' ? 'reg' : 'data'}-${podName(podUrl)}`
}

function matchPod(iri: string, podDatasets: Map<string, string>): string | undefined {
  let best: string | undefined
  for (const podUrl of podDatasets.keys()) {
    if ((iri === podUrl || iri.startsWith(podUrl)) && (!best || podUrl.length > best.length)) {
      best = podUrl
    }
  }
  return best
}

/**
 * Map one fixture graph IRI to the dataset that should hold it. A leading
 * `meta:` (CSS metadata graphs) is ignored, so `meta:<iri>` follows `<iri>`.
 * The id origin routes to `id`; anything else must match a pod — an unmatched
 * graph throws, so a fixture can never silently land in a catch-all dataset.
 */
export function datasetForGraph(graphIri: string, opts: FusekiFixtureOptions): string {
  const iri = graphIri.startsWith('meta:') ? graphIri.slice('meta:'.length) : graphIri
  if (iri.startsWith(opts.idOrigin ?? 'https://id/')) return ID_DATASET
  const podUrl = matchPod(iri, opts.podDatasets)
  if (!podUrl) {
    throw new Error(`no dataset for graph <${graphIri}> — not under a pod or the id origin`)
  }
  return opts.podDatasets.get(podUrl)!
}

/**
 * Build the `podUrl → dataset` map for a fixture from its accounts. `pod` is
 * the `**pod**` record (data storage); the registry pod is derived from the
 * account's WebID handle and the registry origin of the environment.
 */
export function fixturePodDatasets(
  accounts: { webId: string; podBaseUrls: string[] }[],
  registryOrigin: string
): Map<string, string> {
  const map = new Map<string, string>()
  for (const account of accounts) {
    // the WebID can be path-based (`https://id/alice`) or subdomain
    // (`https://alice.id.docker`, the mapped dev/demo form) — `podName`
    // handles both
    const handle = podName(account.webId)
    const registryPod = `${registryOrigin}${handle}/`
    map.set(registryPod, datasetForPod(registryPod, 'registry'))
    for (const baseUrl of account.podBaseUrls) {
      map.set(baseUrl, datasetForPod(baseUrl, 'data'))
    }
  }
  return map
}

function quadsToTrig(quads: Quad[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: 'TriG' })
    writer.addQuads(quads)
    writer.end((error, result) => (error ? reject(error) : resolve(result)))
  })
}

const RECIPROCAL_REGISTRATION = 'http://www.w3.org/ns/solid/interop#reciprocalRegistration'
const HAS_DATA_GRANT = 'http://www.w3.org/ns/solid/interop#hasDataGrant'

/**
 * Backfill the reciprocal mirrors into the owner datasets at seed time — the
 * offline equivalent of `updateReciprocalMirror`: for every registration that
 * links a `reciprocalRegistration`, copy the target registration's graph(s)
 * (and the graphs of the grants it links) into the linking owner's dataset,
 * named after the source IRIs. Required once stores are per-pod (the live
 * peer graphs are no longer visible from the owner's dataset).
 */
function applyReciprocalMirrors(
  byGraph: Map<string, Quad[]>,
  byDataset: Map<string, Quad[]>
): void {
  const datasetOfGraph = new Map<string, string>()
  for (const [dataset, quads] of byDataset) {
    for (const quad of quads) {
      if (quad.graph.termType !== 'DefaultGraph') datasetOfGraph.set(quad.graph.value, dataset)
    }
  }

  const links: { owner: string; target: string }[] = []
  for (const [graphIri, quads] of byGraph) {
    const owner = datasetOfGraph.get(graphIri)
    if (!owner) continue
    for (const quad of quads) {
      if (quad.predicate.value === RECIPROCAL_REGISTRATION) {
        links.push({ owner, target: quad.object.value })
      }
    }
  }

  const copyGraph = (owner: string, iri: string): void => {
    const bucket = byDataset.get(owner)!
    for (const graph of [iri, `meta:${iri}`]) {
      for (const quad of byGraph.get(graph) ?? []) {
        if (!bucket.includes(quad)) bucket.push(quad)
      }
    }
  }

  for (const { owner, target } of links) {
    copyGraph(owner, target)
    for (const graph of [target, `meta:${target}`]) {
      for (const quad of byGraph.get(graph) ?? []) {
        if (quad.predicate.value === HAS_DATA_GRANT) copyGraph(owner, quad.object.value)
      }
    }
  }
}

/**
 * Split a TriG fixture into one TriG payload per pod dataset, with the
 * reciprocal mirrors backfilled. Used by `test/setup.ts` and `packages/repl`
 * to seed each per-pod Fuseki dataset
 * (openwiki/architecture/storage-isolation.md).
 */
export async function splitFixtureByPod(
  trig: string,
  opts: FusekiFixtureOptions
): Promise<Map<string, string>> {
  const quads = new Parser({ format: 'TriG' }).parse(trig)
  const byGraph = new Map<string, Quad[]>()
  for (const quad of quads) {
    const graph = quad.graph.termType === 'DefaultGraph' ? '' : quad.graph.value
    const bucket = byGraph.get(graph)
    if (bucket) bucket.push(quad)
    else byGraph.set(graph, [quad])
  }

  const byDataset = new Map<string, Quad[]>()
  for (const [graph, graphQuads] of byGraph) {
    if (!graph) throw new Error('default-graph quads are not supported')
    const dataset = datasetForGraph(graph, opts)
    const bucket = byDataset.get(dataset)
    if (bucket) bucket.push(...graphQuads)
    else byDataset.set(dataset, [...graphQuads])
  }

  applyReciprocalMirrors(byGraph, byDataset)

  const result = new Map<string, string>()
  for (const [dataset, datasetQuads] of byDataset) {
    result.set(dataset, await quadsToTrig(datasetQuads))
  }
  return result
}

/**
 * Render a Fuseki `config.ttl` with one `fuseki:Service` per dataset. Each
 * service offers `/sparql` (query + update) and `/data` (Graph Store
 * Protocol) and stores into its own TDB2 directory.
 */
export function fusekiConfig(datasets: string[]): string {
  const header = `@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix fuseki: <http://jena.apache.org/fuseki#> .
@prefix tdb2:   <http://jena.apache.org/2016/tdb#> .
`
  return `${header}\n${datasets.map(fusekiServiceBlock).join('\n')}`
}

function fusekiServiceBlock(name: string): string {
  return `<#${name}> rdf:type fuseki:Service ;
    fuseki:name "${name}" ;
    fuseki:endpoint [ fuseki:operation fuseki:query  ; fuseki:name "sparql" ] ;
    fuseki:endpoint [ fuseki:operation fuseki:update ; fuseki:name "sparql" ] ;
    fuseki:endpoint [ fuseki:operation fuseki:gsp_rw ; fuseki:name "data" ] ;
    fuseki:dataset <#${name}-dataset> .

<#${name}-dataset> rdf:type tdb2:DatasetTDB2 ;
    tdb2:location "/fuseki-base/databases/${name}" .
`
}
