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
   * Defaults to `urn:ietf:params:oauth:token-type:id_token`; the browser sends
   * its session access token instead (`…:access_token`).
   */
  readonly subjectTokenType?: string
  /** Mints a fresh subject token (one exchange per resource authorization server). */
  getSubjectToken(): Promise<string>
}
