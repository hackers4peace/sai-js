import { SignJWT, exportJWK } from 'jose'
import type { GenerateKeyPairResult } from 'jose'

import { withSpan } from './tracing/shared.ts'
import { setBodyAttribute, setTokenAttributes } from './tracing/tokens.ts'
import type { WhatwgFetch } from './whatwg-fetch.ts'

/**
 * OAuth 2.0 Token Exchange grant type (RFC 8693), the only grant type the LWS
 * authorization server supports.
 */
export const LWS_TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'

/** Identity Assertion JWT Authorization Grant — the only subject token a storage accepts. */
export const LWS_TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag'

/** Path of the LWS authorization server metadata resource (LWS, §Authorization Server Metadata). */
export const LWS_CONFIGURATION_PATH = '/.well-known/lws-configuration'

/**
 * Request parameter naming the organization whose authority an
 * admin-impersonation request invokes (the organization's UAS is addressed).
 * It selects which admin relationship is used; it is not an assertion by the
 * caller, and the UAS verifies it against its own authorization data.
 */
export const SAI_IMPERSONATE_PARAM = 'impersonate'

/**
 * Request `scope` selecting read-only admin impersonation of an organization:
 * the caller must be an admin of the named organization through its own
 * authorization agent, and the issued ID-JAG carries the **organization's**
 * claim for one peer storage, narrowed to `odrl:read`.
 *
 * A request field, never a claim: the UAS resolves it against its own
 * authorization data and does not copy it into the ID-JAG (a storage `scope`
 * is minted only by the storage's own exchange).
 */
export const SAI_ADMIN_IMPERSONATION_SCOPE = 'urn:sai:params:oauth:scope:admin-impersonation:read'

/** Path of the OAuth 2.0 Protected Resource Metadata resource (RFC 9728). */
export const LWS_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'

/**
 * The endpoints of an LWS authorization server, as advertised by its
 * `/.well-known/lws-configuration` metadata document.
 */
export interface LwsAuthorizationServer {
  issuer: string
  tokenEndpoint: string
  jwksUri?: string
}

/**
 * The parameters of an LWS `WWW-Authenticate` challenge (LWS, §Authorization
 * Server Discovery). `resource_metadata` is the RFC 9728 protected resource
 * metadata URL; `as_uri` and `realm` are the earlier-draft equivalents.
 */
export interface LwsChallenge {
  resourceMetadata?: string
  asUri?: string
  realm?: string
  error?: string
}

const AUTH_PARAM = /([a-zA-Z0-9_~!#$%&'*+.^`|@-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g

function withBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers)
  headers.set('authorization', `Bearer ${token}`)
  return new Request(request, { headers })
}

function trimTrailingSlash(iri: string): string {
  return iri.endsWith('/') ? iri.slice(0, -1) : iri
}

function normalizeStorage(iri: string): string {
  return iri.endsWith('/') ? iri : `${iri}/`
}

/**
 * Whether the URL is a server-wide service path (the Solid notification
 * service). These are not inside a storage, but the storage server accepts a
 * storage token for any storage on the server and authorizes the request
 * against the decoded topic. Other unknown URLs on the same origin are
 * resources in *another* storage (e.g. a peer's registration) and must use the
 * storage from their `401` challenge.
 */
function isServicePath(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/.notifications/')
  } catch {
    return false
  }
}

/**
 * Parses the `Bearer` challenge of a `WWW-Authenticate` header into the LWS
 * discovery parameters. Returns `undefined` when the header is absent or has
 * no `Bearer` challenge (e.g. a Solid-OIDC `DPoP` challenge).
 */
export function parseLwsChallenge(header: string | null | undefined): LwsChallenge | undefined {
  if (!header) {
    return undefined
  }
  const bearer = /(?:^|,)\s*Bearer\s+(.*)$/is.exec(header)
  if (!bearer) {
    return undefined
  }
  const params: Record<string, string> = {}
  AUTH_PARAM.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AUTH_PARAM.exec(bearer[1])) !== null) {
    params[match[1].toLowerCase()] = match[2] ?? match[3]
  }
  const challenge: LwsChallenge = {}
  if (params.resource_metadata) {
    challenge.resourceMetadata = params.resource_metadata
  }
  if (params.as_uri) {
    challenge.asUri = params.as_uri
  }
  if (params.realm) {
    challenge.realm = params.realm
  }
  if (params.error) {
    challenge.error = params.error
  }
  return Object.keys(challenge).length > 0 ? challenge : undefined
}

