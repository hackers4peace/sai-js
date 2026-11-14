import { setTokenAttributes } from '@janeirodigital/interop-utils'
import { SpanStatusCode } from '@opentelemetry/api'
import {
  BadRequestHttpError,
  BasicRepresentation,
  ForbiddenHttpError,
  MethodNotAllowedHttpError,
  OkResponseDescription,
  OperationHttpHandler,
  verifyDpopProof,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { IdTokenIssuer } from './IdTokenIssuer.js'
import { sharedTracer } from './tracing/otel-state.js'
import { agentId } from './util/uriTemplates.js'

/**
 * Hands the SAI UI a **DPoP-bound self-issued credential** for its own session,
 * so the browser can run the two-step LWS chain itself (ID token → ID-JAG per
 * storage AS → access token) instead of asking the server for storage tokens.
 *
 * Route `/.sai/id-token?dpop_jkt=<thumbprint>[&client_id=<iri>]`, **GET** only.
 *
 * The caller is authenticated by the regular CSS credentials extractor (the
 * Solid-OIDC session the UI already holds), so the credential can only speak
 * for the session's own WebID. The `cnf.jkt` binds it to the browser's DPoP key;
 * without that key the credential cannot be exchanged (the UAS requires a DPoP
 * proof matching `cnf.jkt` at its token endpoint), so the response is useless to
 * anyone who intercepts it.
 *
 * When the request carries a `DPoP` proof, that proof is authoritative: its key
 * is the binding (`cnf.jkt`) and a `dpop_jkt` parameter must match it
 * (RFC 9449 §10.1, "if both are present they MUST match"). Without a proof the
 * parameter declares the key, which is all a bearer or cookie session can do.
 */
export class IdTokenHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)

  private readonly credentialsExtractor: CredentialsExtractor
  private readonly issuer: IdTokenIssuer
  private readonly tokenEndpoint: string

  public constructor(credentialsExtractor: CredentialsExtractor, issuer: IdTokenIssuer) {
    super()
    this.credentialsExtractor = credentialsExtractor
    this.issuer = issuer
    this.tokenEndpoint = new URL('.sai/id-token', issuer.issuer).href
  }

  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    if (operation.method !== 'GET') {
      throw new MethodNotAllowedHttpError(['GET'])
    }

    const span = sharedTracer('sai-lws').startSpan('sai.lws.issue-id-token')
    try {
      const credentials = await this.credentialsExtractor.handleSafe(request)
      const webId = credentials.agent?.webId
      if (!webId) {
        throw new ForbiddenHttpError('authentication is required to obtain an ID token')
      }

      // The query is read from the raw request URL: the deployment's
      // TargetExtractor strips query strings.
      const search = new URL(request.url ?? '', 'http://dummy-base.example').searchParams
      const declaredJkt = search.get('dpop_jkt')

      // A DPoP proof wins: it names the key the browser proved possession of.
      // `dpop_jkt` only declares the binding when the caller has no proof for
      // that key (e.g. a bearer session); RFC 9449 §10.1 requires both to match
      // when both are present.
      let dpopJkt = declaredJkt
      let dpopProof = false
      const proof = request.headers.dpop
      if (proof !== undefined) {
        if (typeof proof !== 'string') {
          throw new BadRequestHttpError('only a single DPoP header is allowed')
        }
        const proofJkt = await verifyDpopProof(proof, 'GET', this.tokenEndpoint).catch(
          (error: unknown) => {
            throw new BadRequestHttpError(`invalid DPoP proof: ${(error as Error).message}`)
          }
        )
        if (declaredJkt !== null && declaredJkt !== proofJkt) {
          throw new BadRequestHttpError('the DPoP proof does not match dpop_jkt')
        }
        dpopJkt = proofJkt
        dpopProof = true
      }
      if (!dpopJkt) {
        throw new BadRequestHttpError('missing dpop_jkt query parameter or DPoP proof')
      }

      const clientId = search.get('client_id') ?? agentId(webId)
      const idToken = await this.issuer.issue(webId, clientId, dpopJkt)

      span.setAttributes({
        'sai.lws.subject_id': webId,
        'sai.lws.client_id': clientId,
        'sai.lws.dpop_jkt': dpopJkt,
        'sai.lws.dpop_proof': dpopProof,
        'sai.lws.dpop_jkt_source': dpopProof ? 'proof' : 'query',
      })
      setTokenAttributes(span, 'subject', idToken)
      this.logger.info(`Issued a DPoP-bound ID token for ${webId} to client ${clientId}`)

      const body = JSON.stringify({
        id_token: idToken,
        token_type: 'N_A',
        expires_in: this.issuer.lifetime,
        issuer: this.issuer.issuer,
      })
      const representation = new BasicRepresentation(body, operation.target, 'application/json')
      return new OkResponseDescription(representation.metadata, representation.data)
    } catch (error: unknown) {
      span.setAttribute('sai.lws.error', (error as Error).message)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
      throw error
    } finally {
      span.end()
    }
  }
}
