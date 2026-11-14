import { setTokenAttributes, withSpan } from '@janeirodigital/interop-utils'
import type { Span } from '@opentelemetry/api'
import type {
  RepresentationConverter,
  SubjectTokenVerifierInput,
  VerifiedSubject,
} from '@solid/community-server'
import {
  BadRequestHttpError,
  NotImplementedHttpError,
  OidcSubjectTokenVerifier,
  decodeUnverifiedJwt,
  toClientUri,
  trimTrailingSlashes,
  verifyJwtCredential,
} from '@solid/community-server'
import { decodeProtectedHeader } from 'jose'

import { ID_JAG_JWT_TYPE, ID_JAG_TOKEN_TYPE } from './IdJagIssuer.js'

export interface IdJagSubjectTokenVerifierArgs {
  /**
   * Used to parse RDF subject documents, such as Solid WebID profiles, when the
   * issuer of the ID-JAG is not in {@link trustedIssuers}.
   */
  converter: RepresentationConverter
  /**
   * Issuers trusted without verifying the controlled identifier document of the
   * subject — typically the storages of this deployment.
   */
  trustedIssuers?: string[]
  /**
   * Whether a `solid:oidcIssuer` triple in the subject document is accepted as an
   * alternative to an `lws:OpenIdProvider` service. Defaults to true.
   */
  acceptSolidOidcIssuer?: boolean
  /** Allowed clock skew in seconds. Defaults to 60. */
  clockTolerance?: number
}

/**
 * Validates an **Identity Assertion JWT Authorization Grant** presented at the
 * token endpoint of a storage's LWS authorization server (the RAS role):
 * a client trades the ID-JAG it obtained from its own UAS for an access token.
 *
 * ```http
 * POST /.well-known/lws/token HTTP/1.1
 * grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 * &subject_token_type=urn:ietf:params:oauth:token-type:id-jag
 * &resource=https://data/
 * &subject_token=<ID-JAG>
 * ```
 *
 * Checks, in order: the `typ` header is `oauth-id-jag+jwt` (so an ID token can
 * never be replayed as a grant — both are signed by the user's UAS), the
 * `aud` claim names *this* authorization server, the issuer is trusted (config
 * list, or the subject document designates it), the signature verifies against
 * the issuer's `jwks_uri`, and the temporal claims hold.
 *
 * Extends {@link OidcSubjectTokenVerifier} because the trust model is the same
 * one the OIDC authentication suite uses (dereference `sub`, find the issuer,
 * verify with its JWKS); only the claim names and the pinned `typ` differ.
 * See `docs/plans/lws-auth.md` C2.
 */
export class IdJagSubjectTokenVerifier extends OidcSubjectTokenVerifier {
  private readonly trustedIssuerSet: Set<string>
  private readonly skew: number

  public constructor(args: IdJagSubjectTokenVerifierArgs) {
    super({
      converter: args.converter,
      trustedIssuers: args.trustedIssuers,
      // The `aud` of an ID-JAG is enforced below: it has to name this server.
      additionalAudiences: [],
      requireRestrictedTokens: false,
      acceptSolidOidcIssuer: args.acceptSolidOidcIssuer,
      clockTolerance: args.clockTolerance,
    })
    this.trustedIssuerSet = new Set((args.trustedIssuers ?? []).map(trimTrailingSlashes))
    this.skew = args.clockTolerance ?? 60
  }

  public async canHandle({ tokenType }: SubjectTokenVerifierInput): Promise<void> {
    if (tokenType !== ID_JAG_TOKEN_TYPE) {
      throw new NotImplementedHttpError(`Unsupported token type ${tokenType}`)
    }
  }

  public async handle(input: SubjectTokenVerifierInput): Promise<VerifiedSubject> {
    return withSpan('sai-lws', 'sai.lws.verify-id-jag', async (span): Promise<VerifiedSubject> => {
      try {
        return await this.verify(input, span)
      } catch (error: unknown) {
        // A rejected grant is a protocol outcome, not a crash: annotate it, let
        // `withSpan` mark the status.
        span.setAttribute('sai.lws.error', (error as Error).message)
        throw error
      }
    })
  }

  private async verify(
    { token, audience, proofKeyThumbprint }: SubjectTokenVerifierInput,
    span: Span
  ): Promise<VerifiedSubject> {
    span.setAttribute('sai.lws.audience', audience)
    setTokenAttributes(span, 'id-jag', token)

    // RFC 8725 §3.11: pin the type before looking at any claim, otherwise an
    // ID token or an access token signed by the same UAS would be accepted.
    const { typ } = decodeProtectedHeader(token)
    if (typ !== ID_JAG_JWT_TYPE) {
      throw new BadRequestHttpError(`An ID-JAG needs the ${ID_JAG_JWT_TYPE} type.`)
    }

    const claims = decodeUnverifiedJwt(token)
    const { iss, sub, client_id: client } = claims
    if (typeof sub !== 'string' || typeof iss !== 'string' || typeof client !== 'string') {
      throw new BadRequestHttpError(
        'An ID-JAG needs to contain the sub, iss, and client_id claims.'
      )
    }
    if (!/^https?:\/\//u.test(sub) || !/^https?:\/\//u.test(iss)) {
      throw new BadRequestHttpError('The sub and iss claims of an ID-JAG need to be HTTP(S) URIs.')
    }

    if (!this.trustedIssuerSet.has(trimTrailingSlashes(iss))) {
      await this.verifySubjectDocument(sub, iss)
    }

    const payload = await verifyJwtCredential(token, await this.getKeySet(iss), {
      // `aud` must name this authorization server: an ID-JAG for another
      // storage's AS is useless here (RFC 7523 §3, draft §4.4.1).
      audiences: [audience],
      requiredClaims: ['sub', 'iss', 'aud', 'client_id', 'jti'],
      clockTolerance: this.skew,
    })
    this.verifyRestriction(payload, audience, proofKeyThumbprint)

    span.setAttributes({ 'sai.lws.subject_id': sub, 'sai.lws.client_id': client })
    return { subject: sub, issuer: iss, client: toClientUri(client, iss) }
  }
}
