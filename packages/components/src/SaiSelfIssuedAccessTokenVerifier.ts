import type {
  JwkGenerator,
  SubjectTokenVerifierInput,
  VerifiedSubject,
} from '@solid/community-server'
import {
  BadRequestHttpError,
  NotImplementedHttpError,
  SubjectTokenVerifier,
  TOKEN_TYPE_ACCESS_TOKEN,
  decodeUnverifiedJwt,
  isJsonObject,
  toClientUri,
} from '@solid/community-server'
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose'

/** Protected header `typ` of a self-issued LWS access token (RFC 9068). */
const ACCESS_TOKEN_JWT_TYPE = 'at+jwt'

export interface SaiSelfIssuedAccessTokenVerifierArgs {
  /** The UAS identifier; it has to be the token's `iss` and an `aud` value. */
  issuer: string
  /** The UAS key generator that verifies the signature. */
  jwkGenerator: JwkGenerator
  /** Allowed clock skew in seconds. Defaults to 60. */
  clockTolerance?: number
}

/**
 * Verifies the **first-hop** SAI authentication credential: the self-issued
 * `at+jwt` the agent's own UAS mints for its token endpoint.
 *
 * This verifier is deliberately local and minimal:
 * - `typ` is `at+jwt`, `iss` is this UAS, and `aud` includes this UAS;
 * - the signature is verified with the local `JwkGenerator` public key;
 * - `sub` and `client_id` are HTTPS identifiers;
 * - `cnf.jkt` must equal the DPoP proof key thumbprint.
 *
 * There is no OIDC discovery, no subject document, no WebID/Solid-OIDC claim,
 * and no CID key lookup. Those belong to incoming ID-JAG verification, not to
 * the credential the UAS itself issued.
 */
export class SaiSelfIssuedAccessTokenVerifier extends SubjectTokenVerifier {
  private readonly issuer: string
  private readonly jwkGenerator: JwkGenerator
  private readonly clockTolerance: number

  public constructor(args: SaiSelfIssuedAccessTokenVerifierArgs) {
    super()
    this.issuer = args.issuer
    this.jwkGenerator = args.jwkGenerator
    this.clockTolerance = args.clockTolerance ?? 60
  }

  public async canHandle({ tokenType }: SubjectTokenVerifierInput): Promise<void> {
    if (tokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
      throw new NotImplementedHttpError(`Unsupported token type ${tokenType}`)
    }
  }

  public async handle({
    token,
    proofKeyThumbprint,
  }: SubjectTokenVerifierInput): Promise<VerifiedSubject> {
    const { typ, alg } = decodeProtectedHeader(token)
    if (typ !== ACCESS_TOKEN_JWT_TYPE) {
      throw new BadRequestHttpError(`The SAI access token needs the ${ACCESS_TOKEN_JWT_TYPE} type.`)
    }
    if (!alg || alg === 'none') {
      throw new BadRequestHttpError('The SAI access token must be signed.')
    }

    const claims = decodeUnverifiedJwt(token)
    const { sub, iss, client_id: client, cnf } = claims
    if (typeof sub !== 'string' || !sub.startsWith('https://')) {
      throw new BadRequestHttpError(
        'The sub claim of the SAI access token needs to be an HTTPS URI.'
      )
    }
    if (typeof client !== 'string' || !client.startsWith('https://')) {
      throw new BadRequestHttpError(
        'The client_id claim of the SAI access token needs to be an HTTPS URI.'
      )
    }
    if (typeof iss !== 'string' || iss !== this.issuer) {
      throw new BadRequestHttpError(`The SAI access token needs the issuer ${this.issuer}.`)
    }
    if (!isJsonObject(cnf) || typeof cnf.jkt !== 'string') {
      throw new BadRequestHttpError('The SAI access token needs a cnf.jkt claim.')
    }
    if (!proofKeyThumbprint || cnf.jkt !== proofKeyThumbprint) {
      throw new BadRequestHttpError(
        'The SAI access token is sender-constrained: a DPoP proof with its key is required.'
      )
    }
    if (
      typeof claims.iat === 'number' &&
      claims.iat > Math.floor(Date.now() / 1000) + this.clockTolerance
    ) {
      throw new BadRequestHttpError('The iat claim of the SAI access token is in the future.')
    }

    const publicJwk = await this.jwkGenerator.getPublicKey()
    const key = await importJWK(publicJwk, alg)
    const { payload } = await jwtVerify(token, key, {
      issuer: this.issuer,
      audience: this.issuer,
      typ: ACCESS_TOKEN_JWT_TYPE,
      clockTolerance: this.clockTolerance,
      requiredClaims: ['sub', 'iss', 'aud', 'client_id', 'cnf', 'jti', 'iat', 'exp'],
    })

    return {
      subject: payload.sub,
      issuer: payload.iss,
      client: toClientUri(client, iss),
    }
  }
}
