import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import {
  createLwsFetch,
  discoverLwsAuthorizationServerMetadata,
  fetchLwsAuthorizationServerMetadata,
} from '@janeirodigital/interop-utils'

import type { LwsCredential } from './credential.ts'
import { jwtExpiresAt } from './jwt.ts'
import type { TokenEndpoint } from './tokens.ts'
import { ID_JAG_TOKEN_TYPE, LWS_TOKEN_PATH, requestAccessToken, requestIdJag } from './tokens.ts'

export interface LwsImpersonationOptions {
  /** The UAS that re-issues the ID-JAG at the next hop. */
  uas: string
  /** Its token endpoint; defaults to `<uas>/.well-known/lws/token`. */
  tokenEndpoint?: string
}

export interface LwsAuthFetchOptions {
  /** The user's authentication credential. */
  credential: LwsCredential
  /**
   * C2 impersonation chain: first self-issue an ID-JAG for this UAS, then use
   * that UAS's re-issued ID-JAG (visible subject, hidden caller) for the
   * storage. The UAS is responsible for the claim rewrite and hiding.
   */
  impersonation?: LwsImpersonationOptions
  /**
   * Optional source of the ODRL `access` claim for a storage. It receives the
   * storage (the `resource` of the final exchange) and the resource
   * authorization server issuer. Because one ID-JAG carries a claim for exactly
   * one storage, the cache is keyed per `(authorization server, storage)` when
   * this is set.
   */
  accessClaim?: (storage: string, authorizationServer: string) => Promise<unknown> | unknown
  /**
   * Storages the session knows about. Requests to them are authenticated before
   * the first `401`; unknown URLs are authenticated after a challenge.
   */
  storages?: Iterable<string>
  /** Underlying fetch for the storage requests and the discovery documents. */
  fetch?: WhatwgFetch
  /** Underlying fetch for the token requests (tests inject a fake). */
  tokenFetch?: WhatwgFetch
  /** Renew an ID-JAG this many milliseconds before it expires. Defaults to 30s. */
  renewalMargin?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

interface CachedGrant {
  token: string
  expiresAt: number
}

/** A request with a Bearer token, keeping every other header. */
function withBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers)
  headers.set('authorization', `Bearer ${token}`)
  return new Request(request, { headers })
}

/** An OAuth error response with `error: invalid_grant`. */
function isInvalidGrant(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { error?: unknown }).error === 'invalid_grant'
  )
}

/**
 * `fetch` for LWS storages that goes through the **two-step** authorization
 * chain instead of exchanging the authentication credential directly:
 *
 * 1. `POST <uas>/.well-known/lws/token` — the user's DPoP-bound access token
 *    (or an incoming ID-JAG at an impersonation hop) + DPoP proof → one ID-JAG
 *    per resource authorization server (`aud` = that server's issuer),
 * 2. `POST <storage>/.well-known/lws/token` — ID-JAG → bearer access token for
 *    the storage (a bearer grant exchange, no DPoP proof),
 * 3. the storage request, retried once on `401`.
 *
 * The UAS derives the claim from the user's grants for the requested storage,
 * so the ID-JAG cache is keyed by `(issuer, storage)` (and the impersonation
 * UAS when present): one claim binds the grant to one storage. Access tokens
 * are cached per storage by `createLwsFetch` itself (one token serves every
 * request to that storage).
 *
 * See `openwiki/architecture/lws-auth.md`; the credential is never sent to a storage.
 */
