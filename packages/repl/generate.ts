/** An environment map (`environments/<env>/map.json`). */
export interface EnvMap {
  /** entity IRI → environment IRI (WebIDs, …) */
  agents: Record<string, string>
  /** namespace (and `meta:` graph) prefix → environment prefix */
  prefixes: Record<string, string>
}

const encode = (str: string): string => Buffer.from(str).toString('base64url')

// TriG graph blocks may omit the `GRAPH` keyword (the fixture does), so a line
// that *starts* with the graph label counts too.
const graphRegExp = /^(?:GRAPH )?<((?:meta:)?https?:\/\/[^>]+)> \{/

/**
 * Rewrite the fixture's IRIs into one environment's IRIs.
 *
 * Graph labels are storage/document IRIs, which differ from the entity IRIs
 * inside the graph: a WebID profile is stored at the doc IRI
 * (`https://id/<handle>`) and describes the agent WebID
 * (`https://<handle>.id.docker`, `webIdTemplate`). So graph labels only get the
 * prefix mappings — never `agents`.
 *
 * The `meta:` mappings must also win over non-meta ones (and be applied most
 * specific first): a label `<meta:X>` is the data-server metadata of X, and X
 * may map elsewhere (e.g. the test-client document maps to the app origin while
 * its `meta:` graph maps to the data pod). Otherwise a non-meta mapping rewrites
 * the inner X and leaves the graph outside any pod (`splitFixtureByPod` throws
 * for such a graph).
 */
export function rewriteFixture(content: string, map: EnvMap): string {
  const urlMap = {
    ...Object.fromEntries(Object.entries(map.agents).map(([k, v]) => [encode(k), encode(v)])),
    ...map.agents,
    ...map.prefixes,
  }

  const metaGraphPrefixes = Object.entries(map.prefixes)
    .filter(([oldUrl]) => oldUrl.startsWith('meta:'))
    .toSorted(([a], [b]) => b.length - a.length)
  const graphPrefixes = [
    ...metaGraphPrefixes,
    ...Object.entries(map.prefixes).filter(([oldUrl]) => !oldUrl.startsWith('meta:')),
  ]

  const rewriteIris = (text: string): string => {
    let updated = text
    for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
      updated = updated.split(oldUrl).join(newUrl)
      // for segments in indexes in kv.json
      updated = updated.split(encodeURIComponent(oldUrl)).join(encodeURIComponent(newUrl))
    }
    return updated
  }

  return content
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(graphRegExp)
      if (!match) {
        return rewriteIris(line)
      }
      // the graph label (and block opener) only get the prefix mappings; a
      // same-line block body is rewritten like any other content
      const openerEnd = (match.index ?? 0) + match[0].length
      let opener = line.slice(0, openerEnd)
      for (const [oldUrl, newUrl] of graphPrefixes) {
        opener = opener.split(oldUrl).join(newUrl)
      }
      return opener + rewriteIris(line.slice(openerEnd))
    })
    .join('\n')
}

/**
 * `podUrl → dataset name` for the seeded Fuseki datasets, from the rewritten
 * key-value fixture's `**sparqlEndpoint**` records (the endpoint's first path
 * segment is the dataset name, e.g. `/reg-alice/sparql` → `reg-alice`).
 */
export function podDatasetsFromKeyValue(kvData: unknown): Map<string, string> {
  const podDatasets = new Map<string, string>()
  for (const value of Object.values(kvData as Record<string, any>)) {
    for (const record of Object.values<any>(value?.['**sparqlEndpoint**'] ?? {})) {
      const [datasetName] = new URL(record.endpoint).pathname.split('/').filter(Boolean)
      podDatasets.set(record.podUrl, datasetName)
    }
  }
  return podDatasets
}
