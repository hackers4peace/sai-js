import { write } from '@jeswr/pretty-turtle'
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const idOrigin = process.env.ID_ORIGIN
const docOrigin = process.env.DOC_ORIGIN
const sparqlEndpoint = process.env.CSS_SPARQL_ENDPOINT

if (!idOrigin || !docOrigin || !sparqlEndpoint) throw new Error('env missing!')

const fetcher = new SparqlEndpointFetcher()

const construct = (graph: string): string => `
  CONSTRUCT { ?s ?p ?o } WHERE {
    GRAPH <${graph}> {?s ?p ?o}
  }
`

const app = new Hono()
app.use(
  cors({
    origin: (origin, c) => origin,
    credentials: true,
  })
)
app.get('/', (c) => {
  const host = c.req.header('Host')
  if (!host) return c.text('missing host', 400)
  const hostParts = host.split('.')
  if (hostParts.length !== idOrigin.split('.').length + 1)
    return c.text('invalid subdomain count', 400)
  if (hostParts.slice(1).join('.') !== idOrigin) return c.text('invalid domain', 400)
  const subdomain = hostParts[0]
  return c.redirect(`https://${docOrigin}/${subdomain}`, 303)
})

app.get('/:handle', async (c) => {
  const host = c.req.header('Host')
  if (host !== docOrigin) return c.text('wrong doc origin', 400)
  const handle = c.req.param('handle')
  const id = `https://${docOrigin}/${handle}`
  const triplesStream = await fetcher.fetchTriples(sparqlEndpoint, construct(id))
  c.header('Content-Type', 'text/turtle')
  return c.body(await write(await triplesStream.toArray()))
})

export default app
