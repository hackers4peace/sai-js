import { Readable } from 'node:stream'

import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { discoverAuthorizationAgent } from '@janeirodigital/interop-utils'
import {
  BadRequestHttpError,
  BasicRepresentation,
  ForbiddenHttpError,
  InternalServerError,
  OperationHttpHandler,
  ResponseDescription,
  UnauthorizedHttpError,
  UnsupportedMediaTypeHttpError,
  readableToString,
} from '@solid/community-server'
import type { CredentialsExtractor, OperationHttpHandlerInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import {
  acceptNeedBasedAccessRequest,
  isOdrlNeedBasedAccessRequest,
  needBasedAccessRequestFromOdrl,
} from './need-based-access-request.js'
import type { SessionManager } from './SessionManager.js'

/** The JSON-LD media type the access request endpoint requires. */
const LD_JSON_MEDIA_TYPE = 'application/ld+json'

const ENDPOINT_PREFIX = '/.sai/access-requests/'

type Credentials = Awaited<ReturnType<CredentialsExtractor['handleSafe']>>
type HandlerOperation = OperationHttpHandlerInput['operation']

/** Request headers forwarded to the registry's regular LWS reader. */
const FORWARDED_HEADERS = [
  'accept',
  'accept-language',
  'prefer',
  'if-none-match',
  'if-modified-since',
  'range',
] as const

/**
 * Owner-scoped access request endpoint:
 * `/.sai/access-requests/<base64url(owner)>`.
 *
 * `POST` dispatches only need-based access requests. Delegation and revocation
 * are projections in the issuing agent's own context and are not handled here.
 *
 * `GET`/`HEAD` are a facade over the owner's `AccessRequestRegistry`: the
 * owner's credentials are checked, then the endpoint target is rewritten to
 * the corresponding registry container/member and fetched with the owner's
 * session. The registry's regular LWS reader remains the source, so container
 * listing, member reads, and content negotiation stay intact.
 */
export class AccessRequestHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)

  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager
  ) {
    super()
  }

  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const { owner, remainder } = this.parseTarget(operation.target.path)

    if (operation.method === 'GET' || operation.method === 'HEAD') {
      return this.readRegistry(operation, request, owner, remainder)
    }

    if (operation.method !== 'POST') {
      throw new BadRequestHttpError(`unsupported method ${operation.method}`)
    }
    return this.acceptRequest(operation, request, owner)
  }

  private async acceptRequest(
    operation: HandlerOperation,
    request: OperationHttpHandlerInput['request'],
    owner: string
  ): Promise<ResponseDescription> {
    const credentials = await this.requireCredentials(request)
    if (!credentials.client?.clientId) {
      // missing credentials is an AUTHENTICATION failure — 401, not 403
      throw new UnauthorizedHttpError()
    }
    this.requireJsonLd(operation)

    const uasId = await discoverAuthorizationAgent(credentials.agent.webId, fetch)
    if (credentials.client.clientId !== uasId) {
      throw new ForbiddenHttpError()
    }

    const message = await this.parseMessage(operation)
    if (isOdrlNeedBasedAccessRequest(message)) {
      return acceptNeedBasedAccessRequest(
        this.sessionManager,
        needBasedAccessRequestFromOdrl(message, credentials.agent.webId, owner),
        credentials.agent.webId,
        owner
      )
    }
    throw new BadRequestHttpError('expected a need-based access request')
  }

  private async readRegistry(
    operation: HandlerOperation,
    request: OperationHttpHandlerInput['request'],
    owner: string,
    remainder: string
  ): Promise<ResponseDescription> {
    const credentials = await this.requireCredentials(request)
    // The request registry is owner-private; the facade performs the check
    // the normal LWS authorization layer would perform on the registry ACL.
    if (credentials.agent.webId !== owner) {
      throw new ForbiddenHttpError()
    }
    const sai = await this.sessionManager.getSession(owner)
    const registry = this.requestRegistry(sai)
    const target = remainder
      ? resolveFromRegistrySet(sai, registry.id, remainder)
      : ensureContainerPath(registry.id)
    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name]
      if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const upstream = await sai.fetch(target, { method: operation.method, headers })
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    if (operation.method === 'HEAD') {
      const representation = new BasicRepresentation('', { path: target }, contentType)
      return new ResponseDescription(upstream.status, representation.metadata)
    }
    const data = upstream.body
      ? Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
      : Readable.from([])
    const representation = new BasicRepresentation(data, { path: target }, contentType)
    return new ResponseDescription(upstream.status, representation.metadata, representation.data)
  }

  private async requireCredentials(
    request: OperationHttpHandlerInput['request']
  ): Promise<Credentials> {
    const credentials = await this.credentialsExtractor.handleSafe(request)
    if (!credentials.agent?.webId) {
      // missing credentials is an AUTHENTICATION failure — 401, not 403
      throw new UnauthorizedHttpError()
    }
    return credentials
  }

  private requireJsonLd(operation: HandlerOperation): void {
    const contentType = operation.body.metadata.contentType?.toLowerCase() ?? ''
    if (
      contentType !== LD_JSON_MEDIA_TYPE &&
      contentType !== 'application/lws+json' &&
      !contentType.startsWith('application/ld+json;')
    ) {
      throw new UnsupportedMediaTypeHttpError(
        'expected application/ld+json or application/lws+json'
      )
    }
  }

  private requestRegistry(sai: AuthorizationAgent): { id: string } {
    const registry = sai.registrySet.hasAccessRequestRegistry
    if (!registry) {
      throw new InternalServerError('access-request registry not found in registry set')
    }
    return registry
  }

  /**
   * Parse `/.sai/access-requests/<base64url(owner)>[/<registry-relative-path>]`.
   * The member path is resolved against the owner's registry set so both flat
   * members (`https://registry/<owner>/<uuid>`) and conventional nested
   * registry members address correctly.
   */
  private parseTarget(path: string): { owner: string; remainder: string } {
    let pathname: string
    try {
      pathname = /^[a-z][a-z\d+.-]*:/iu.test(path) ? new URL(path).pathname : path
    } catch {
      throw new BadRequestHttpError('invalid access request endpoint')
    }
    if (!pathname.startsWith(ENDPOINT_PREFIX)) {
      throw new BadRequestHttpError('invalid access request endpoint')
    }
    const [encodedOwner, ...tail] = pathname.slice(ENDPOINT_PREFIX.length).split('/')
    if (!encodedOwner) {
      throw new BadRequestHttpError('missing access request owner')
    }
    let owner: string
    try {
      owner = Buffer.from(decodeURIComponent(encodedOwner), 'base64url').toString('utf8')
      const url = new URL(owner)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('unsupported owner scheme')
      }
    } catch {
      throw new BadRequestHttpError('invalid access request owner')
    }
    return { owner, remainder: tail.filter((segment) => segment.length > 0).join('/') }
  }

  private async parseMessage(operation: HandlerOperation): Promise<unknown> {
    try {
      return JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError((err as Error).message)
    }
  }
}

function ensureContainerPath(iri: string): string {
  return iri.endsWith('/') ? iri : `${iri}/`
}

/**
 * The registry set is the owner's storage root; access-request registry members
 * live there directly in the current flat LWS storage, and traditionally under
 * the `access-request/` container prefix in a nested storage.
 */
function resolveFromRegistrySet(
  sai: AuthorizationAgent,
  registryId: string,
  remainder: string
): string {
  const registrySetId = ensureContainerPath(sai.registrySet.id)
  const registryPath = ensureContainerPath(registryId)
  if (registryPath.startsWith(registrySetId)) {
    return new URL(remainder, registrySetId).href
  }
  return new URL(remainder, registryPath).href
}
