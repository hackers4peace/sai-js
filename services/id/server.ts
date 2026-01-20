import { write } from '@jeswr/pretty-turtle'
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const domain = process.env.DOMAIN
const sparqlEndpoint = process.env.CSS_SPARQL_ENDPOINT

if (!domain || !sparqlEndpoint) throw new Error('env missing!')

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
  if (host === domain) return c.text('subdomain is required!', 400)
  const subdomain = host?.replace('.id.docker', '')
  return c.redirect(`https://${domain}/${subdomain}`, 303)
})

app.get('/:handle', async (c) => {
  const handle = c.req.param('handle')
  const id = `https://${domain}/${handle}`
  const triplesStream = await fetcher.fetchTriples(sparqlEndpoint, construct(id))
  c.header('Content-Type', 'text/turtle')
  return c.body(await write(await triplesStream.toArray()))
})

export default app
