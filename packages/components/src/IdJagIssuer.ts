import { randomUUID } from 'node:crypto'

import type { JwkGenerator } from '@solid/community-server'
import type { JWK } from 'jose'
import { calculateJwkThumbprint, importJWK, SignJWT } from 'jose'

/** Token type URI of an Identity Assertion JWT Authorization Grant (ID-JAG). */
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'

/** Protected header `typ` of an ID-JAG (`draft-ietf-oauth-identity-assertion-authz-grant` §4.3.2.1). */
export const ID_JAG_JWT_TYPE = 'oauth-id-jag+jwt'

/**
 * Issues the ID-JAGs of the SAI User Authorization Server (`auth`).
 *
 * The ID-JAG is a profile of the JWT authorization grant: it asserts, for one
 * specific resource authorization server (`aud`), that the user authenticated
 * at this UAS. A storage's own authorization server trades it for an access
 * token, so the credential that crosses the network is audience-constrained
 * rather than usable anywhere (LWS core §Authorization + the Identity Assertion
 * JWT Authorization Grant draft).
 *
 * Signed with the same {@link JwkGenerator} as the Solid-OIDC tokens, so the
 * existing `/.oidc/jwks` publishes the key the storages verify against — no new
 * trust setup on the storage side.
 *
 * See `docs/plans/lws-auth.md` C1.
 */
export class IdJagIssuer {
  /** The identifier of this authorization server, used as `iss`. */
  public readonly issuer: string
  /** Lifetime of the issued ID-JAGs in seconds. */
  public readonly lifetime: number

  private readonly jwkGenerator: JwkGenerator

  /**
   * @param issuer - The identifier of this authorization server. Usually the base URL of the server.
   * @param jwkGenerator - Generates the key the grants are signed with.
   * @param lifetime - Lifetime of the ID-JAGs in seconds.
   */
  public constructor(issuer: string, jwkGenerator: JwkGenerator, lifetime = 300) {
    this.issuer = issuer
    this.jwkGenerator = jwkGenerator
    this.lifetime = lifetime
  }

  /**
   * Returns the public signing key, with a `kid` and `use` parameter.
   */
  public async getPublicJwk(): Promise<JWK> {
    const jwk: JWK = { ...(await this.jwkGenerator.getPublicKey()) }
    jwk.kid = await calculateJwkThumbprint(jwk)
    jwk.use = 'sig'
    return jwk
  }

  /**
   * Issues a new ID-JAG.
   *
   * @param subject - The WebID of the agent the grant is issued to.
   * @param client - The URI of the client requesting the grant.
   * @param audience - The issuer identifier of the resource authorization server
   *   the grant is intended for; it becomes the `aud` claim.
   */
  public async issue(subject: string, client: string, audience: string): Promise<string> {
    const privateJwk = await this.jwkGenerator.getPrivateKey()
    const key = await importJWK(privateJwk, this.jwkGenerator.alg)
    const kid = (await this.getPublicJwk()).kid
    return new SignJWT({ client_id: client })
      .setProtectedHeader({ alg: this.jwkGenerator.alg, typ: ID_JAG_JWT_TYPE, kid })
      .setSubject(subject)
      .setIssuer(this.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${this.lifetime}s`)
      .setJti(randomUUID())
      .sign(key)
  }
}
