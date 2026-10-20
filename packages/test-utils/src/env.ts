/**
 * Seed a Fuseki dataset with a TriG payload.
 *
 * `datasetBaseUrl` is the dataset URL *without* a trailing service name, e.g.
 * `http://fuseki:3030/id` (see openwiki/architecture/storage-isolation.md). The
 * helper derives the SPARQL update endpoint (`/sparql`) and the Graph Store
 * Protocol endpoint (`/data`) from it.
 *
 * Fuseki loads the named graphs of a TriG payload verbatim on a GSP POST, so a
 * single request seeds the whole dataset (verified against
 * `secoresearch/fuseki:5.6.0`).
 */
export async function seedFusekiDataset(datasetBaseUrl: string, data: string): Promise<void> {
  await dropFusekiDataset(datasetBaseUrl)
  const response = await fetch(`${datasetBaseUrl}/data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/trig',
    },
    body: data,
  })
  if (!response.ok) {
    throw new Error(`seeding fuseki dataset ${datasetBaseUrl} failed (${response.status})`)
  }
}

/**
 * Remove every graph from a Fuseki dataset. Unlike Oxigraph's `DELETE <store>`,
 * Fuseki's GSP `DELETE /data` only clears the default graph, so the whole
 * dataset is dropped with a SPARQL `DROP ALL` update instead.
 */
export async function dropFusekiDataset(datasetBaseUrl: string): Promise<void> {
  const response = await fetch(`${datasetBaseUrl}/sparql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-update',
    },
    body: 'DROP ALL',
  })
  if (!response.ok) {
    throw new Error(`dropping fuseki dataset ${datasetBaseUrl} failed (${response.status})`)
  }
}
