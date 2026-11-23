import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { context, trace } from '@opentelemetry/api'
import * as oauth from 'oauth4webapi'

import { createDpopKeyPair, createDpopProof } from './dpop.ts'
import { decodeJwt, jwtExpiresAt } from './jwt.ts'
import type { KeyValueStore } from './store.ts'

const PENDING_KEY = 'lws-auth:pending'
const SESSION_KEY = 'lws-auth:session'
const DEFAULT_SCOPE = ['openid', 'webid']
const DEFAULT_RENEWAL_MARGIN = 30_000

export interface BrowserSessionOptions {
  /** Default OpenID provider, e.g. `https://auth.docker/` (a trailing slash is optional). */
  issuer: string
  /** Client identifier the app is registered under (`client_id`). */
  clientId: string
  /** The page the authorization code flow returns to. */
  redirectUrl: string
  /** Persists the pending flow and the session (IndexedDB in the browser, memory in tests). */
  store: KeyValueStore
  /**
   * Send DPoP proofs for the session access token. Defaults to `true`; set to
   * `false` to keep the flow on a bearer access token while DPoP is rolled out
   * one credential at a time. The LWS chain keeps its own DPoP binding either way.
   */
  dpop?: boolean
  /** Underlying fetch (discovery, token and resource requests). */
  fetch?: WhatwgFetch
  /** Scopes to request. Defaults to `openid webid` (+ `offline_access` when supported). */
  scope?: Array<string>
  /** Clock, injectable for tests. */
  now?: () => number
  /** Renew the access token this many milliseconds before it expires. Defaults to 30s. */
  renewalMargin?: number
}

export interface BrowserSessionInfo {
  issuer: string
  clientId: string
  webId: string
}

export interface BrowserSession {
  /** The issuer of the current session (the default one before login). */
  readonly issuer: string
  readonly clientId: string
  readonly webId: string | undefined
  /**
   * The client's single DPoP key pair. Non-extractable; the same one signs the
   * session token's proofs and the ID-JAG exchange.
   */
  readonly dpopKeyPair: CryptoKeyPair | undefined
  /** Whether session requests send DPoP proofs (see {@link BrowserSessionOptions.dpop}). */
  readonly dpop: boolean
  readonly isLoggedIn: boolean
  /**
   * The session's DPoP-bound access token, refreshed with the refresh token
   * when it is about to expire. It is the credential the app exchanges at its
   * authorization server for ID-JAGs, so it needs to be sender-constrained with
   * `cnf` (DPoP) or restricted to that server with `aud`.
   */
  accessToken(): Promise<string>
  /** Starts an authorization code flow and returns the URL to navigate to. */
  login(issuer?: string): Promise<string>
  /** Completes the flow from the redirect URL the provider sent the browser to. */
  handleRedirect(url: string): Promise<BrowserSessionInfo>
  /** Loads a stored session (refreshing it when needed). */
  restore(): Promise<BrowserSessionInfo | undefined>
  /** `fetch` that presents the session's DPoP-bound access token. */
  fetch: WhatwgFetch
  logout(): Promise<void>
}

interface PendingFlow {
  issuer: string
  clientId: string
  redirectUrl: string
  state: string
  codeVerifier: string
  nonce: string
  keyPair: CryptoKeyPair
}

