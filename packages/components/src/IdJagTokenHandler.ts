import {
  ODRL_ID_JAG_CONTEXT,
  SAI,
  SAI_IMPERSONATE_PARAM,
  descriptionHasStorageType,
  fetchLwsStorageDescription,
  setBodyAttribute,
  setTokenAttributes,
} from '@janeirodigital/interop-utils'
import { SpanStatusCode } from '@opentelemetry/api'
import {
  APPLICATION_X_WWW_FORM_URLENCODED,
  HttpHandler,
  NotImplementedHttpError,
  TOKEN_TYPE_ACCESS_TOKEN,
  parseContentType,
  readableToString,
  verifyDpopProof,
} from '@solid/community-server'
import type {
  HttpHandlerInput,
  HttpRequest,
  HttpResponse,
  SubjectTokenVerifier,
} from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { VerifiedAccessClaim } from './access-claim.js'
import { rewriteAccessClaim, setAccessClaimAssignee, verifyAccessClaim } from './access-claim.js'
import type { AdminImpersonationRequestAuthority } from './AdminImpersonationAuthority.js'
import { AdminImpersonationDenied } from './AdminImpersonationAuthority.js'
import type { AccessClaimValidator } from './DelegatedAccessClaimValidator.js'
import { ID_JAG_TOKEN_TYPE } from './IdJagIssuer.js'
import type { IdJagIssuer } from './IdJagIssuer.js'
import { sharedTracer } from './tracing/otel-state.js'
import { isWithinBaseUrl } from './util/url.js'

/** The grant type of OAuth 2.0 Token Exchange (RFC 8693), the only one this endpoint supports. */
export const ID_JAG_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'

/**
 * An OAuth 2.0 error, as described in Section 5.2 of RFC 6749.
 *
 * Local copy: CSS keeps its own `OAuthError` private to `LwsTokenHttpHandler`.
 */
class OAuthError extends Error {
  public readonly error: string

  public constructor(error: string, description: string) {
    super(description)
    this.error = error
  }
}

export interface IdJagTokenHandlerArgs {
  /** Issues the ID-JAGs. */
  issuer: IdJagIssuer
  /** Validates the subject token (a DPoP-bound access token or an incoming ID-JAG). */
  verifier: SubjectTokenVerifier
  /**
   * The storages this UAS issues ID-JAGs for, as hostnames (`data`) or origins
   * (`https://data.docker`). The `audience` parameter must name one of them,
   * otherwise a client could ask for a grant "for" any URL.
   */
  storageOrigins: string[]
  /**
   * Authorization servers/UASs that may be the `audience` of an ID-JAG. C2 uses
   * this for the first hop (Bob's UAS -> YoYo's UAS) before the final storage
   * exchange.
   */
  authorizationServerOrigins?: string[]
  /**
   * Optional independent UAS check of an incoming delegated claim. The auth
   * server wires the grant-registry-backed validator; package tests can inject
   * a stub or omit it.
   */
  claimValidator?: AccessClaimValidator
  /**
   * The requested `scope` value that selects read-only admin impersonation
   * (`urn:sai:params:oauth:scope:admin-impersonation:read`). Unset disables it.
   */
  adminImpersonationScope?: string
  /**
   * Authority check and organization claim derivation for admin impersonation.
   * Required when {@link adminImpersonationScope} is set.
   */
  adminImpersonationAuthority?: AdminImpersonationRequestAuthority
  /**
   * The path of the token endpoint, relative to this server's base URL. Used to
   * verify the `htu` claim of DPoP proofs. Defaults to `.well-known/lws/token`.
   */
  tokenPath?: string
}

/**
 * The token endpoint of the SAI User Authorization Server (`auth`): exchanges
 * the user's authentication credential for an **ID-JAG** restricted to one
 * resource authorization server.
 *
 * ```http
 * POST /.well-known/lws/token HTTP/1.1
 * Content-Type: application/x-www-form-urlencoded
 *
 * grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 * &requested_token_type=urn:ietf:params:oauth:token-type:id-jag
 * &audience=https://data/
 * &subject_token=<DPoP-bound access token>
 * &subject_token_type=urn:ietf:params:oauth:token-type:access_token
 * ```
 *
 * The subject token is verified by a {@link SubjectTokenVerifier}; a
 * sender-constrained token (`cnf.jkt`) is only accepted together with a `DPoP`
 * proof for that key, which is what lets the self-issued suite credential keep
 * working while the outgoing grants are plain audience-constrained bearer JWTs.
 *
 * This is deliberately not CSS's `LwsTokenHttpHandler`: that one only accepts
 * `resource` values that are storages *hosted by the same server*, and it only
 * issues `at+jwt` access tokens. See `openwiki/architecture/id-jag-access-claims.md`.
 */
