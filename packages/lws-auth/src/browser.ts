import type { WhatwgFetch } from '@janeirodigital/interop-utils'

import type { LwsCredential } from './credential.ts'
import { dpopThumbprint } from './dpop.ts'
import type { LwsAuthFetchOptions } from './fetch.ts'
import { createLwsAuthFetch } from './fetch.ts'
import type { BrowserSession } from './session.ts'
import { ACCESS_TOKEN_TYPE } from './tokens.ts'

export interface BrowserCredential extends LwsCredential {
  /** The `cnf.jkt` the session access token is bound to. */
  readonly dpopJkt: string
}

/**
 * The browser's LWS authentication credential: the **access token of its own
 * Solid-OIDC session**, which the OpenID provider of the user's authorization
 * server issues with `cnf.jkt` (DPoP) and — in LWS deployments — an `aud` that
 * includes that authorization server (`iss` and `aud` are the same identifier).
 *
 * `createBrowserSession` already holds the token and refreshes it with its
 * refresh token, so no credential endpoint is involved: the browser sends the
 * token as a `…:access_token` subject token to the UAS, which enforces the
 * `cnf` claim against the `DPoP` proof of the ID-JAG request. A leaked token is
 * useless without the session's non-extractable key pair, and the token's
 * audience keeps it from being replayed at another authorization server.
 *
 * The alternative — an unbound ID token — would be exchangeable by anyone who
 * obtains it, since a regular ID token only has the client as audience.
 */
export async function createBrowserCredential(session: BrowserSession): Promise<BrowserCredential> {
  const dpopKeyPair = session.dpopKeyPair
  if (!dpopKeyPair) {
    throw new Error('the session has no DPoP key pair: sign in before creating a credential')
  }
  return {
    issuer: session.issuer,
    clientId: session.clientId,
    dpopKeyPair,
    subjectTokenType: ACCESS_TOKEN_TYPE,
    dpopJkt: await dpopThumbprint(dpopKeyPair.publicKey),
    getSubjectToken: () => session.accessToken(),
  }
}

export interface BrowserLwsFetchOptions extends Omit<LwsAuthFetchOptions, 'credential'> {
  /** The Solid-OIDC session the app already holds (see {@link createBrowserSession}). */
  session: BrowserSession
}

/**
 * `fetch` for LWS storages in the browser: walks the two-step chain
 * (`session access token` → ID-JAG per resource authorization server →
 * access token for the storage) with the session's single DPoP key pair.
 *
 * The session's own `fetch` must not be used for the storages: the session
 * access token is only meant for its UAS (it is the first leg's subject token),
 * while the storages accept the LWS access token that the chain derives.
 */
export async function createBrowserLwsFetch(options: BrowserLwsFetchOptions): Promise<WhatwgFetch> {
  const { session, ...fetchOptions } = options
  return createLwsAuthFetch({ ...fetchOptions, credential: await createBrowserCredential(session) })
}