/**
 * Reads the `authorization_servers` entry of a protected resource metadata
 * document (RFC 9728). LWS requires at least one entry.
 */
async function protectedResourceAuthorizationServer(
  metadataIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  try {
    const response = await fetch(metadataIri, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return undefined
    }
    const document = (await response.json()) as Record<string, unknown>
    const servers = document.authorization_servers
    const first = Array.isArray(servers) ? servers[0] : servers
    if (typeof first === 'string') {
      return first
    }
    if (first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'string') {
      return (first as { id: string }).id
    }
  } catch {
    // not a protected resource metadata document
  }
  return undefined
}

/**
 * Finds the LWS authorization server of a storage.
 *
 * The preferred path is the challenge of a `401` response on the storage:
 * `resource_metadata` → `authorization_servers`, or the earlier-draft
 * `as_uri`. Without a challenge the storage origin is probed for the protected
 * resource metadata and the authorization server metadata, which covers
 * servers whose storage origin is their base URL (e.g. a registry server).
 */
export async function discoverLwsAuthorizationServer(
  storage: string,
  fetch: WhatwgFetch,
  challenge?: LwsChallenge
): Promise<string> {
  if (challenge?.resourceMetadata) {
    const asUri = await protectedResourceAuthorizationServer(challenge.resourceMetadata, fetch)
    if (asUri) {
      return asUri
    }
  }
  if (challenge?.asUri) {
    return challenge.asUri
  }

  const origin = new URL(storage).origin
  const asUri = await protectedResourceAuthorizationServer(
    `${origin}${LWS_PROTECTED_RESOURCE_METADATA_PATH}`,
    fetch
  )
  if (asUri) {
    return asUri
  }

  // A storage server that is its own authorization server advertises the
  // metadata on its base URL; for other storages the challenge is required.
  const configuration = await fetchLwsAuthorizationServerMetadata(origin, fetch)
  if (configuration) {
    return configuration.issuer
  }
  throw new Error(`cannot discover the LWS authorization server of ${storage}`)
}

