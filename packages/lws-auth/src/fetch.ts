import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import {
  createLwsFetch,
  discoverLwsAuthorizationServerMetadata,
  fetchLwsAuthorizationServerMetadata,
} from '@janeirodigital/interop-utils'

import type { LwsCredential } from './credential.ts'
import { jwtExpiresAt } from './jwt.ts'
import type { TokenEndpoint } from './tokens.ts'
import { LWS_TOKEN_PATH, requestAccessToken, requestIdJag } from './tokens.ts'

export interface LwsAuthFetchOptions {
  /** The user's authentication credential. */
  credential: LwsCredential
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

/**
 * `fetch` for LWS storages that goes through the **two-step** authorization
 * chain instead of exchanging the authentication credential directly:
 *
 * 1. `POST <uas>/.well-known/lws/token` — credential + DPoP proof → one ID-JAG
 *    per resource authorization server (`aud` = that server's issuer),
 * 2. `POST <storage>/.well-known/lws/token` — ID-JAG → bearer access token for
 *    the storage,
 * 3. the storage request, retried once on `401`.
 *
 * The ID-JAG cache is keyed by **resource authorization server**, not by
 * storage: `aud` makes a grant useless anywhere else, and several storages may
 * share one authorization server. Access tokens are cached per storage by
 * `createLwsFetch` itself (one token serves every request to that storage).
 *
 * `docs/plans/lws-auth.md` C3; the credential is never sent to a storage.
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
    if (cached) return cached
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

  /** The ID-JAG for one resource authorization server, minted at most once per lifetime. */
  async function idJag(audience: string): Promise<string> {
    const cached = grants.get(audience)
    if (cached && cached.expiresAt > now() + renewalMargin) return cached.token

    const inFlight = pendingGrants.get(audience)
    if (inFlight) return inFlight

    const promise = (async (): Promise<string> => {
      const token = await requestIdJag({
        uas: credential.issuer,
        tokenEndpoint: await uasTokenEndpoint(credential.issuer),
        audience,
        subjectToken: await credential.getSubjectToken(),
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
    pendingGrants.set(audience, promise)
    try {
      return await promise
    } finally {
      pendingGrants.delete(audience)
    }
  }

  return createLwsFetch({
    storages: options.storages,
    fetch: baseFetch,
    tokenSource: async (
      storage: string,
      challenge
    ): Promise<{ accessToken: string; expiresIn: number }> => {
      const metadata = await discoverLwsAuthorizationServerMetadata(storage, baseFetch, challenge)
      const ras: TokenEndpoint = { issuer: metadata.issuer, tokenEndpoint: metadata.tokenEndpoint }
      return requestAccessToken({
        ras,
        idJag: await idJag(ras.issuer),
        resource: storage,
        clientId: credential.clientId,
        fetch: tokenFetch,
      })
    },
  })
}