export function createLwsAuthFetch(options: LwsAuthFetchOptions): WhatwgFetch {
  const { credential } = options
  const baseFetch = options.fetch ?? fetch
  const tokenFetch = options.tokenFetch ?? baseFetch
  const now = options.now ?? (() => Date.now())
  const renewalMargin = options.renewalMargin ?? 30_000

  const grants = new Map<string, CachedGrant>()
  const pendingGrants = new Map<string, Promise<string>>()
  const tokenEndpoints = new Map<string, string>()

  /** The UAS token endpoint: LWS metadata when advertised, the well-known path otherwise. */
  async function uasTokenEndpoint(uas: string): Promise<string> {
    const cached = tokenEndpoints.get(uas)
    if (cached) {
      return cached
    }
    let endpoint: string
    try {
      const metadata = await fetchLwsAuthorizationServerMetadata(uas, baseFetch)
      endpoint = metadata?.tokenEndpoint ?? new URL(LWS_TOKEN_PATH, uas).href
    } catch {
      endpoint = new URL(LWS_TOKEN_PATH, uas).href
    }
    tokenEndpoints.set(uas, endpoint)
    return endpoint
  }

  /**
   * The ID-JAG for one resource authorization server (and, for an access-claim
   * chain, one storage), minted at most once per lifetime. The ID-JAG itself
   * has no `resource` claim; its ODRL target is what binds it to the storage.
   */
  async function idJag(audience: string, storage: string): Promise<string> {
    const key = `${audience}\n${storage}\n${options.impersonation?.uas ?? ''}`
    const cached = grants.get(key)
    if (cached && cached.expiresAt > now() + renewalMargin) {
      return cached.token
    }

    const inFlight = pendingGrants.get(key)
    if (inFlight) {
      return inFlight
    }

    const promise = (async (): Promise<string> => {
      const firstAudience = options.impersonation?.uas ?? audience
      let token = await requestIdJag({
        uas: credential.issuer,
        tokenEndpoint: await uasTokenEndpoint(credential.issuer),
        audience: firstAudience,
        resource: storage,
        subjectToken: await credential.getSubjectToken(),
        subjectTokenType: credential.subjectTokenType,
        clientId: credential.clientId,
        dpopKeyPair: credential.dpopKeyPair,
        accessClaim: await options.accessClaim?.(storage, audience),
        fetch: tokenFetch,
      })

      if (options.impersonation) {
        // The intermediate UAS verifies the self-issued ID-JAG, rewrites the
        // claim to the visible actor, and issues the ID-JAG for the storage AS.
        token = await requestIdJag({
          uas: options.impersonation.uas,
          tokenEndpoint: options.impersonation.tokenEndpoint,
          audience,
          resource: storage,
          subjectToken: token,
          subjectTokenType: ID_JAG_TOKEN_TYPE,
          clientId: credential.clientId,
          dpopKeyPair: credential.dpopKeyPair,
          fetch: tokenFetch,
        })
      }

      grants.set(key, {
        token,
        expiresAt: jwtExpiresAt(token) ?? now() + 300_000,
      })
      return token
    })()
    pendingGrants.set(key, promise)
    try {
      return await promise
    } finally {
      pendingGrants.delete(key)
    }
  }

  return createLwsFetch({
    storages: options.storages,
    fetch: baseFetch,
    tokenSource: async (
      storage: string,
      challenge
    ): Promise<{ accessToken: string; expiresIn: number } | undefined> => {
      const metadata = await discoverLwsAuthorizationServerMetadata(storage, baseFetch, challenge)
      const ras: TokenEndpoint = { issuer: metadata.issuer, tokenEndpoint: metadata.tokenEndpoint }
      try {
        return await requestAccessToken({
          ras,
          idJag: await idJag(ras.issuer, storage),
          resource: storage,
          clientId: credential.clientId,
          fetch: tokenFetch,
        })
      } catch (error: unknown) {
        // A storage `invalid_grant` means "no token for this storage", not a
        // crash: the request is retried without Authorization, so public data
        // still works. An expired/invalid access token is still a 401.
        if (isInvalidGrant(error)) {
          return undefined
        }
        throw error
      }
    },
  })
}

export interface IdJagFetchOptions {
  /** The user's authentication credential. */
  credential: LwsCredential
  /**
   * Resolve the ID-JAG audience for a request URL.
   * - the full request URL for one-time `.sai` interactions
   * - the target UAS base URL for `/.sai/agents/*`
   */
  audience: string | ((requestUrl: string) => string)
  /** Underlying fetch for the `.sai` requests. */
  fetch?: WhatwgFetch
  /** Underlying fetch for the token requests (tests inject a fake). */
  tokenFetch?: WhatwgFetch
  /** Renew an ID-JAG this many milliseconds before it expires. Defaults to 30s. */
  renewalMargin?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

/**
 * `fetch` that authenticates `.sai` requests with an **ID-JAG** instead of the
 * DPoP-bound authentication credential.
 *
 * The DPoP credential is only presented to the user's UAS in the token
 * exchange that mints the ID-JAG; the `.sai` request itself carries the
 * resulting audience-constrained grant as a plain Bearer token. The grant has
 * no `resource` claim: it is identity-only.
 *
 * One grant is cached per resolved audience until shortly before it expires.
 * A `401` response discards the cached grant, mints a fresh one and retries the
 * request once (the body is cloned for the retry).
 */
export function createIdJagFetch(options: IdJagFetchOptions): WhatwgFetch {
  const { credential } = options
  const baseFetch = options.fetch ?? globalThis.fetch
  const tokenFetch = options.tokenFetch ?? baseFetch
  const now = options.now ?? (() => Date.now())
  const renewalMargin = options.renewalMargin ?? 30_000
  const resolveAudience: (requestUrl: string) => string =
    typeof options.audience === 'string' ? () => String(options.audience) : options.audience

  const grants = new Map<string, CachedGrant>()
  const pending = new Map<string, Promise<string>>()

  async function idJag(audience: string): Promise<string> {
    const cached = grants.get(audience)
    if (cached && cached.expiresAt > now() + renewalMargin) {
      return cached.token
    }

    const inFlight = pending.get(audience)
    if (inFlight) {
      return inFlight
    }

    const promise = (async (): Promise<string> => {
      const token = await requestIdJag({
        uas: credential.issuer,
        audience,
        // The `.sai` grant is identity-only: no resource and no access claim.
        subjectToken: await credential.getSubjectToken(),
        subjectTokenType: credential.subjectTokenType,
        clientId: credential.clientId,
        dpopKeyPair: credential.dpopKeyPair,
        fetch: tokenFetch,
      })
      grants.set(audience, {
        token,
        expiresAt: jwtExpiresAt(token) ?? now() + 300_000,
      })
      return token
    })()
    pending.set(audience, promise)
    try {
      return await promise
    } finally {
      pending.delete(audience)
    }
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    // Keep an unused copy for the post-challenge retry: the body of `request`
    // is consumed by the first attempt.
    const retry = request.clone()
    const audience = resolveAudience(request.url)

    const token = await idJag(audience)
    const response = await baseFetch(withBearer(request, token))
    if (response.status !== 401) {
      return response
    }

    // The grant may have been rejected because it expired or was revoked:
    // mint a fresh one instead of reusing the cached token.
    grants.delete(audience)
    pending.delete(audience)
    const fresh = await idJag(audience)
    return baseFetch(withBearer(retry, fresh))
  }
}