interface StoredSession {
  issuer: string
  clientId: string
  webId: string
  keyPair: CryptoKeyPair
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

function normalizeIssuer(issuer: string): string {
  const url = new URL(issuer)
  url.search = ''
  url.hash = ''
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

function sessionInfo(session: StoredSession): BrowserSessionInfo {
  return { issuer: session.issuer, clientId: session.clientId, webId: session.webId }
}

/**
 * A Solid-OIDC browser session the LWS client owns end to end.
 *
 * One non-extractable DPoP key pair is generated when the flow starts and is
 * used for everything afterwards: the authorization code token request, the
 * session's `.sai` requests and the ID-JAG exchange at the UAS. The access
 * token it obtains is the app's LWS authentication credential, so the UAS
 * verifies possession of the same key instead of trusting a bearer token.
 *
 * No third-party session library is involved: `oauth4webapi` runs the
 * authorization code + PKCE flow, and {@link createDpopProof} signs resource
 * requests.
 */
export function createBrowserSession(options: BrowserSessionOptions): BrowserSession {
  const baseFetch = options.fetch ?? (globalThis.fetch as WhatwgFetch)
  const now = options.now ?? (() => Date.now())
  const dpop = options.dpop ?? true
  const renewalMargin = options.renewalMargin ?? DEFAULT_RENEWAL_MARGIN
  const defaultIssuer = normalizeIssuer(options.issuer)
  const clientId = options.clientId

  const metadata = new Map<string, oauth.AuthorizationServer>()
  let current: StoredSession | undefined
  let pending: PendingFlow | undefined
  let loading: Promise<StoredSession | undefined> | undefined

  function client(): oauth.Client {
    return { client_id: clientId }
  }

  function dpopHandle(keyPair: CryptoKeyPair): oauth.DPoPHandle {
    const dpopClient: oauth.Client = { client_id: clientId }
    return oauth.DPoP(dpopClient, keyPair)
  }

  function dpopRequest(keyPair: CryptoKeyPair): oauth.TokenEndpointRequestOptions | undefined {
    if (!dpop) {
      return undefined
    }
    return { DPoP: dpopHandle(keyPair) }
  }

  async function discover(issuer: string): Promise<oauth.AuthorizationServer> {
    const cached = metadata.get(issuer)
    if (cached) {
      return cached
    }
    const response = await oauth.discoveryRequest(new URL(issuer), {
      [oauth.customFetch]: baseFetch as typeof globalThis.fetch,
    })
    const server = await oauth.processDiscoveryResponse(new URL(issuer), response)
    metadata.set(issuer, server)
    return server
  }

  function scopeOf(server: oauth.AuthorizationServer): string {
    if (options.scope) {
      return options.scope.join(' ')
    }
    const scope = [...DEFAULT_SCOPE]
    if (server.scopes_supported?.includes('offline_access')) {
      scope.push('offline_access')
    }
    return scope.join(' ')
  }

  function expiresAt(tokens: oauth.TokenEndpointResponse): number {
    if (typeof tokens.expires_in === 'number') {
      return now() + tokens.expires_in * 1000
    }
    return jwtExpiresAt(tokens.access_token) ?? now() + 300_000
  }

  async function persist(session: StoredSession | undefined): Promise<void> {
    current = session
    if (session) {
      await options.store.set(SESSION_KEY, session)
    } else {
      await options.store.delete(SESSION_KEY)
    }
  }

  async function load(): Promise<StoredSession | undefined> {
    if (current) {
      return current
    }
    loading ??= options.store.get<StoredSession>(SESSION_KEY).then((stored) => {
      current = stored
      loading = undefined
      return stored
    })
    return loading
  }

  async function refresh(session: StoredSession): Promise<StoredSession> {
    if (!session.refreshToken) {
      throw new Error('the session has no refresh token')
    }
    const server = await discover(session.issuer)
    const response = await oauth.refreshTokenGrantRequest(
      server,
      client(),
      oauth.None(),
      session.refreshToken,
      dpopRequest(session.keyPair)
    )
    const tokens = await oauth.processRefreshTokenResponse(server, client(), response)
    const updated: StoredSession = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: expiresAt(tokens),
    }
    await persist(updated)
    return updated
  }

  /** The session's access token, refreshed when it is about to expire. */
  async function accessToken(): Promise<string> {
    const session = await load()
    if (!session) {
      throw new Error('not signed in: there is no session access token')
    }
    if (session.expiresAt - renewalMargin > now()) {
      return session.accessToken
    }
    return (await refresh(session)).accessToken
  }

  async function login(issuer = defaultIssuer): Promise<string> {
    const issuerId = normalizeIssuer(issuer)
    const server = await discover(issuerId)
    if (!server.authorization_endpoint) {
      throw new Error(`${issuerId} does not advertise an authorization endpoint`)
    }

    // The one key pair for this session: token requests, `.sai` and the
    // ID-JAG exchange all use it (and it never leaves WebCrypto).
    const keyPair = await createDpopKeyPair(false)
    const codeVerifier = oauth.generateRandomCodeVerifier()
    const state = oauth.generateRandomState()
    const nonce = oauth.generateRandomNonce()

    const url = new URL(server.authorization_endpoint)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', options.redirectUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopeOf(server))
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    if (dpop) {
      url.searchParams.set('dpop_jkt', await dpopHandle(keyPair).calculateThumbprint())
    }

    const flow: PendingFlow = {
      issuer: issuerId,
      clientId,
      redirectUrl: options.redirectUrl,
      state,
      codeVerifier,
      nonce,
      keyPair,
    }
    pending = flow
    await options.store.set(PENDING_KEY, flow)
    return url.href
  }

  async function handleRedirect(url: string): Promise<BrowserSessionInfo> {
    const flow = pending ?? (await options.store.get<PendingFlow>(PENDING_KEY))
    if (!flow) {
      throw new Error('there is no pending authorization code flow')
    }
    const server = await discover(flow.issuer)
    const flowClient: oauth.Client = { client_id: flow.clientId }

    const parameters = oauth.validateAuthResponse(server, flowClient, new URL(url), flow.state)
    const response = await oauth.authorizationCodeGrantRequest(
      server,
      flowClient,
      oauth.None(),
      parameters,
      flow.redirectUrl,
      flow.codeVerifier,
      dpop ? { DPoP: oauth.DPoP(flowClient, flow.keyPair) } : undefined
    )
    const tokens = await oauth.processAuthorizationCodeResponse(server, flowClient, response, {
      expectedNonce: flow.nonce,
      requireIdToken: true,
    })

    const claims = oauth.getValidatedIdTokenClaims(tokens)
    const accessClaims = decodeJwt(tokens.access_token).claims
    const webId = [claims?.webid, claims?.sub, accessClaims.webid, accessClaims.sub].find(
      (candidate): candidate is string => typeof candidate === 'string'
    )
    if (!webId) {
      throw new Error('the token response does not identify a WebID')
    }

    const session: StoredSession = {
      issuer: flow.issuer,
      clientId: flow.clientId,
      webId,
      keyPair: flow.keyPair,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresAt(tokens),
    }
    await persist(session)
    pending = undefined
    await options.store.delete(PENDING_KEY)
    return sessionInfo(session)
  }

  async function restore(): Promise<BrowserSessionInfo | undefined> {
    let session: StoredSession | undefined
    try {
      session = await load()
    } catch {
      return undefined
    }
    if (!session) {
      return undefined
    }
    if (session.expiresAt - renewalMargin > now()) {
      return sessionInfo(session)
    }
    try {
      return sessionInfo(await refresh(session))
    } catch {
      await persist(undefined)
      return undefined
    }
  }

  const sessionFetch: WhatwgFetch = async (input, init) => {
    // Capture the caller's span (the storage request's `sai.lws.*` root) before
    // the first await; async context is not preserved by StackContextManager.
    const activeSpan = trace.getSpan(context.active())
    const token = await accessToken()
    const request = new Request(input, init)
    // The body (if any) has to be reusable for the refreshed retry.
    const retry = request.clone()
    const keyPair = current?.keyPair
    if (!keyPair) {
      throw new Error('not signed in: there is no session DPoP key pair')
    }

    const send = async (attempt: Request, credential: string): Promise<Response> => {
      const headers = new Headers(attempt.headers)
      if (dpop) {
        headers.set('authorization', `DPoP ${credential}`)
        headers.set(
          'dpop',
          await createDpopProof({
            method: attempt.method,
            url: attempt.url,
            keyPair,
            accessToken: credential,
            now,
          })
        )
      } else {
        headers.set('authorization', `Bearer ${credential}`)
      }
      const requestWithHeaders = new Request(attempt, { headers })
      return activeSpan
        ? context.with(trace.setSpan(context.active(), activeSpan), () =>
            baseFetch(requestWithHeaders)
          )
        : baseFetch(requestWithHeaders)
    }

    const response = await send(request, token)
    if (response.status !== 401 || !current?.refreshToken) {
      return response
    }
    const refreshed = await refresh(current).catch(() => undefined)
    return refreshed ? send(retry, refreshed.accessToken) : response
  }

  async function logout(): Promise<void> {
    current = undefined
    pending = undefined
    await options.store.delete(SESSION_KEY)
    await options.store.delete(PENDING_KEY)
  }

  return {
    get issuer() {
      return current?.issuer ?? defaultIssuer
    },
    clientId,
    get webId() {
      return current?.webId
    },
    get dpopKeyPair() {
      return current?.keyPair ?? pending?.keyPair
    },
    get dpop() {
      return dpop
    },
    get isLoggedIn() {
      return current !== undefined
    },
    accessToken,
    login,
    handleRedirect,
    restore,
    fetch: sessionFetch,
    logout,
  }
}