/** Fetches the `/.well-known/lws-configuration` metadata of an authorization server. */
export async function fetchLwsAuthorizationServerMetadata(
  authorizationServer: string,
  fetch: WhatwgFetch
): Promise<LwsAuthorizationServer | undefined> {
  const iri = `${trimTrailingSlash(authorizationServer)}${LWS_CONFIGURATION_PATH}`
  try {
    const response = await fetch(iri, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return undefined
    }
    const document = (await response.json()) as Record<string, unknown>
    if (typeof document.token_endpoint !== 'string') {
      return undefined
    }
    return {
      issuer: typeof document.issuer === 'string' ? document.issuer : authorizationServer,
      tokenEndpoint: document.token_endpoint,
      ...(typeof document.jwks_uri === 'string' ? { jwksUri: document.jwks_uri } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Resolves the authorization server metadata of a storage, from a `401`
 * challenge when available.
 */
export async function discoverLwsAuthorizationServerMetadata(
  storage: string,
  fetch: WhatwgFetch,
  challenge?: LwsChallenge
): Promise<LwsAuthorizationServer> {
  const asUri = await discoverLwsAuthorizationServer(storage, fetch, challenge)
  const metadata = await fetchLwsAuthorizationServerMetadata(asUri, fetch)
  if (!metadata) {
    throw new Error(`cannot fetch the LWS authorization server metadata of ${asUri}`)
  }
  return metadata
}

/**
 * Signs a DPoP proof (RFC 9449) for a token endpoint request. The LWS token
 * endpoint verifies the proof so a sender-constrained subject token (with a
 * `cnf.jkt` claim) can only be exchanged by the client holding its key.
 */
export async function createLwsTokenDpopProof(
  tokenEndpoint: string,
  dpopKeyPair: GenerateKeyPairResult
): Promise<string> {
  const publicJwk = await exportJWK(dpopKeyPair.publicKey)
  return new SignJWT({ htm: 'POST', htu: tokenEndpoint })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(dpopKeyPair.privateKey)
}

export interface LwsTokenExchangeOptions {
  /** Authorization server metadata (`token_endpoint` is used). */
  authorizationServer: LwsAuthorizationServer
  /** The storage the access token is requested for (the `resource` parameter). */
  resource: string
  /**
   * The ID-JAG that authorizes this exchange (the `subject_token` parameter).
   * Storages accept only ID-JAG subject tokens; a raw ID/access token is not a
   * storage credential.
   */
  subjectToken: string
  fetch: WhatwgFetch
}

export interface LwsAccessToken {
  accessToken: string
  /** Lifetime of the token in seconds. */
  expiresIn: number
}

/**
 * Exchanges an ID-JAG for an LWS access token of a storage (LWS, §Token
 * Exchange). The access token is a bearer token bound to the storage through
 * its `aud` claim. The exchange itself is a bearer grant exchange: DPoP is only
 * used at the first hop (the user's UAS), never at a storage.
 */
export async function exchangeLwsAccessToken(
  options: LwsTokenExchangeOptions
): Promise<LwsAccessToken> {
  const { authorizationServer, resource, subjectToken, fetch } = options
  const body = new URLSearchParams({
    grant_type: LWS_TOKEN_EXCHANGE_GRANT,
    subject_token_type: LWS_TOKEN_TYPE_ID_JAG,
    subject_token: subjectToken,
    resource,
  })

  return withSpan(
    'sai-lws',
    'sai.lws.exchange-access-token',
    async (span): Promise<LwsAccessToken> => {
      span.setAttributes({
        'sai.lws.grant_type': LWS_TOKEN_EXCHANGE_GRANT,
        'sai.lws.subject_token_type': LWS_TOKEN_TYPE_ID_JAG,
        'sai.lws.resource': resource,
        'sai.lws.audience': authorizationServer.issuer,
        'sai.lws.client_auth_method': 'none',
      })
      setTokenAttributes(span, 'id-jag', subjectToken)
      setBodyAttribute(span, 'sai.lws.request.body', body.toString())

      const response = await fetch(authorizationServer.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        // a storage `invalid_grant` is "no token for this storage", not a crash
        span.setAttribute('sai.lws.error', String(response.status))
        throw new Error(
          `LWS token exchange failed for ${resource}: ${response.status}${detail ? ` ${detail}` : ''}`
        )
      }
      const document = (await response.json()) as Record<string, unknown>
      if (typeof document.access_token !== 'string') {
        throw new Error(`LWS token exchange for ${resource} returned no access_token`)
      }
      setTokenAttributes(span, 'access', document.access_token)
      setBodyAttribute(span, 'sai.lws.response.body', JSON.stringify(document))
      return {
        accessToken: document.access_token,
        expiresIn: typeof document.expires_in === 'number' ? document.expires_in : 300,
      }
    }
  )
}

export interface LwsFetchOptions {
  /**
   * Returns the ID-JAG that authorizes the storage exchange, called for every
   * exchange (the grant is short-lived, so it is not cached here). Required
   * unless `tokenSource` is set. Storages accept only ID-JAG subject tokens.
   */
  subjectToken?: () => Promise<string>
  /**
   * Custom access token source, e.g. a client that obtains the ID-JAG and
   * exchanges it over HTTP. Returns `undefined` when the storage authorization
   * server denied the exchange with `invalid_grant` (no token for this
   * storage); the request then goes out without `Authorization`, so public
   * resources still work.
   */
  tokenSource?: (storage: string, challenge?: LwsChallenge) => Promise<LwsAccessToken | undefined>
  /**
   * Storages the session knows about (e.g. its data and registry pods). Their
   * requests are authenticated up front instead of after a `401` round trip.
   */
  storages?: Iterable<string>
  /** Underlying fetch for the actual requests, token exchanges and discovery. */
  fetch?: WhatwgFetch
  /** Renew the access token this many milliseconds before it expires. Defaults to 30s. */
  renewalMargin?: number
}

interface CachedToken {
  accessToken: string
  expiresAt: number
}

export interface LwsAccessTokenRequestOptions {
  /** The storage the token is requested for (the `resource` parameter). */
  resource: string
  /** Returns the ID-JAG that authorizes the agent at this storage. */
  subjectToken: () => Promise<string>
  /** Underlying fetch for the challenge probe, discovery and the exchange. */
  fetch?: WhatwgFetch
}

/**
 * Obtains an LWS access token for a storage without a request to it: probes
 * the storage for its `401` challenge (the storage root is public, its LDP
 * representation is not), discovers the authorization server and exchanges
 * the ID-JAG. Used by the SAI UAS to hand a storage token to its UI.
 */
export async function requestLwsAccessToken(
  options: LwsAccessTokenRequestOptions
): Promise<LwsAccessToken> {
  const baseFetch = options.fetch ?? fetch
  const probe = await baseFetch(options.resource, {
    method: 'HEAD',
    headers: { accept: 'application/ld+json' },
  })
  const challenge = parseLwsChallenge(probe.headers.get('www-authenticate'))
  const authorizationServer = await discoverLwsAuthorizationServerMetadata(
    options.resource,
    baseFetch,
    challenge
  )
  return exchangeLwsAccessToken({
    authorizationServer,
    resource: options.resource,
    subjectToken: await options.subjectToken(),
    fetch: baseFetch,
  })
}

/**
 * Wraps a fetch so requests to LWS storages carry an LWS access token.
 *
 * The session owner's ID-JAG is exchanged for a storage access token, cached
 * per storage until shortly before it expires. The token is bound to the
 * storage, not to a resource, so one token serves every request to that
 * storage. A `401` response re-runs discovery and the exchange (the token may
 * have expired or been revoked) and retries the request once. An exchange
 * `invalid_grant` means the agent has no token for the storage: the request is
 * retried once without `Authorization` so public data still works.
 *
 * Requests to URLs outside the known storages are sent unauthenticated; if
 * they answer with an LWS challenge, the storage from the challenge `realm` is
 * used. Solid `DPoP` challenges are ignored, so `.sai` requests can keep their
 * own session fetch.
 */
export function createLwsFetch(options: LwsFetchOptions): WhatwgFetch {
  if (!options.tokenSource && !options.subjectToken) {
    throw new Error('createLwsFetch needs a subjectToken or a tokenSource')
  }
  const baseFetch = options.fetch ?? fetch
  const renewalMargin = options.renewalMargin ?? 30_000
  const storages = new Set<string>(
    [...(options.storages ?? [])].map((storage) => normalizeStorage(storage))
  )
  const tokens = new Map<string, CachedToken>()
  const servers = new Map<string, LwsAuthorizationServer>()
  const pending = new Map<string, Promise<string | undefined>>()
  // `invalid_grant` means "this agent has no token for this storage": cache the
  // negative result briefly and send the request without credentials so public
  // resources still work. A stale token is a 401, not a reason to go anonymous.
  const noToken = new Map<string, number>()
  const noTokenTtl = 30_000

  /** Longest known storage that contains the URL. */
  function findStorage(url: string): string | undefined {
    let match: string | undefined
    for (const storage of storages) {
      if (url.startsWith(storage) && (!match || storage.length > match.length)) {
        match = storage
      }
    }
    return match
  }

  /** A known storage on the same server as a service path. */
  function findServiceStorage(url: string): string | undefined {
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return undefined
    }
    for (const storage of storages) {
      try {
        if (new URL(storage).origin === origin) {
          return storage
        }
      } catch {
        // not a valid storage URL
      }
    }
    return undefined
  }

  async function resolveServer(storage: string, challenge?: LwsChallenge) {
    const cached = servers.get(storage)
    // A challenge that only identifies the storage (realm/error) does not
    // point at a different authorization server: reuse the known one.
    if (cached && !challenge?.resourceMetadata && !challenge?.asUri) {
      return cached
    }
    const metadata = await discoverLwsAuthorizationServerMetadata(storage, baseFetch, challenge)
    servers.set(storage, metadata)
    return metadata
  }

  async function exchange(storage: string, challenge?: LwsChallenge): Promise<string | undefined> {
    const inFlight = pending.get(storage)
    if (inFlight) {
      return inFlight
    }
    const promise = (async (): Promise<string | undefined> => {
      const token = options.tokenSource
        ? await options.tokenSource(storage, challenge)
        : await exchangeLwsAccessToken({
            authorizationServer: await resolveServer(storage, challenge),
            resource: storage,
            subjectToken: await options.subjectToken!(),
            fetch: baseFetch,
          })
      if (!token) {
        noToken.set(storage, Date.now() + noTokenTtl)
        tokens.delete(storage)
        if (!storages.has(storage)) {
          storages.add(storage)
        }
        return undefined
      }
      noToken.delete(storage)
      tokens.set(storage, {
        accessToken: token.accessToken,
        expiresAt: Date.now() + Math.max(30_000, token.expiresIn * 1000 - renewalMargin),
      })
      if (!storages.has(storage)) {
        storages.add(storage)
      }
      return token.accessToken
    })()
    pending.set(storage, promise)
    try {
      return await promise
    } finally {
      pending.delete(storage)
    }
  }

  function denied(storage: string): boolean {
    const until = noToken.get(storage)
    if (until === undefined) {
      return false
    }
    if (until > Date.now()) {
      return true
    }
    noToken.delete(storage)
    return false
  }

  async function accessToken(
    storage: string,
    challenge?: LwsChallenge
  ): Promise<string | undefined> {
    const cached = tokens.get(storage)
    if (cached && cached.expiresAt > Date.now() && !challenge) {
      return cached.accessToken
    }
    if (denied(storage)) {
      return undefined
    }
    // Without a challenge, the authorization server of a storage that is not
    // its own base URL can not be discovered yet: send the request
    // unauthenticated first and use the challenge of its `401` response.
    if (!challenge && !servers.has(storage)) {
      return undefined
    }
    return exchange(storage, challenge)
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    // Keep an unused copy for the post-challenge retry: the body of `request`
    // is consumed by the first attempt.
    const retryable = request.clone()
    const url = request.url
    const known = findStorage(url)
    if (!known) {
      // Service paths (e.g. the Solid notification service) are not inside a
      // storage: use a token for a known storage on the same server, and fall
      // back to the challenge's realm for anything else.
      const serviceStorage = isServicePath(url) ? findServiceStorage(url) : undefined
      const serviceToken = serviceStorage ? await accessToken(serviceStorage) : undefined
      const response = await baseFetch(serviceToken ? withBearer(request, serviceToken) : request)
      if (response.status !== 401) {
        return response
      }
      const challenge = parseLwsChallenge(response.headers.get('www-authenticate'))
      if (!challenge?.realm && !challenge?.asUri && !challenge?.resourceMetadata) {
        return response
      }
      const storage = serviceStorage ?? normalizeStorage(challenge.realm ?? new URL(url).origin)
      if (serviceToken === undefined && denied(storage)) {
        return response
      }
      const token = await accessToken(storage, challenge)
      return baseFetch(token ? withBearer(retryable, token) : retryable)
    }

    const token = await accessToken(known)
    const response = await baseFetch(token ? withBearer(request, token) : request)
    if (response.status !== 401) {
      return response
    }
    const challenge = parseLwsChallenge(response.headers.get('www-authenticate'))
    if (!challenge?.realm && !challenge?.asUri && !challenge?.resourceMetadata) {
      return response
    }
    const storage = challenge.realm ? normalizeStorage(challenge.realm) : known
    if (denied(storage)) {
      return response
    }
    const renewed = await exchange(storage, challenge)
    return baseFetch(renewed ? withBearer(retryable, renewed) : retryable)
  }
}
