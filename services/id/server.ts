import { write } from '@jeswr/pretty-turtle'
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as jsonldNs from 'jsonld'
import { Store } from 'n3'

import { toCidDocument } from './cid.ts'

// CJS/ESM interop: jsonld is a CJS package; grab the full object so all
// properties (fromRDF, …) are available regardless of import style.
const jsonld = (jsonldNs as any).default ?? jsonldNs

const idOrigin = process.env.ID_ORIGIN
const docOrigin = process.env.DOC_ORIGIN
const sparqlEndpoint = process.env.CSS_ID_SPARQL_ENDPOINT

if (!idOrigin || !docOrigin || !sparqlEndpoint) {
  throw new Error('env missing!')
}

const fetcher = new SparqlEndpointFetcher()

const construct = (graph: string): string => `
  CONSTRUCT { ?s ?p ?o } WHERE {
    GRAPH <${graph}> {?s ?p ?o}
  }
`

const app = new Hono()
app.use(
  cors({
    origin: (origin) => origin,
    credentials: true,
  })
)
app.get('/', (c) => {
  const host = c.req.header('Host')
  if (!host) {
    return c.text('missing host', 400)
  }
  const hostParts = host.split('.')
  if (hostParts.length !== idOrigin.split('.').length + 1) {
    return c.text('invalid subdomain count', 400)
  }
  if (hostParts.slice(1).join('.') !== idOrigin) {
    return c.text('invalid domain', 400)
  }
  const subdomain = hostParts[0]
  return c.redirect(`https://${docOrigin}/${subdomain}`, 303)
})

app.get('/:handle', async (c) => {
  const host = c.req.header('Host')
  if (host !== docOrigin) {
    return c.text('wrong doc origin', 400)
  }
  const handle = c.req.param('handle')
  const id = `https://${docOrigin}/${handle}`
  const triplesStream = await fetcher.fetchTriples(sparqlEndpoint, construct(id))
  const triples = await triplesStream.toArray()
  // no triples in the requested graph — the webid does not exist
  if (triples.length === 0) {
    return c.text('not found', 404)
  }
  const accept = c.req.header('Accept') ?? ''
  if (accept.includes('application/ld+json')) {
    const doc = await jsonld.fromRDF(new Store(triples))
    c.header('Content-Type', 'application/ld+json')
    return c.body(JSON.stringify(doc))
  }
  if (accept.includes('text/turtle')) {
    c.header('Content-Type', 'text/turtle')
    return c.body(await write(triples))
  }
  // default: application/cid — also matches an explicit application/cid request
  const doc = await toCidDocument(triples)
  // no services derived from the profile — nothing to serve as a CID document
  if (!doc) {
    return c.text('not found', 404)
  }
  c.header('Content-Type', 'application/cid')
  return c.body(JSON.stringify(doc))
})

export default app
