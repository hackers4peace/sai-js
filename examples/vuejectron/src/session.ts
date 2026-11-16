import { type BrowserSession, createBrowserSession, indexedDbStore } from '@elfpavlik/lws-auth'

import { getRuntimeConfig } from '@/runtime-config'

let cached: BrowserSession | undefined

/**
 * The app's Solid-OIDC session.
 *
 * One non-extractable DPoP key pair per session, owned by the app (no inrupt):
 * it signs the session's `.sai` requests, the access token's `cnf.jkt` and the
 * ID-JAG exchange at the UAS. The key is kept in IndexedDB so it survives the
 * authorization code redirect and reloads.
 */
export function browserSession(): BrowserSession {
  if (cached) return cached
  const config = getRuntimeConfig()
  cached = createBrowserSession({
    issuer: config.defaultOidcIssuer,
    clientId: config.clientId,
    redirectUrl: `${config.baseUrl}/redirect`,
    store: indexedDbStore(),
  })
  return cached
}
