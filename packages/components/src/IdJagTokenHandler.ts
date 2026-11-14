import { setBodyAttribute, setTokenAttributes } from '@janeirodigital/interop-utils'
import { SpanStatusCode } from '@opentelemetry/api'
import {
  APPLICATION_X_WWW_FORM_URLENCODED,
  HttpHandler,
  NotImplementedHttpError,
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

import { ID_JAG_TOKEN_TYPE } from './IdJagIssuer.js'
import type { IdJagIssuer } from './IdJagIssuer.js'
import { sharedTracer } from './tracing/otel-state.js'

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
  /** Validates the subject token (an ID token, optionally DPoP-bound). */
  verifier: SubjectTokenVerifier
  /**
   * The storages this UAS issues ID-JAGs for, as hostnames (`data`) or origins
   * (`https://data.docker`). The `audience` parameter must name one of them,
   * otherwise a client could ask for a grant "for" any URL.
   */
  storageOrigins: string[]
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
 * &subject_token=<ID token>
 * &subject_token_type=urn:ietf:params:oauth:token-type:id_token
 * ```
 *
 * The subject token is verified by a {@link SubjectTokenVerifier}; a
 * sender-constrained token (`cnf.jkt`) is only accepted together with a `DPoP`
 * proof for that key, which is what lets the self-issued suite credential keep
 * working while the outgoing grants are plain audience-constrained bearer JWTs.
 *
 * This is deliberately not CSS's `LwsTokenHttpHandler`: that one only accepts
 * `resource` values that are storages *hosted by the same server*, and it only
 * issues `at+jwt` access tokens. See `docs/plans/lws-auth.md` C1.
 */
export class IdJagTokenHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this)

  private readonly issuer: IdJagIssuer
  private readonly verifier: SubjectTokenVerifier
  private readonly storageOrigins: string[]
  private readonly tokenEndpoint: string

  public constructor(args: IdJagTokenHandlerArgs) {
    super()
    this.issuer = args.issuer
    this.verifier = args.verifier
    this.storageOrigins = args.storageOrigins
    this.tokenEndpoint = new URL(args.tokenPath ?? '.well-known/lws/token', args.issuer.issuer).href
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
    const resource = params.get('resource') ?? undefined

    span.setAttributes({
      'sai.lws.grant_type': grantType,
      'sai.lws.requested_token_type': requestedTokenType,
      'sai.lws.subject_token_type': subjectTokenType,
      'sai.lws.audience': audience,
    })
    if (resource) span.setAttribute('sai.lws.resource', resource)
    if (proofKeyThumbprint) span.setAttribute('sai.lws.dpop_proof', true)
    setTokenAttributes(span, 'subject', subjectToken)

    await this.verifyAudience(audience)

    let subject
    try {
      subject = await this.verifier.handleSafe({
        token: subjectToken,
        tokenType: subjectTokenType,
        audience: this.issuer.issuer,
        proofKeyThumbprint,
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

    const idJag = await this.issuer.issue(subject.subject, subject.client, audience)
    setTokenAttributes(span, 'id-jag', idJag)

    this.logger.info(
      `Issued an ID-JAG for ${audience} to ${subject.subject} using client ${subject.client}`
    )
    return {
      issued_token_type: ID_JAG_TOKEN_TYPE,
      access_token: idJag,
      token_type: 'N_A',
      expires_in: this.issuer.lifetime,
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
   * Requires the requested audience to be one of the storages this server issues
   * ID-JAGs for: an `aud` a client can pick freely would make the grant as
   * replayable as the credential it replaced.
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
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new OAuthError(
        'invalid_target',
        `${audience} needs to be the https issuer identifier (the base URL) of a resource authorization server.`
      )
    }
    const known = this.storageOrigins.some((origin) => {
      try {
        return new URL(origin).host === url.host
      } catch {
        // configured as a bare hostname, e.g. `data`
        return origin === url.host
      }
    })
    if (!known) {
      throw new OAuthError(
        'invalid_target',
        `${audience} is not a storage known to this authorization server.`
      )
    }
  }

  private writeJson(response: HttpResponse, status: number, body: Record<string, unknown>): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}
