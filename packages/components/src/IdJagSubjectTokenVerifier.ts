import { setTokenAttributes, withSpan } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import type { Span } from '@opentelemetry/api'
import type {
  RepresentationConverter,
  SubjectTokenVerifierInput,
  VerifiedSubject,
} from '@solid/community-server'
import {
  BadRequestHttpError,
  NotImplementedHttpError,
  SubjectTokenVerifier,
  decodeUnverifiedJwt,
  toClientUri,
  trimTrailingSlashes,
  verifyJwtCredential,
} from '@solid/community-server'
import type { JWTVerifyGetKey } from 'jose'
import { decodeProtectedHeader } from 'jose'

import type { VerifiedAccessClaim } from './access-claim.js'
import { verifyAccessClaim } from './access-claim.js'
import { CidIssuerResolver } from './CidIssuerResolver.js'
import type { AccessClaimValidator } from './DelegatedAccessClaimValidator.js'
import { ID_JAG_JWT_TYPE, ID_JAG_TOKEN_TYPE } from './IdJagIssuer.js'
import { isWithinBaseUrl } from './util/url.js'

export interface IdJagSubjectTokenVerifierArgs {
  /** Used to parse RDF subject documents, such as WebID profiles. */
  converter: RepresentationConverter
  /**
   * Issuers trusted without verifying the controlled identifier document of the
   * subject — typically the storages/UASs of this deployment.
   */
  trustedIssuers?: string[]
  /**
   * Accept any audience URL within this base URL (the auth `.sai` verifier).
   * When unset, the `aud` claim has to match the verifier's audience exactly
   * (the storage authorization-server verifiers).
   */
  audiencePrefix?: string
  /** Allowed clock skew in seconds. Defaults to 60. */
  clockTolerance?: number
  /** Underlying fetch for subject CID documents and issuer metadata. */
  fetch?: WhatwgFetch
  /**
   * Optional storage-AS check that the final claim is still covered by an
   * owner grant at exchange time. The UAS accept config leaves this unset; the
   * storage config wires the owner-registry validator.
   */
  claimValidator?: AccessClaimValidator
}

/**
 * Validates an **Identity Assertion JWT Authorization Grant** presented at a
 * token endpoint or a `.sai` route.
 *
 * Checks, in order: the `typ` header is `oauth-id-jag+jwt` (so an ID token can
 * never be replayed as a grant — both are signed by the user's UAS), the `aud`
 * claim names this server (exactly, or within the configured auth prefix), the
 * issuer is trusted (config list, or the subject CID document designates it as
 * `lws:OpenIdProvider`), the signature verifies against the issuer's JWKS, and
 * the temporal claims hold.
 *
 * The trust model is the LWS CID one: a federated issuer (`iss` not in
 * `trustedIssuers`) must be found in the subject's controlled identifier
 * document. There is no `solid:oidcIssuer` fallback; SAI does not add WebID or
 * Solid-OIDC support to this path.
 *
 * See `openwiki/architecture/id-jag-access-claims.md`.
 */
export class IdJagSubjectTokenVerifier extends SubjectTokenVerifier {
  private readonly trustedIssuerSet: Set<string>
  private readonly audiencePrefix?: string
  private readonly skew: number
  private readonly claimValidator?: AccessClaimValidator
  private readonly issuerResolver: CidIssuerResolver

  public constructor(args: IdJagSubjectTokenVerifierArgs) {
    super()
    this.trustedIssuerSet = new Set((args.trustedIssuers ?? []).map(trimTrailingSlashes))
    this.audiencePrefix = args.audiencePrefix
    this.skew = args.clockTolerance ?? 60
    this.claimValidator = args.claimValidator
    this.issuerResolver = new CidIssuerResolver({
      converter: args.converter,
      ...(args.fetch ? { fetch: args.fetch } : {}),
    })
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
    { token, audience, resource }: SubjectTokenVerifierInput,
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

    const audiences = this.acceptedAudiences(claims.aud, audience)
    if (audiences.length === 0) {
      throw new BadRequestHttpError(`The ID-JAG audience does not include ${audience}.`)
    }

    if (!this.trustedIssuerSet.has(trimTrailingSlashes(iss))) {
      await this.verifySubjectDocument(sub, iss)
    }

    const keySet = (await this.getKeySet(iss)) as unknown as Parameters<
      typeof verifyJwtCredential
    >[1]
    const payload = await verifyJwtCredential(token, keySet, {
      audiences,
      requiredClaims: ['sub', 'iss', 'aud', 'client_id', 'jti'],
      clockTolerance: this.skew,
    })

    let claim: VerifiedAccessClaim | undefined
    if (payload.access !== undefined) {
      claim = await verifyAccessClaim(payload.access, payload['@context'], resource, {
        assignee: sub,
      })
      if (this.claimValidator) {
        try {
          await this.claimValidator.validate({
            subject: sub,
            client,
            access: claim.access,
            context: claim.context,
            storage: claim.storage,
          })
        } catch (error: unknown) {
          span.setAttribute('sai.lws.error', (error as Error).message)
          throw new BadRequestHttpError(`Invalid access claim: ${(error as Error).message}`)
        }
      }
      span.setAttribute('sai.lws.access.storage', claim.storage)
    }
    span.setAttributes({ 'sai.lws.subject_id': sub, 'sai.lws.client_id': client })
    return {
      subject: sub,
      issuer: iss,
      client: toClientUri(client, iss),
      ...(claim ? { access: claim.access, accessContext: claim.context } : {}),
    }
  }

  /**
   * The accepted audience values. With `audiencePrefix`, any `aud` URL under
   * the auth service's base URL is accepted (one-time interaction URLs and
   * target UAS base URLs); otherwise the storage AS audience has to match
   * exactly.
   */
  private acceptedAudiences(aud: unknown, audience: string): string[] {
    const values =
      typeof aud === 'string'
        ? [aud]
        : Array.isArray(aud)
          ? aud.filter((value): value is string => typeof value === 'string')
          : []
    return this.audiencePrefix
      ? values.filter((value) => isWithinBaseUrl(value, this.audiencePrefix!))
      : values.filter((value) => value === audience)
  }

  /** Verifies that the subject CID document designates this issuer. */
  protected async verifySubjectDocument(subject: string, issuer: string): Promise<void> {
    return this.issuerResolver.verifySubjectDocument(subject, issuer)
  }

  /** The issuer's JWKS, discovered through OIDC (or LWS) metadata. */
  protected async getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
    return this.issuerResolver.getKeySet(issuer)
  }
}
