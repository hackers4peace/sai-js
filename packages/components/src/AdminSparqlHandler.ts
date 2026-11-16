import { jsonld } from '@janeirodigital/interop-utils'
import {
  BadRequestHttpError,
  BasicRepresentation,
  ForbiddenHttpError,
  InternalServerError,
  MethodNotAllowedHttpError,
  OkResponseDescription,
  OperationHttpHandler,
  UnsupportedMediaTypeHttpError,
  arrayifyStream,
  readableToString,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { type IBindings, type IUpdateTypes, SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { getLoggerFor } from 'global-logger-factory'

import type { CustomWebIdStore } from './CustomWebIdStore.js'
import type { PodEndpointStore } from './PodEndpointStore.js'
import { orgWebIdFromPath, requireOrgAdmin } from './services/adminGate.js'
import type { SessionManager } from './SessionManager'
import { registryId } from './util/uriTemplates.js'

const SPARQL_QUERY_MEDIA_TYPE = 'application/sparql-query'

/**
 * The `?pod=<podUrl>` target of an org-context data-plane query, if any.
 *
 * Read from the RAW request URL: the deployment's `TargetExtractor` strips
 * query strings (`includeQueryString: false` in the LDP request parser), so
 * `operation.target.path` does not carry `?pod=` — the same pitfall
 * `/proxy-admin` (`?iri=`) documents.
 * Parsing the path silently fell back to the org's REGISTRY pod for every
 * data-pod query (the org-context share/registration reads got an empty
 * `lws:partOf` result instead of an error).
 */
export function podFromRequestUrl(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return undefined
  return new URL(requestUrl, 'http://dummy-base.example').searchParams.get('pod') ?? undefined
}

/**
 * Serialize one SPARQL binding term into the W3C SPARQL JSON results format
 * (`application/sparql-results+json`).
 */
function termToJson(term: IBindings[string]): Record<string, unknown> {
  switch (term.termType) {
    case 'NamedNode':
      return { type: 'uri', value: term.value }
    case 'BlankNode':
      return { type: 'bnode', value: term.value }
    case 'Literal': {
      if (term.language) {
        return { type: 'literal', value: term.value, 'xml:lang': term.language }
      }
      const literal: Record<string, unknown> = { type: 'literal', value: term.value }
      // omit the implicit xsd:string datatype
      if (term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
        literal.datatype = term.datatype.value
      }
      return literal
    }
    default:
      return { type: 'literal', value: term.value }
  }
}

/**
 * Query-only SPARQL endpoint for org admins (org-context-sparql.md §2.2).
 *
 * Route `/.sai/sparql-admin/<base64url-org-webid>`, speaking the HTTP
 * `QUERY` method only (safe, read-only — draft-ietf-httpapi-safe-methods-wg;
 * DPoP-verifiable since `@solid/access-token-verifier` 2.1.2 added QUERY to
 * its `REQUEST_METHOD` whitelist). The SPARQL query travels in the request
 * body as `application/sparql-query`; updates (`application/sparql-update`,
 * INSERT/DELETE/…) and other methods are rejected.
 *
 * Gate (shared with `/proxy-admin`: `services/adminGate.ts` — the caller
 * must be an admin of the target org: its social-agent registration held
 * by that org carries a non-empty `hasAdminGrant` marker (403 otherwise).
 * The org itself never uses this endpoint; server-side reads go to the
 * internal endpoint directly.
 *
 * Queries are forwarded to the org's registry-pod endpoint resolved from the
 * endpoint store; SELECT/ASK results come back as
 * `application/sparql-results+json`, CONSTRUCT/DESCRIBE as
 * `application/ld+json`.
 */
export class AdminSparqlHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)

  private readonly fetcher = new SparqlEndpointFetcher()

  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager,
    private readonly endpointStore: PodEndpointStore,
    private readonly webIdStore: CustomWebIdStore
  ) {
    super()
  }

  /**
   * The endpoint to forward to. Without `?pod`, the org's registry pod. With
   * `?pod=<podUrl>`, that pod — but only if the account-storage record belongs
   * to the org (isolation; an admin cannot read another owner's dataset).
   */
  private async resolveEndpoint(orgWebId: string, podUrl?: string): Promise<string> {
    if (podUrl) {
      const record = await this.endpointStore.findSparqlByPodUrl(podUrl)
      const orgAccountId = await this.webIdStore.findAccount(orgWebId)
      if (!record || !orgAccountId || record.accountId !== orgAccountId) {
        throw new ForbiddenHttpError(`pod ${podUrl} is not owned by ${orgWebId}`)
      }
      return record.endpoint
    }
    // a store outage must surface (fail-closed); an org without a
    // registry-pod record is a misconfiguration
    const record = await this.endpointStore.findSparqlByPodUrl(registryId(orgWebId))
    if (!record) {
      throw new InternalServerError(`no registry-pod SPARQL endpoint for ${orgWebId}`)
    }
    return record.endpoint
  }

  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    // Belt-and-suspenders for the read-only contract (the router already
    // restricts the route to QUERY).
    if (operation.method !== 'QUERY') {
      throw new MethodNotAllowedHttpError(['QUERY'])
    }

    // Gate first — no server-side work is triggered for unauthenticated callers.
    // Target org: base64url-encoded webId in the last path segment (the
    // AgentIdHandler pattern); admin check shared with `/proxy-admin`.
    const orgWebId = orgWebIdFromPath(operation.target.path)
    await requireOrgAdmin(this.sessionManager, this.credentialsExtractor, request, orgWebId)
    const endpoint = await this.resolveEndpoint(orgWebId, podFromRequestUrl(request.url))

    // Query-only: require the sparql-query media type and reject updates.
    if (operation.body.metadata.contentType !== SPARQL_QUERY_MEDIA_TYPE) {
      throw new UnsupportedMediaTypeHttpError(`expected content type ${SPARQL_QUERY_MEDIA_TYPE}`)
    }
    const query = await readableToString(operation.body.data)
    if (!query.trim()) {
      throw new BadRequestHttpError('empty query')
    }

    let updateTypes: 'UNKNOWN' | IUpdateTypes
    try {
      updateTypes = this.fetcher.getUpdateTypes(query)
    } catch {
      throw new BadRequestHttpError('invalid SPARQL query')
    }
    if (updateTypes !== 'UNKNOWN') {
      throw new BadRequestHttpError('this endpoint only accepts queries, not updates')
    }

    let queryType: 'SELECT' | 'ASK' | 'CONSTRUCT' | 'UNKNOWN'
    try {
      queryType = this.fetcher.getQueryType(query)
    } catch {
      throw new BadRequestHttpError('invalid SPARQL query')
    }

    let payload: string
    let mediaType: string
    switch (queryType) {
      case 'SELECT': {
        const bindingsStream = await this.fetcher.fetchBindings(endpoint, query)
        const bindings = await arrayifyStream<IBindings>(bindingsStream)
        payload = JSON.stringify({
          head: { vars: [...new Set(bindings.flatMap((binding) => Object.keys(binding)))] },
          results: {
            bindings: bindings.map((binding) =>
              Object.fromEntries(
                Object.entries(binding).map(([name, term]) => [name, termToJson(term)])
              )
            ),
          },
        })
        mediaType = 'application/sparql-results+json'
        break
      }
      case 'ASK': {
        const boolean = await this.fetcher.fetchAsk(endpoint, query)
        payload = JSON.stringify({ head: {}, boolean })
        mediaType = 'application/sparql-results+json'
        break
      }
      case 'CONSTRUCT': {
        const triplesStream = await this.fetcher.fetchTriples(endpoint, query)
        const quads = await arrayifyStream<unknown>(triplesStream)
        payload = JSON.stringify(await jsonld.fromRDF(quads))
        mediaType = 'application/ld+json'
        break
      }
      default:
        throw new BadRequestHttpError('unsupported query form')
    }

    const representation = new BasicRepresentation(payload, operation.target, mediaType)
    return new OkResponseDescription(representation.metadata, representation.data)
  }
}