export class IdJagTokenHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this)

  private readonly issuer: IdJagIssuer
  private readonly verifier: SubjectTokenVerifier
  private readonly storageOrigins: string[]
  private readonly authorizationServerOrigins: string[]
  private readonly tokenEndpoint: string
  private readonly claimValidator?: AccessClaimValidator
  private readonly adminImpersonationScope?: string
  private readonly adminImpersonationAuthority?: AdminImpersonationRequestAuthority
  private readonly deriving = new Set<string>()

  public constructor(args: IdJagTokenHandlerArgs) {
    super()
    this.issuer = args.issuer
    this.verifier = args.verifier
    this.storageOrigins = args.storageOrigins
    this.authorizationServerOrigins = args.authorizationServerOrigins ?? []
    this.tokenEndpoint = new URL(args.tokenPath ?? '.well-known/lws/token', args.issuer.issuer).href
    this.claimValidator = args.claimValidator
    this.adminImpersonationScope = args.adminImpersonationScope
    this.adminImpersonationAuthority = args.adminImpersonationAuthority
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    // Not `startActiveSpan`: it ends the span as soon as the async callback
    // returns its promise, so every attribute set while awaiting would be
    // discarded. The span is passed to `exchange` explicitly instead.
    const span = sharedTracer('sai-lws').startSpan('sai.lws.issue-id-jag')
    try {
      const body = await this.exchange(request, span)
      this.writeJson(response, 200, body)
    } catch (error: unknown) {
      if (error instanceof OAuthError) {
        span.setAttribute('sai.lws.error', error.error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
        this.logger.warn(`Rejected ID-JAG request: ${error.message}`)
        this.writeJson(response, 400, { error: error.error, error_description: error.message })
        return
      }
      span.recordException(error as Error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  }

  /**
   * Validates the token request and issues the ID-JAG.
   */
  protected async exchange(
    request: HttpRequest,
    span: import('@opentelemetry/api').Span
  ): Promise<Record<string, unknown>> {
    const contentType = request.headers['content-type']
    if (!contentType || parseContentType(contentType).value !== APPLICATION_X_WWW_FORM_URLENCODED) {
      throw new OAuthError(
        'invalid_request',
        `Token requests need to use ${APPLICATION_X_WWW_FORM_URLENCODED}.`
      )
    }

    const proofKeyThumbprint = await this.verifyProof(request)
    const params = new URLSearchParams(await readableToString(request))
    setBodyAttribute(span, 'sai.lws.request.body', params.toString())

    const grantType = this.getParameter(params, 'grant_type')
    if (grantType !== ID_JAG_GRANT_TYPE) {
      throw new OAuthError(
        'unsupported_grant_type',
        `Only the ${ID_JAG_GRANT_TYPE} grant type is supported.`
      )
    }
    const requestedTokenType = this.getParameter(params, 'requested_token_type')
    if (requestedTokenType !== ID_JAG_TOKEN_TYPE) {
      throw new OAuthError(
        'invalid_request',
        `Only ${ID_JAG_TOKEN_TYPE} can be requested at this endpoint.`
      )
    }

    const audience = this.getParameter(params, 'audience')
    const subjectToken = this.getParameter(params, 'subject_token')
    const subjectTokenType = this.getParameter(params, 'subject_token_type')
    // The first hop accepts only a DPoP-bound access token (or an incoming
    // ID-JAG at an impersonation hop). A regular ID token is not a mediated
    // credential and is explicitly rejected, even if a verifier would accept
    // its claims.
    if (subjectTokenType !== ID_JAG_TOKEN_TYPE && subjectTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
      throw new OAuthError(
        'invalid_request',
        `Only ${TOKEN_TYPE_ACCESS_TOKEN} and ${ID_JAG_TOKEN_TYPE} subject tokens are supported.`
      )
    }
    const resource = params.get('resource') || undefined
    const access = await this.accessClaim(params)

    span.setAttributes({
      'sai.lws.grant_type': grantType,
      'sai.lws.requested_token_type': requestedTokenType,
      'sai.lws.subject_token_type': subjectTokenType,
      'sai.lws.audience': audience,
    })
    if (resource) {
      span.setAttribute('sai.lws.resource', resource)
    }
    if (access) {
      span.setAttribute('sai.lws.access.storage', access.storage)
    }
    if (proofKeyThumbprint) {
      span.setAttribute('sai.lws.dpop_proof', true)
    }
    setTokenAttributes(span, 'subject', subjectToken)

    await this.verifyAudience(audience)

    let subject
    try {
      subject = await this.verifier.handleSafe({
        token: subjectToken,
        tokenType: subjectTokenType,
        audience: this.issuer.issuer,
        proofKeyThumbprint,
        resource,
      })
    } catch (error: unknown) {
      if (NotImplementedHttpError.isInstance(error)) {
        throw new OAuthError('invalid_request', `Unsupported subject token: ${error.message}`)
      }
      throw new OAuthError('invalid_request', `Invalid subject token: ${(error as Error).message}`)
    }

    span.setAttribute('sai.lws.client_id', subject.client)
    span.setAttribute('sai.lws.subject_id', subject.subject)
    span.setAttribute('sai.lws.subject_issuer', subject.issuer)

    // The client only names the storage; the UAS adds the grants the user has
    // for that storage and client. A client-supplied `access` claim bypasses
    // derivation and is validated against the assigner's grant registry below.
    const requestedScope = new Set((params.get('scope') ?? '').split(/\s+/u).filter(Boolean))
    const impersonationRequested =
      this.adminImpersonationScope !== undefined && requestedScope.has(this.adminImpersonationScope)
    if (impersonationRequested) {
      this.assertImpersonationRequest({ resource, subjectTokenType, access, subject, span })
    }

    let derivedAccess: VerifiedAccessClaim | undefined
    if (
      !impersonationRequested &&
      access === undefined &&
      subjectTokenType !== ID_JAG_TOKEN_TYPE &&
      resource !== undefined &&
      !(await this.isRegistryStorage(resource)) &&
      !this.deriving.has(resource)
    ) {
      // The registry bootstrap asks this same UAS for a registry ID-JAG while
      // deriving a data claim. The guard keeps that second request claimless
      // even if the storage description is temporarily unavailable.
      this.deriving.add(resource)
      try {
        derivedAccess = await this.claimValidator?.find?.({
          subject: subject.subject,
          client: subject.client,
          storage: resource,
          // A storage audience gets a token that serves every read in it; an
          // authorization-server audience is a delegation hop, where the claim
          // must stay within one edge the receiving UAS can back.
          forStorage: this.matchesOrigin(this.storageOrigins, audience),
        })
      } catch (error: unknown) {
        // A registry outage must not turn the UAS into a 500; an identity-only
        // ID-JAG still reaches the owner/admin/public paths, and a data
        // exchange will reject a claimless non-owner/non-admin token.
        this.logger.warn(
          `could not derive an access claim for ${resource}: ${(error as Error).message}`
        )
        span.setAttribute('sai.lws.access.derivation_error', (error as Error).message)
      } finally {
        this.deriving.delete(resource)
      }
      if (derivedAccess) {
        span.setAttribute('sai.lws.access.derived', true)
        span.setAttribute('sai.lws.access.storage', derivedAccess.storage)
      }
    }

    let issuedSubject = subject.subject
    let issuedClient = subject.client
    let issuedAccess = access ?? derivedAccess

    if (impersonationRequested) {
      const org = this.impersonationOrg(params)
      let claim: VerifiedAccessClaim
      try {
        claim = await this.adminImpersonationAuthority!.authorize({
          org,
          subject: subject.subject,
          client: subject.client,
          storage: resource!,
        })
      } catch (error: unknown) {
        if (AdminImpersonationDenied.isInstance(error)) {
          throw new OAuthError('invalid_grant', error.message)
        }
        throw error
      }
      span.setAttribute('sai.lws.impersonation', true)
      span.setAttribute('sai.lws.impersonation.org', org)
      issuedSubject = org
      // The organization's UAS is the client of the re-issued ID-JAG, exactly
      // as on the C2 impersonation hop; the admin is dropped from here on.
      issuedClient = this.issuer.issuer
      issuedAccess = {
        ...claim,
        access: setAccessClaimAssignee(claim.access, org),
        assigners: [],
        assignees: [org],
      }
    } else if (subjectTokenType === ID_JAG_TOKEN_TYPE) {
      if (access !== undefined) {
        throw new OAuthError(
          'invalid_request',
          'An ID-JAG subject token cannot be combined with a request access claim.'
        )
      }
      if (subject.access === undefined || typeof subject.accessContext !== 'string') {
        throw new OAuthError(
          'invalid_request',
          'An ID-JAG subject token needs an ODRL access claim.'
        )
      }
      const incoming = await this.incomingClaim(
        subject.access,
        subject.accessContext,
        resource,
        subject.subject
      )
      let assigner = incoming.assigners[0]

      if (this.claimValidator) {
        try {
          const validated = await this.claimValidator.validate({
            ...(assigner ? { assigner } : {}),
            subject: subject.subject,
            client: subject.client,
            access: incoming.access,
            context: incoming.context,
            storage: incoming.storage,
          })
          assigner = validated ?? assigner
        } catch (error: unknown) {
          throw new OAuthError(
            'invalid_grant',
            `Invalid delegated access claim: ${(error as Error).message}`
          )
        }
      }

      issuedSubject = this.visibleSubject(incoming, assigner, subject.subject, subject.client)

      // Impersonation is the only flow: the outgoing client is this UAS and
      // the hidden subject/client are dropped.
      issuedClient = this.issuer.issuer

      issuedAccess = {
        ...incoming,
        access: rewriteAccessClaim(incoming.access, issuedSubject),
        assigners: [],
        assignees: [issuedSubject],
      }
      span.setAttribute('sai.lws.impersonation', true)
    } else if (issuedAccess) {
      if (resource !== undefined && resource !== issuedAccess.storage) {
        throw new OAuthError(
          'invalid_target',
          `The access claim is for ${issuedAccess.storage}, not the requested resource ${resource}.`
        )
      }
      this.verifyClaimIdentity(issuedAccess, subject.subject, subject.client)
      // A client-supplied claim is grant-backed, exactly like an incoming
      // ID-JAG's claim. A claim derived from the user's registries needs no
      // second lookup here; the next UAS validates it on the wire.
      if (access !== undefined && this.claimValidator) {
        await this.validateClaim(issuedAccess, subject.subject, subject.client)
      }
      // The first ID-JAG never exposes the grant assigner; the claim is bound
      // to its subject and the policy engine no longer matches identity fields.
      issuedAccess = {
        ...issuedAccess,
        access: setAccessClaimAssignee(issuedAccess.access, issuedSubject),
        assigners: [],
        assignees: [issuedSubject],
      }
    }

    const idJag = await this.issuer.issue(
      issuedSubject,
      issuedClient,
      audience,
      issuedAccess
        ? {
            access: issuedAccess.access,
            context: issuedAccess.context,
          }
        : undefined
    )
    setTokenAttributes(span, 'id-jag', idJag)

    this.logger.info(
      `Issued an ID-JAG for ${audience} to ${issuedSubject} using client ${issuedClient}`
    )
    return {
      issued_token_type: ID_JAG_TOKEN_TYPE,
      access_token: idJag,
      token_type: 'N_A',
      expires_in: this.issuer.lifetime,
    }
  }

  /** Rejects a malformed admin-impersonation request (not an unauthorized one). */
  private assertImpersonationRequest(input: {
    resource: string | undefined
    subjectTokenType: string
    access: VerifiedAccessClaim | undefined
    subject: { access?: unknown }
    span: import('@opentelemetry/api').Span
  }): void {
    if (!this.adminImpersonationAuthority) {
      throw new OAuthError('invalid_request', 'Admin impersonation is not enabled on this server.')
    }
    if (input.resource === undefined) {
      throw new OAuthError(
        'invalid_request',
        'Admin impersonation needs a resource (the peer storage).'
      )
    }
    if (input.subjectTokenType !== ID_JAG_TOKEN_TYPE) {
      throw new OAuthError('invalid_request', 'Admin impersonation needs an ID-JAG subject token.')
    }
    if (input.access !== undefined) {
      throw new OAuthError(
        'invalid_request',
        'Admin impersonation cannot be combined with a request access claim.'
      )
    }
    if (input.subject.access !== undefined) {
      throw new OAuthError('invalid_request', 'The admin ID-JAG must not carry an access claim.')
    }
    input.span.setAttribute('sai.lws.admin_impersonation', true)
  }

  /** The organization whose authority the request invokes. */
  private impersonationOrg(params: URLSearchParams): string {
    const org = params.get(SAI_IMPERSONATE_PARAM)
    if (!org) {
      throw new OAuthError(
        'invalid_request',
        `Admin impersonation needs the "${SAI_IMPERSONATE_PARAM}" parameter.`
      )
    }
    let url: URL
    try {
      url = new URL(org)
    } catch {
      throw new OAuthError('invalid_request', `The impersonated agent ${org} is not a WebID.`)
    }
    if (url.protocol !== 'https:') {
      throw new OAuthError(
        'invalid_request',
        `The impersonated agent ${org} is not an https WebID.`
      )
    }
    return org
  }

  /** Validates the claim of an incoming ID-JAG and binds it to the requested storage. */
  private async incomingClaim(
    access: unknown,
    context: string,
    resource: string | undefined,
    subject: string
  ): Promise<VerifiedAccessClaim> {
    try {
      return await verifyAccessClaim(access, context, resource, { assignee: subject })
    } catch (error: unknown) {
      throw new OAuthError('invalid_request', (error as Error).message)
    }
  }

  /**
   * The visible actor of an impersonation hop is the assigner of the grant that
   * backs the incoming claim (YoYo). New ID-JAG claims carry no assigner, so
   * the validator supplies it from the matched grant. The incoming subject/client
   * must still be the delegatee the claim was issued to.
   */
  private visibleSubject(
    claim: VerifiedAccessClaim,
    assigner: string | undefined,
    subject: string,
    client: string
  ): string {
    if (claim.assigners.length > 1) {
      throw new OAuthError('invalid_request', 'An ID-JAG access claim needs at most one assigner.')
    }
    if (claim.assigners.length === 1 && assigner && claim.assigners[0] !== assigner) {
      throw new OAuthError(
        'invalid_request',
        'The access claim assigner does not match the backing grant.'
      )
    }
    if (claim.assignees.some((assignee) => assignee !== subject && assignee !== client)) {
      throw new OAuthError(
        'invalid_request',
        'The incoming claim needs to be assigned to the subject or client of the ID-JAG.'
      )
    }
    const visible = assigner ?? claim.assigners[0]
    if (!visible) {
      throw new OAuthError(
        'invalid_request',
        'Could not determine the assigner of the incoming access claim.'
      )
    }
    return visible
  }

  /**
   * Validates a client-supplied claim against the assigner's grant registry.
   * The form field is kept for clients that already hold a grant; derivation
   * via `resource` is the normal app flow.
   */
  private async validateClaim(
    claim: VerifiedAccessClaim,
    subject: string,
    client: string
  ): Promise<void> {
    if (claim.assigners.length > 1) {
      throw new OAuthError('invalid_request', 'An access claim needs at most one assigner.')
    }
    const assigner = claim.assigners[0]
    try {
      const validated = await this.claimValidator!.validate({
        ...(assigner ? { assigner } : {}),
        subject,
        client,
        access: claim.access,
        context: claim.context,
        storage: claim.storage,
      })
      if (assigner && validated && validated !== assigner) {
        throw new Error('the backing grant is assigned by a different user')
      }
    } catch (error: unknown) {
      throw new OAuthError('invalid_grant', `Invalid access claim: ${(error as Error).message}`)
    }
  }

  /**
   * Parses and validates the optional ODRL `access` request parameter. The
   * parameter is a JSON-encoded array of compact ODRL policies, using the
   * bundled ID-JAG context. A request without it keeps the identity-only
   * ID-JAG shape unless `resource` lets the UAS derive a grant-backed claim.
   */
  private async accessClaim(params: URLSearchParams): Promise<VerifiedAccessClaim | undefined> {
    const values = params.getAll('access')
    if (values.length === 0) {
      return undefined
    }
    if (values.length !== 1) {
      throw new OAuthError('invalid_request', 'The access parameter must have a single value.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(values[0])
    } catch {
      throw new OAuthError('invalid_request', 'The access parameter needs to be JSON.')
    }
    try {
      return await verifyAccessClaim(parsed, ODRL_ID_JAG_CONTEXT)
    } catch (error: unknown) {
      throw new OAuthError('invalid_request', (error as Error).message)
    }
  }

  /**
   * C1 self-issued claims must be assigned by the subject (or be a delegated
   * grant to the subject, which is the first C2 hop). The assignee always has
   * to be the authenticated client or subject.
   */
  private verifyClaimIdentity(claim: VerifiedAccessClaim, subject: string, client: string): void {
    if (claim.assignees.some((assignee) => assignee !== client && assignee !== subject)) {
      throw new OAuthError(
        'invalid_request',
        'The access claim needs to be assigned to the authenticated client or subject.'
      )
    }
    // C1 self-issued claims are assigned by the subject. C2 also accepts a
    // delegated grant to the subject (assigner = hidden delegator, assignee =
    // subject) as the first hop towards the assigner's UAS.
    if (
      claim.assigners.some((assigner) => assigner !== subject) &&
      !claim.assignees.every((assignee) => assignee === subject)
    ) {
      throw new OAuthError(
        'invalid_request',
        'The access claim needs to be assigned by the authenticated subject.'
      )
    }
  }

  /**
   * Verifies the DPoP proof of the request, if there is one, and returns the
   * thumbprint of its key.
   */
  private async verifyProof(request: HttpRequest): Promise<string | undefined> {
    const proof = request.headers.dpop
    if (proof === undefined) {
      return
    }
    if (typeof proof !== 'string') {
      throw new OAuthError('invalid_dpop_proof', 'Only a single DPoP header is allowed.')
    }
    try {
      return await verifyDpopProof(proof, 'POST', this.tokenEndpoint)
    } catch (error: unknown) {
      throw new OAuthError('invalid_dpop_proof', (error as Error).message)
    }
  }

  /**
   * Reads a required request parameter that must have exactly one value.
   */
  private getParameter(params: URLSearchParams, name: string): string {
    const values = params.getAll(name)
    if (values.length !== 1) {
      throw new OAuthError(
        'invalid_request',
        `The ${name} parameter is required and must have a single value.`
      )
    }
    return values[0]
  }

  /**
   * Requires the requested audience to be one this server may issue ID-JAGs for:
   * a known storage/UAS base URL, a `.sai` interaction URL under this auth
   * service, or a `.sai` URL of a configured peer UAS. An `aud` a client can
   * pick freely would make the grant as replayable as the credential it replaced.
   */
  private async verifyAudience(audience: string): Promise<void> {
    let url: URL
    try {
      url = new URL(audience)
    } catch {
      throw new OAuthError(
        'invalid_target',
        `${audience} is not a valid authorization server identifier.`
      )
    }
    if (url.protocol !== 'https:' || url.hash !== '') {
      throw new OAuthError('invalid_target', `${audience} needs to be an https audience URL.`)
    }

    // Storage and authorization-server base URLs (the existing exact set).
    if (url.pathname === '/') {
      if (
        url.search === '' &&
        (this.matchesOrigin(
          [...this.storageOrigins, ...this.authorizationServerOrigins],
          audience
        ) ||
          this.matchesOrigin([this.issuer.issuer], audience))
      ) {
        return
      }
      throw new OAuthError(
        'invalid_target',
        `${audience} is not a storage or authorization server known to this server.`
      )
    }

    // `.sai` interaction URLs: under this auth service, or on a configured peer
    // UAS. Agent discovery uses the peer UAS base URL (the branch above).
    if (
      url.pathname.startsWith('/.sai/') &&
      (isWithinBaseUrl(audience, this.issuer.issuer) ||
        this.matchesOrigin(this.authorizationServerOrigins, audience))
    ) {
      return
    }

    throw new OAuthError(
      'invalid_target',
      `${audience} is not a storage, authorization server, or trusted .sai service known to this server.`
    )
  }

  /**
   * A registry storage advertises `sai:RegistryStorage` in its public LWS
   * storage description. Its exchange is claimless by design (ACP authorizes
   * registry resources), so the UAS must not derive an ODRL claim for it.
   * This is open-world: no deployment-local origin list is involved.
   */
  protected async isRegistryStorage(storage: string): Promise<boolean> {
    try {
      const description = await fetchLwsStorageDescription(storage, fetch)
      return !!description && descriptionHasStorageType(description, SAI.RegistryStorage)
    } catch (error: unknown) {
      // An unavailable description is an unknown storage: try the normal
      // grant derivation; the `deriving` guard still breaks the registry loop.
      this.logger.warn(
        `could not read the storage description of ${storage}: ${(error as Error).message}`
      )
      return false
    }
  }

  /** Whether the IRI belongs to one of the configured origins (URLs or bare hosts). */
  private matchesOrigin(origins: string[], iri: string): boolean {
    let url: URL
    try {
      url = new URL(iri)
    } catch {
      return false
    }
    return origins.some((origin) => {
      try {
        return new URL(origin).host === url.host
      } catch {
        // configured as a bare hostname, e.g. `data`
        return origin === url.host
      }
    })
  }

  private writeJson(response: HttpResponse, status: number, body: Record<string, unknown>): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}
