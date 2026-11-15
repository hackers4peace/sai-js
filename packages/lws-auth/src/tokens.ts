import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { setBodyAttribute, setTokenAttributes, withSpan } from '@janeirodigital/interop-utils'
import { context, trace } from '@opentelemetry/api'
import * as oauth from 'oauth4webapi'

/** OAuth 2.0 Token Exchange (RFC 8693) — the only grant LWS uses. */
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
/** Identity Assertion JWT Authorization Grant (draft-ietf-oauth-identity-assertion-authz-grant). */
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
/** OpenID Connect ID token — the authentication credential. */
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'
/** OAuth 2.0 access token. */
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

/** Default token endpoint path of the LWS authorization server (LWS §Authorization Server Metadata). */
export const LWS_TOKEN_PATH = '.well-known/lws/token'

/** The `token_type` of an ID-JAG response (`N_A` — it is not an OAuth access token). */
const ID_JAG_RESPONSE_TOKEN_TYPE = 'n_a'

export interface TokenEndpoint {
  /** Issuer identifier of the authorization server. */
  issuer: string
  /** Its token endpoint. */
  tokenEndpoint: string
}

interface TokenRequestOptions {
  /** Underlying fetch for the token request (tests inject a fake). */
  fetch?: WhatwgFetch
}

function authorizationServer(endpoint: TokenEndpoint): oauth.AuthorizationServer {
  return {
    issuer: endpoint.issuer,
    token_endpoint: endpoint.tokenEndpoint,
  } as oauth.AuthorizationServer
}

/**
 * Sends one RFC 8693 token exchange to `endpoint` and returns the response body.
 *
 * `DPoP` is only sent when a key pair is provided: the UAS leg needs it (the
 * subject token is sender-constrained), the storage leg does not (the ID-JAG is
 * audience-constrained instead).
 */
async function tokenExchange(
  endpoint: TokenEndpoint,
  clientId: string,
  parameters: Record<string, string>,
  options: TokenRequestOptions & {
    dpopKeyPair?: CryptoKeyPair
    recognizedTokenTypes?: oauth.RecognizedTokenTypes
  } = {}
): Promise<oauth.TokenEndpointResponse> {
  const as = authorizationServer(endpoint)
  const client: oauth.Client = { client_id: clientId }
  const requestOptions: Parameters<typeof oauth.genericTokenEndpointRequest>[5] = {}

  // `oauth4webapi` calls the fetch after awaits, so the StackContextManager's
  // active span is gone by then. Capture the client span (`withSpan`) here and
  // re-enter it synchronously around the request: the fetch instrumentation's
  // HTTP span (and its `traceparent` to the server) then nests under it.
  const activeSpan = trace.getSpan(context.active())
  const baseFetch = options.fetch ?? (globalThis.fetch as WhatwgFetch)
  requestOptions[oauth.customFetch] = ((input: RequestInfo | URL, init?: RequestInit) =>
    activeSpan
      ? context.with(trace.setSpan(context.active(), activeSpan), () =>
          baseFetch(input as RequestInfo, init)
        )
      : baseFetch(input as RequestInfo, init)) as typeof globalThis.fetch

  if (options.dpopKeyPair) requestOptions.DPoP = oauth.DPoP(client, options.dpopKeyPair)

  const response = await oauth.genericTokenEndpointRequest(
    as,
    client,
    oauth.None(),
    TOKEN_EXCHANGE_GRANT,
    new URLSearchParams(parameters),
    requestOptions
  )
  return oauth.processGenericTokenEndpointResponse(as, client, response, {
    recognizedTokenTypes: options.recognizedTokenTypes,
  })
}

export interface IdJagRequest extends TokenRequestOptions {
  /** The user's authorization server (the subject token's `iss`). */
  uas: string
  /** Its token endpoint; defaults to `<uas>/.well-known/lws/token`. */
  tokenEndpoint?: string
  /** Issuer identifier of the resource authorization server the grant is for. */
  audience: string
  /**
   * The storage the grant is for. The UAS uses it to derive the access claim
   * from the user's grants; a client no longer needs to build the claim.
   */
  resource?: string
  /** The authentication credential (ID token / self-issued JWT) or an ID-JAG. */
  subjectToken: string
  /**
   * Token type of {@link subjectToken}. Defaults to the ID token type; the C2
   * impersonation hop presents an ID-JAG (`...:id-jag`) instead.
   */
  subjectTokenType?: string
  /** DPoP key pair the credential is bound to (`cnf.jkt`). */
  dpopKeyPair: CryptoKeyPair
  clientId: string
  /** Token-flow mode for an ID-JAG subject at a UAS. Defaults to impersonation. */
  mode?: 'impersonation' | 'delegation'
  /**
   * Optional ODRL `access` claim for the storage the grant is for, as compact
   * JSON-LD policies. The UAS attaches the context; the claim is valid for one
   * storage only and carries no `resource` claim.
   */
  accessClaim?: unknown
}

