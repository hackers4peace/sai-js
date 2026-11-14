import {
  type WhatwgFetch,
  setBodyAttribute,
  setTokenAttributes,
  withSpan,
} from '@janeirodigital/interop-utils'

import type { LwsCredential } from './credential.ts'
import { createDpopKeyPair, dpopThumbprint } from './dpop.ts'
import type { LwsAuthFetchOptions } from './fetch.ts'
import { createLwsAuthFetch } from './fetch.ts'
import { jwtExpiresAt } from './jwt.ts'

/** Path of the UAS endpoint that mints the DPoP-bound self-issued credential. */
export const ID_TOKEN_PATH = '.sai/id-token'

export interface BrowserCredentialOptions {
  /** The user's authorization server, e.g. `https://auth.docker/` (the token's `iss`). */
  issuer: string
  /** Client identifier the grants and access tokens name (`client_id`). */
  clientId: string
  /**
   * Fetch used for the mint request. It has to carry the user's session — the
   * Solid-OIDC DPoP fetch of the app, or the browser's cookies.
   */
  credentialFetch?: WhatwgFetch
  /**
   * Send `dpop_jkt` on the mint request. Defaults to `true`; set it to `false`
   * when `credentialFetch` already proves possession with the credential's key,
   * so the UAS takes the binding from the `DPoP` proof (RFC 9449 §10.1).
   */
  declareDpopJkt?: boolean
  /** Existing key pair, e.g. the browser session's. A fresh non-extractable one is generated otherwise. */
  keyPair?: CryptoKeyPair
  /** Renew the credential this many milliseconds before it expires. Defaults to 30s. */
  renewalMargin?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export interface BrowserCredential extends LwsCredential {
  /** The `cnf.jkt` the credential is bound to. */
  readonly dpopJkt: string
  /** Mints a new credential now (also used implicitly when the cached one ages out). */
  refresh(): Promise<string>
}

/**
 * The browser half of the LWS chain: a DPoP-bound credential for the session
 * that `auth` mints over `/.sai/id-token`, plus the key that proves possession
 * of it at the token endpoint.
 *
 * Pass the session's `dpopKeyPair` so the mint request and the ID-JAG exchange
 * use the same key; otherwise a fresh key is generated for this page (the token
 * caches are per page anyway).
 */
export async function createBrowserCredential(
  options: BrowserCredentialOptions
): Promise<BrowserCredential> {
  const keyPair = options.keyPair ?? (await createDpopKeyPair())
  const dpopJkt = await dpopThumbprint(keyPair.publicKey)
  const credentialFetch = options.credentialFetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const renewalMargin = options.renewalMargin ?? 30_000
  const endpoint = new URL(ID_TOKEN_PATH, options.issuer)

  let cached: { token: string; expiresAt: number } | undefined
  let pending: Promise<string> | undefined

  async function refresh(): Promise<string> {
    const url = new URL(endpoint)
    const declareDpopJkt = options.declareDpopJkt ?? true
    // The proof is authoritative at the UAS; the parameter is only the
    // fallback for a session that cannot send one (bearer or cookies).
    if (declareDpopJkt) url.searchParams.set('dpop_jkt', dpopJkt)
    url.searchParams.set('client_id', options.clientId)

    // Client half of the server's `sai.lws.issue-id-token` span; with browser
    // tracing on, the fetch instrumentation's HTTP span and the UAS span carry
    // this span's `traceparent`.
    return withSpan('sai-lws', 'sai.lws.request-id-token', async (span): Promise<string> => {
      span.setAttributes({
        'sai.lws.issuer': options.issuer,
        'sai.lws.client_id': options.clientId,
        'sai.lws.dpop_jkt': dpopJkt,
        'sai.lws.dpop_jkt_source': declareDpopJkt ? 'query' : 'proof',
      })
      const response = await credentialFetch(url.href, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw new Error(`failed to obtain an ID token from ${options.issuer}: ${response.status}`)
      }
      const body = (await response.json()) as { id_token?: string; expires_in?: number }
      if (typeof body.id_token !== 'string') {
        throw new Error(`the ID token response of ${options.issuer} carries no id_token`)
      }
      cached = {
        token: body.id_token,
        expiresAt: jwtExpiresAt(body.id_token) ?? now() + (body.expires_in ?? 300) * 1000,
      }
      setTokenAttributes(span, 'subject', body.id_token)
      setBodyAttribute(span, 'sai.lws.response.body', JSON.stringify(body))
      return body.id_token
    })
  }

  async function getSubjectToken(): Promise<string> {
    if (cached && cached.expiresAt > now() + renewalMargin) return cached.token
    pending ??= refresh().finally(() => {
      pending = undefined
    })
    return pending
  }

  return {
    issuer: options.issuer,
    clientId: options.clientId,
    dpopKeyPair: keyPair,
    dpopJkt,
    getSubjectToken,
    refresh,
  }
}

export interface BrowserLwsFetchOptions extends Omit<LwsAuthFetchOptions, 'credential'> {
  /** The user's authorization server, e.g. `https://auth.docker/`. */
  issuer: string
  /** Client identifier the grants and access tokens name. */
  clientId: string
  /** Fetch that carries the user's session for the mint request. */
  credentialFetch?: WhatwgFetch
  /** Send `dpop_jkt` on the mint request (see {@link BrowserCredentialOptions}). */
  declareDpopJkt?: boolean
  /** Existing DPoP key pair (see {@link createBrowserCredential}). */
  keyPair?: CryptoKeyPair
}

/**
 * `fetch` for LWS storages in the browser: mints the DPoP-bound credential for
 * the session, then runs the two-step chain (ID token → ID-JAG per storage AS →
 * access token). Requests to the UAS itself must not go through it — the caller
 * keeps the Solid-OIDC session fetch for those.
 */
export async function createBrowserLwsFetch(options: BrowserLwsFetchOptions): Promise<WhatwgFetch> {
  const { issuer, clientId, credentialFetch, declareDpopJkt, keyPair, ...fetchOptions } = options
  const credential = await createBrowserCredential({
    issuer,
    clientId,
    credentialFetch,
    declareDpopJkt,
    keyPair,
  })
  return createLwsAuthFetch({ ...fetchOptions, credential })
}
