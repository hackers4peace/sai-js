import type {
  LwsAuthFetchOptions,
  LwsImpersonationOptions,
  SelfIssuedCredential,
} from '@elfpavlik/lws-auth'
import { createIdJagFetch, createLwsAuthFetch } from '@elfpavlik/lws-auth'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

import { EnvJwkGenerator } from '../EnvJwkGenerator.js'
import { SaiSession } from '../SaiSession.js'
import { SessionManager } from '../SessionManager.js'
import { createSelfIssuedCredentialWithJwk } from '../util/selfIssuedCredential.js'
import { agentId } from '../util/uriTemplates.js'
import { saiAudience } from '../util/url.js'

export function buildSessionManager(): SessionManager {
  const jwkGenerator = new EnvJwkGenerator(process.env.CSS_ENCODED_PRIVATE_JWK)
  return new SessionManager(process.env.CSS_BASE_URL, jwkGenerator, process.env.CSS_REG_ORIGIN, 60)
}

interface BuiltCredential {
  /** The self-issued, DPoP-bound credential of the agent's own UAS. */
  credential: SelfIssuedCredential
  dpopKeyPair: CryptoKeyPair
  /** The credential's `iss` — the user's authorization server (UAS). */
  issuer: string
  /** The credential's `azp`/`client_id`. */
  clientId: string
}

/**
 * The self-issued session credential plus its DPoP key pair — the pairing
 * `SessionManager` uses: the credential is the LWS subject token, and the key
 * pair signs both the token's `cnf` and the proof at the token endpoint.
 *
 * Exported because callers that do the token exchange themselves (the LWS
 * `packages/lws-auth` flow, `/test` `lws-auth.test.ts`) need both halves: the
 * credential and the key that proves possession of it at the UAS.
 */
async function buildCredential(
  webid: string,
  clientId?: string,
  expiration = 60
): Promise<BuiltCredential> {
  const baseUrl = process.env.CSS_BASE_URL
  const jwkGenerator = new EnvJwkGenerator(process.env.CSS_ENCODED_PRIVATE_JWK)
  const resolvedClientId = clientId ?? agentId(webid)

  const credential = await createSelfIssuedCredentialWithJwk({
    issuer: baseUrl,
    subject: webid,
    clientId: resolvedClientId,
    jwkGenerator,
    // `expiration` is in minutes, the token lifetime in seconds.
    lifetime: expiration * 60,
  })

  return {
    credential,
    dpopKeyPair: credential.dpopKeyPair,
    issuer: baseUrl,
    clientId: resolvedClientId,
  }
}

function createSession(
  credential: SelfIssuedCredential,
  storageFetch = createLwsAuthFetch({ credential })
): SaiSession {
  return new SaiSession(
    credential,
    createIdJagFetch({ credential, audience: saiAudience }),
    storageFetch
  )
}

export async function buildSelfIssuedCredential(
  webid: string,
  clientId?: string,
  expiration = 60
): Promise<
  BuiltCredential & {
    /** The `.sai` session (compatibility name: the credential used to be a session). */
    oidc: SaiSession
    /** The `.sai` session. */
    session: SaiSession
  }
> {
  const built = await buildCredential(webid, clientId, expiration)
  const session = createSession(built.credential)
  // `oidc` stays as an alias until the callers migrate to `session`.
  return { ...built, oidc: session, session }
}

/** The `.sai` session of `webid`; kept as an alias for the former OIDC session. */
export async function buildOidcSession(
  webid: string,
  clientId?: string,
  expiration = 60
): Promise<SaiSession> {
  return (await buildSelfIssuedCredential(webid, clientId, expiration)).session
}

/** The `.sai` session of `webid`. */
export async function buildSaiSession(
  webid: string,
  clientId?: string,
  expiration = 60
): Promise<SaiSession> {
  return buildOidcSession(webid, clientId, expiration)
}

export interface BuildLwsFetchOptions {
  /** C2 impersonation: the UAS that re-issues the ID-JAG under the visible identity. */
  impersonation?: LwsImpersonationOptions
  /** Optional ODRL access claim source (C1/C2). */
  accessClaim?: LwsAuthFetchOptions['accessClaim']
}

/**
 * The LWS storage fetch for `webid` — the storage-facing counterpart of
 * `buildOidcSession(...).authFetch`. Data and registry storages accept only
 * LWS access tokens, so every request obtains one; `clientId` becomes the ID
 * token's `azp`, i.e. the LWS token's `client_id`, so callers can exercise
 * agent/client combinations the way the real clients do.
 *
 * Every storage request goes through the two-step ID-JAG chain in
 * `@elfpavlik/lws-auth`: the credential is exchanged at the user's authorization
 * server for one ID-JAG per storage authorization server, and each storage
 * trades its grant for an access token. See `openwiki/architecture/lws-auth.md`.
 */
export async function buildLwsFetch(
  webid: string,
  clientId?: string,
  options: BuildLwsFetchOptions = {}
): Promise<WhatwgFetch> {
  const { credential } = await buildCredential(webid, clientId)
  return createLwsAuthFetch({
    credential,
    ...(options.accessClaim ? { accessClaim: options.accessClaim } : {}),
    ...(options.impersonation ? { impersonation: options.impersonation } : {}),
  })
}