/**
 * Exchanges the authentication credential for an ID-JAG that is only valid at
 * one resource authorization server (`audience`).
 */
export async function requestIdJag(request: IdJagRequest): Promise<string> {
  const subjectTokenType = request.subjectTokenType ?? ID_TOKEN_TYPE
  const parameters: Record<string, string> = {
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: request.audience,
    subject_token: request.subjectToken,
    subject_token_type: subjectTokenType,
  }
  if (request.resource !== undefined) {
    parameters.resource = request.resource
  }
  if (request.accessClaim !== undefined) {
    parameters.access = JSON.stringify(request.accessClaim)
  }
  if (request.mode !== undefined) {
    parameters.mode = request.mode
  }

  return withSpan('sai-lws', 'sai.lws.request-id-jag', async (span): Promise<string> => {
    span.setAttributes({
      'sai.lws.grant_type': TOKEN_EXCHANGE_GRANT,
      'sai.lws.requested_token_type': ID_JAG_TOKEN_TYPE,
      'sai.lws.subject_token_type': subjectTokenType,
      'sai.lws.audience': request.audience,
      'sai.lws.client_auth_method': 'none',
      ...(request.resource === undefined ? {} : { 'sai.lws.resource': request.resource }),
      ...(request.mode === undefined ? {} : { 'sai.lws.mode': request.mode }),
    })
    setTokenAttributes(span, 'subject', request.subjectToken)
    if (request.accessClaim !== undefined) {
      span.setAttribute('sai.lws.access', JSON.stringify(request.accessClaim))
    }
    setBodyAttribute(span, 'sai.lws.request.body', new URLSearchParams(parameters).toString())

    const body = await tokenExchange(
      {
        issuer: request.uas,
        tokenEndpoint: request.tokenEndpoint ?? new URL(LWS_TOKEN_PATH, request.uas).href,
      },
      request.clientId,
      parameters,
      {
        fetch: request.fetch,
        dpopKeyPair: request.dpopKeyPair,
        // The draft returns the grant in `access_token` with `token_type: N_A`.
        recognizedTokenTypes: { [ID_JAG_RESPONSE_TOKEN_TYPE]: () => undefined },
      }
    )
    setBodyAttribute(span, 'sai.lws.response.body', JSON.stringify(body))
    setTokenAttributes(span, 'id-jag', body.access_token)
    return body.access_token
  })
}

export interface AccessTokenRequest extends TokenRequestOptions {
  /** The storage's authorization server (the ID-JAG's `aud`). */
  ras: TokenEndpoint
  /** The ID-JAG obtained from the UAS for this authorization server. */
  idJag: string
  /** The storage that holds the requested resource. */
  resource: string
  clientId: string
}

/**
 * Trades an ID-JAG for a bearer access token of one storage.
 *
 * Bearer, not sender-constrained: the grant is bound by its `aud`, and the
 * issued token by the storage's `resource`.
 */
export async function requestAccessToken(
  request: AccessTokenRequest
): Promise<{ accessToken: string; expiresIn: number }> {
  const parameters = {
    subject_token: request.idJag,
    subject_token_type: ID_JAG_TOKEN_TYPE,
    resource: request.resource,
  }

  return withSpan(
    'sai-lws',
    'sai.lws.exchange-access-token',
    async (span): Promise<{ accessToken: string; expiresIn: number }> => {
      span.setAttributes({
        'sai.lws.grant_type': TOKEN_EXCHANGE_GRANT,
        'sai.lws.subject_token_type': ID_JAG_TOKEN_TYPE,
        'sai.lws.resource': request.resource,
        'sai.lws.audience': request.ras.issuer,
        'sai.lws.client_auth_method': 'none',
      })
      setTokenAttributes(span, 'id-jag', request.idJag)
      setBodyAttribute(span, 'sai.lws.request.body', new URLSearchParams(parameters).toString())

      const body = await tokenExchange(request.ras, request.clientId, parameters, {
        fetch: request.fetch,
      })
      setBodyAttribute(span, 'sai.lws.response.body', JSON.stringify(body))
      setTokenAttributes(span, 'access', body.access_token)
      return {
        accessToken: body.access_token,
        expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 300,
      }
    }
  )
}
