import { randomUUID } from 'node:crypto'

import type { JwkGenerator } from '@solid/community-server'
import type { JWK } from 'jose'
import { calculateJwkThumbprint, importJWK, SignJWT } from 'jose'

/**
 * Issues the **DPoP-bound self-issued credential** the SAI UI exchanges at the
 * UAS for ID-JAGs (`docs/plans/lws-auth.md` C5).
 *
 * CSS's OpenID Provider cannot issue sender-constrained ID tokens (the
 * `oidc-provider` ID token has no `cnf` support), so `auth` mints the same
 * shape the test suite signs in-process:
 *
 * ```json
 * { "webid": "https://id/alice", "client_id": "https://ui.auth/id",
 *   "azp": "https://ui.auth/id", "cnf": { "jkt": "<browser key thumbprint>" } }
 * ```
 *
 * with `typ: at+jwt`, `iss` = this server, `sub` = the WebID, `aud: "solid"`.
 * `OidcSubjectTokenVerifier` accepts it (trusted issuer, `solid` audience) and
 * enforces `cnf.jkt` against the DPoP proof at the token endpoint, so the token
 * is useless without the browser's key.
 *
 * Signed with the same {@link JwkGenerator} as `/.oidc/jwks`: no new trust
 * material anywhere.
 */
export class IdTokenIssuer {
  /** The identifier of this authorization server, used as `iss`. */
  public readonly issuer: string
  /** Lifetime of the issued credentials in seconds. */
  public readonly lifetime: number

  private readonly jwkGenerator: JwkGenerator

  /**
   * @param issuer - The identifier of this authorization server. Usually the base URL of the server.
   * @param jwkGenerator - Generates the key the credentials are signed with.
   * @param lifetime - Lifetime of the credentials in seconds.
   */
  public constructor(issuer: string, jwkGenerator: JwkGenerator, lifetime = 300) {
    this.issuer = issuer
    this.jwkGenerator = jwkGenerator
    this.lifetime = lifetime
  }

  /** The public signing key, with the `kid` the credential header carries. */
  public async getPublicJwk(): Promise<JWK> {
    const jwk: JWK = { ...(await this.jwkGenerator.getPublicKey()) }
    jwk.kid = await calculateJwkThumbprint(jwk)
    jwk.use = 'sig'
    return jwk
  }

  /**
   * Issues a credential for `webId`, sender-constrained to the client's key.
   *
   * @param webId - The agent the credential authenticates.
   * @param clientId - The client acting for the agent (`azp`).
   * @param jkt - JWK SHA-256 thumbprint of the client's DPoP public key.
   */
  public async issue(webId: string, clientId: string, jkt: string): Promise<string> {
    const privateJwk = await this.jwkGenerator.getPrivateKey()
    const key = await importJWK(privateJwk, this.jwkGenerator.alg)
    const kid = (await this.getPublicJwk()).kid
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      webid: webId,
      client_id: clientId,
      azp: clientId,
      cnf: { jkt },
    })
      .setProtectedHeader({ alg: this.jwkGenerator.alg, typ: 'at+jwt', kid })
      .setIssuer(this.issuer)
      .setSubject(webId)
      .setAudience('solid')
      .setIssuedAt(now)
      .setExpirationTime(`${this.lifetime}s`)
      .setJti(randomUUID())
      .sign(key)
  }
}
