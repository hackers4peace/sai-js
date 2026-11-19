import type { SelfIssuedCredential } from '@elfpavlik/lws-auth'
import {
  ACCESS_TOKEN_TYPE,
  createDpopKeyPair,
  createSelfIssuedCredential,
} from '@elfpavlik/lws-auth'
import type { JwkGenerator } from '@solid/community-server'
import { SignJWT, calculateJwkThumbprint } from 'jose'

export interface BuildSelfIssuedCredentialOptions {
  /** The UAS identifier, used as the token's `iss`. */
  issuer: string
  /** The agent's identifier (the SAI/CID URI), used as the token's `sub`. */
  subject: string
  /** The client identifier, used as `client_id` and `azp`. */
  clientId: string
  /** The UAS key generator that signs the token. */
  jwkGenerator: JwkGenerator
  /** Lifetime of each minted token in seconds. */
  lifetime: number
  /** Reuse an existing DPoP key pair instead of generating a new one. */
  dpopKeyPair?: CryptoKeyPair
}

/**
 * Builds the self-issued `at+jwt` credential of an agent's own UAS.
 *
 * The credential is signed with the same key as the UAS's other tokens and is
 * sender-constrained through `cnf.jkt`: the DPoP proof of the first ID-JAG
 * exchange must come from the key pair named here. It is deliberately not a
 * WebID/Solid-OIDC credential — SAI uses the CID URI as `sub` and does not add a
 * `webid` claim.
 */
export async function createSelfIssuedCredentialWithJwk(
  options: BuildSelfIssuedCredentialOptions
): Promise<SelfIssuedCredential> {
  const privateKey = await options.jwkGenerator.getPrivateKey()
  const publicKey = await options.jwkGenerator.getPublicKey()
  const kid = await calculateJwkThumbprint(publicKey, 'sha256')
  const dpopKeyPair = options.dpopKeyPair ?? (await createDpopKeyPair())

  return createSelfIssuedCredential({
    issuer: options.issuer,
    subject: options.subject,
    clientId: options.clientId,
    dpopKeyPair,
    subjectTokenType: ACCESS_TOKEN_TYPE,
    lifetime: options.lifetime,
    sign: async ({ issuer, subject, clientId, audience, jkt, iat, exp, jti }) =>
      new SignJWT({
        client_id: clientId,
        // `azp` is what the LWS token exchange reads as the client: it becomes
        // the `client_id` of the storage access token, so the SAI policy engine
        // recognizes the request as coming from the owner's Authorization Agent.
        azp: clientId,
        cnf: { jkt },
      })
        .setProtectedHeader({ alg: privateKey.alg, typ: 'at+jwt', kid })
        .setIssuer(issuer)
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setJti(jti)
        .sign(privateKey),
  })
}
