import { dpopThumbprint } from './dpop.ts'
import { ACCESS_TOKEN_TYPE } from './tokens.ts'

/**
 * The user's authentication credential as this client sees it: a token of the
 * user's authorization server (an OpenID Connect access token, an ID token, or
 * the self-issued JWT the SAI test stack uses) plus the DPoP key pair its `cnf`
 * claim is bound to.
 *
 * The credential names its own authorization server (the UAS, the token's
 * `iss`); the client asks that server for one **ID-JAG** per resource
 * authorization server, and never sends the credential itself to a storage.
 */
export interface LwsCredential {
  /** Issuer identifier of the user's authorization server (the credential's `iss`). */
  readonly issuer: string
  /** Client identifier; becomes the ID-JAG's `client_id` and the access token's `client_id`. */
  readonly clientId: string
  /**
   * DPoP key pair the subject token is bound to (`cnf.jkt`). The UAS requires a
   * proof for this key at its token endpoint, so a leaked token alone cannot be
   * exchanged.
   */
  readonly dpopKeyPair: CryptoKeyPair
  /**
   * The RFC 8693 `subject_token_type` of the credential.
   * Defaults to the self-issued access-token type; browser sessions send their
   * session access token instead (`…:access_token`).
   */
  readonly subjectTokenType?: string
  /**
   * Mints a fresh subject token (one exchange per resource authorization server).
   * The optional audience is only used by self-issued credentials; a token the
   * user's provider already issued ignores it.
   */
  getSubjectToken(audience?: string): Promise<string>
}

/** The claims a self-issued subject token is signed with. */
export interface SelfIssuedCredentialClaims {
  /** The credential's `iss` (the user's authorization server). */
  issuer: string
  /** The credential's `sub` (the agent's identifier). */
  subject: string
  /** The credential's `client_id` / `azp`. */
  clientId: string
  /** The credential's `aud`. Defaults to the issuer. */
  audience: string
  /** The DPoP key thumbprint (`cnf.jkt`). */
  jkt: string
  /** Issued-at time in seconds since the epoch. */
  iat: number
  /** Expiry time in seconds since the epoch. */
  exp: number
  /** Unique token identifier (`jti`). */
  jti: string
}

export interface SelfIssuedCredentialOptions {
  /** Issuer identifier of the user's authorization server (the UAS). */
  issuer: string
  /** The agent's identifier (the SAI/CID URI); it becomes the token's `sub`. */
  subject: string
  /** The client identifier; it becomes `client_id` and `azp`. */
  clientId: string
  /** The DPoP key pair the token is bound to (`cnf.jkt`). */
  dpopKeyPair: CryptoKeyPair
  /** `subject_token_type` of the minted token. Defaults to an access token. */
  subjectTokenType?: string
  /** Lifetime of each minted token in seconds. Defaults to 300. */
  lifetime?: number
  /** Clock, injectable for tests. */
  now?: () => number
  /** Signs the token with the UAS key. The caller keeps the key management. */
  sign(claims: SelfIssuedCredentialClaims): Promise<string>
}

/** A credential whose subject token is minted and signed locally. */
export interface SelfIssuedCredential extends LwsCredential {
  /** The agent identifier used as the token's `sub`. */
  readonly subject: string
  getSubjectToken(audience?: string): Promise<string>
}

/**
 * Creates the self-issued credential the SAI test stack and server-side
 * sessions use: a short-lived `at+jwt` that the UAS itself verifies at its
 * token endpoint.
 *
 * The DPoP thumbprint is derived from the public key and cached; signing is
 * delegated to the caller so this package stays free of server key management.
 */
export function createSelfIssuedCredential(
  options: SelfIssuedCredentialOptions
): SelfIssuedCredential {
  const now = options.now ?? (() => Date.now())
  const lifetime = options.lifetime ?? 300
  let thumbprint: Promise<string> | undefined

  function jkt(): Promise<string> {
    thumbprint ??= dpopThumbprint(options.dpopKeyPair.publicKey)
    return thumbprint
  }

  return {
    issuer: options.issuer,
    subject: options.subject,
    clientId: options.clientId,
    dpopKeyPair: options.dpopKeyPair,
    subjectTokenType: options.subjectTokenType ?? ACCESS_TOKEN_TYPE,
    async getSubjectToken(audience = options.issuer): Promise<string> {
      const iat = Math.floor(now() / 1000)
      return options.sign({
        issuer: options.issuer,
        subject: options.subject,
        clientId: options.clientId,
        audience,
        jkt: await jkt(),
        iat,
        exp: iat + lifetime,
        jti: crypto.randomUUID(),
      })
    },
  }
}
