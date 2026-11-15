import type {
  LwsAuthFetchOptions,
  LwsCredential,
  LwsImpersonationOptions,
} from '@elfpavlik/lws-auth'
import { createLwsAuthFetch } from '@elfpavlik/lws-auth'
import { createLwsFetch, type WhatwgFetch } from '@janeirodigital/interop-utils'
import { type GenerateKeyPairResult, generateKeyPair } from 'jose'

import { EnvJwkGenerator } from '../EnvJwkGenerator.js'
import { SelfIssuedSession } from '../SelfIssuedSession.js'
import { SessionManager } from '../SessionManager.js'
import { agentId } from '../util/uriTemplates.js'

export function buildSessionManager(): SessionManager {
  const jwkGenerator = new EnvJwkGenerator(process.env.CSS_ENCODED_PRIVATE_JWK)
  return new SessionManager(process.env.CSS_BASE_URL, jwkGenerator, process.env.CSS_REG_ORIGIN, 60)
}

/**
 * The self-issued session plus its DPoP key pair — the pairing `SessionManager`
 * uses: the ID token is the LWS subject token, and the key pair signs both the
 * token's `cnf` and the proof at the token endpoint.
 *
 * Exported because callers that do the token exchange themselves (the LWS
 * `packages/lws-auth` flow, `/test` `lws-auth.test.ts`) need both halves: the
 * credential and the key that proves possession of it at the UAS.
 */
export async function buildSelfIssuedCredential(
  webid: string,
  clientId?: string,
  expiration = 60
): Promise<{
  oidc: SelfIssuedSession
  dpopKeyPair: GenerateKeyPairResult
  /** The credential's `iss` — the user's authorization server (UAS). */
  issuer: string
  /** The credential's `azp`/`client_id`. */
  clientId: string
}> {
  const baseUrl = process.env.CSS_BASE_URL

  const jwkGenerator = new EnvJwkGenerator(process.env.CSS_ENCODED_PRIVATE_JWK)

  const privateKey = await jwkGenerator.getPrivateKey()
  const publicKey = await jwkGenerator.getPublicKey()

  const dpopKeyPair = await generateKeyPair('ES256')
  const resolvedClientId = clientId ?? agentId(webid)

  const oidc = new SelfIssuedSession({
    webid,
    clientId: resolvedClientId,
    issuer: baseUrl,
    expiresIn: expiration * 60 * 1000,
    privateKey,
    publicKey,
    dpopKeyPair,
  })
  await oidc.login()
  return { oidc, dpopKeyPair, issuer: baseUrl, clientId: resolvedClientId }
}

export async function buildOidcSession(
  webid: string,
  clientId?: string,
  expiration = 60
): Promise<SelfIssuedSession> {
  const { oidc } = await buildSelfIssuedCredential(webid, clientId, expiration)
  return oidc
}

export interface BuildLwsFetchOptions {
  /**
   * Use the two-step chain (ID token → ID-JAG per resource authorization server
   * → storage access token) instead of exchanging the credential directly at
   * each storage. Defaults to the single exchange while C3 rolls out.
   */
  idJag?: boolean
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
 * With `{ idJag: true }` the request goes through `@elfpavlik/lws-auth`: the
 * credential is exchanged at the user's authorization server for one ID-JAG per
 * storage authorization server, and each storage trades its grant for an access
 * token. See `docs/plans/lws-auth.md` C3.
 */
export async function buildLwsFetch(
  webid: string,
  clientId?: string,
  options: BuildLwsFetchOptions = {}
): Promise<WhatwgFetch> {
  const {
    oidc,
    dpopKeyPair,
    issuer,
    clientId: resolvedClientId,
  } = await buildSelfIssuedCredential(webid, clientId)
  if (!options.idJag) {
    return createLwsFetch({
      subjectToken: () => oidc.generateSelfIssuedAccessToken(),
      dpopKeyPair,
    })
  }
  const credential: LwsCredential = {
    issuer,
    clientId: resolvedClientId,
    // jose generates WebCrypto keys here; oauth4webapi needs the raw pair
    dpopKeyPair: dpopKeyPair as unknown as CryptoKeyPair,
    getSubjectToken: () => oidc.generateSelfIssuedAccessToken(),
  }
  return createLwsAuthFetch({
    credential,
    ...(options.accessClaim ? { accessClaim: options.accessClaim } : {}),
    ...(options.impersonation ? { impersonation: options.impersonation } : {}),
  })
}
