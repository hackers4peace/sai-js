import {
  BadRequestHttpError,
  BasicRepresentation,
  ForbiddenHttpError,
  MethodNotAllowedHttpError,
  NotFoundHttpError,
  OkResponseDescription,
  OperationHttpHandler,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import { orgWebIdFromPath, requireOrgAdmin } from './services/adminGate.js'
import { PeerFetchError, fetchPeerResource, isJsonLdContentType } from './services/peerFetch.js'
import type { SessionManager } from './SessionManager'

/**
 * Read-only peer-data proxy for org-context reads (org-context-proxy.md,
 * direction 2 — decided).
 *
 * Route `/.sai/proxy-admin/<base64url-org-webid>?iri=<target>`, **GET
 * only**. The admin's AA (or any admin-authenticated caller) asks for a
 * peer resource (a data registration or a data instance document) by IRI;
 * this handler fetches it with the **org's** session credentials — the
 * grantee, whose data grants the peer's permission engine authorizes —
 * and returns the upstream representation to the caller. The caller's own
 * UAS never touches the peer's server (it holds no data grants).
 *
 * JSON-LD only: `Accept: application/ld+json` is pinned upstream and the
 * response is served as `application/ld+json`; binary and any other
 * representation are out of scope (no Accept forwarding, no content-type
 * passthrough).
 *
 * Gate: same as `/sparql-admin` (`requireOrgAdmin` — the caller must be an
 * admin of the org). Read-only by construction: GET only, and the proxy
 * never issues writes upstream. Peer-side access is enforced by the
 * peer's permission engine against its data grants (openwiki/architecture/federation.md §1) —
 * the org's credentials only succeed where the org holds a grant
 * (safe-by-grant; no peer allow-list needed).
 *
 * The actual upstream fetch lives in `services/peerFetch.ts`
 * (`fetchPeerResource`); `services/peerProxy.ts` is the admin-side client.
 */
export class ProxyAdminHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)

  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager
  ) {
    super()
  }

  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    if (operation.method !== 'GET') {
      throw new MethodNotAllowedHttpError(['GET'])
    }

    const orgWebId = orgWebIdFromPath(operation.target.path)
    const orgSession = await requireOrgAdmin(
      this.sessionManager,
      this.credentialsExtractor,
      request,
      orgWebId
    )

    // Target peer resource: absolute http(s) IRI in the `iri` query
    // parameter (URL-encoded by the client). The query is read from the
    // raw request URL, not `operation.target.path` — the deployment's
    // TargetExtractor strips query strings (`includeQueryString: false`),
    // so only `request.url` carries `?iri=`. Validation + fetch shared
    // with nothing on this side — `services/peerProxy.ts` is the
    // admin-side client that calls this endpoint.
    const rawTarget = new URL(request.url ?? '', 'http://dummy-base.example').searchParams.get(
      'iri'
    )
    if (!rawTarget) {
      throw new BadRequestHttpError('missing iri query parameter')
    }
    let response: Response
    try {
      response = await fetchPeerResource(orgSession, rawTarget)
    } catch (error) {
      if (error instanceof PeerFetchError) {
        throw new BadRequestHttpError(error.message)
      }
      throw error
    }
    if (!response.ok) {
      // Surface the upstream outcome to the caller: 404 for a missing
      // resource, anything else (notably 403 when the org is not actually
      // granted — the grantee-ACR hygiene gap) as forbidden.
      const detail = await response.text()
      if (response.status === 404) {
        throw new NotFoundHttpError(`upstream 404 for ${rawTarget}: ${detail}`)
      }
      throw new ForbiddenHttpError(`upstream ${response.status} for ${rawTarget}: ${detail}`)
    }
    // JSON-LD-only contract: the peer must serve the document as
    // application/ld+json (the pinned Accept); nothing else is proxied.
    const contentType = response.headers.get('content-type') ?? ''
    if (!isJsonLdContentType(contentType)) {
      throw new BadRequestHttpError(
        `upstream returned ${contentType} for ${rawTarget}; proxy serves application/ld+json only`
      )
    }
    const payload = await response.text()

    const representation = new BasicRepresentation(payload, operation.target, 'application/ld+json')
    return new OkResponseDescription(representation.metadata, representation.data)
  }
}
