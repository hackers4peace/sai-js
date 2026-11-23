import { getAdminGrantIris } from '@janeirodigital/interop-data-model'
import type { SocialAgentRegistrationData } from '@janeirodigital/interop-data-model'
import { INTEROP, LWS } from '@janeirodigital/interop-utils'
import {
  BasicRepresentation,
  OkResponseDescription,
  OperationHttpHandler,
  addHeader,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  InteractionRoute,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { SessionManager } from './SessionManager'
import { accessGrantsUrl, accessRequestsUrl } from './util/uriTemplates.js'

const CID_MEDIA_TYPE = 'application/cid'

export class AgentIdHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager,
    private readonly authorizationEndpoint: InteractionRoute
  ) {
    super()
  }
  public async handle({
    operation,
    request,
    response,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const agentId = operation.target.path
    const webId = Buffer.from(agentId.match(/[^/]+$/u)[0], 'base64url').toString('utf8')
    const accessRequests = accessRequestsUrl(webId)
    const accessGrants = accessGrantsUrl(webId)

    const accept = request.headers.accept ?? ''
    if (accept.includes(CID_MEDIA_TYPE)) {
      addHeader(response, 'Vary', 'Accept')
      const cid = {
        '@context': 'https://www.w3.org/ns/cid/v1',
        id: agentId,
        service: [
          { type: INTEROP.AuthorizationAgent, serviceEndpoint: agentId },
          { type: LWS.AccessRequestService, serviceEndpoint: accessRequests },
          { type: LWS.AccessGrantService, serviceEndpoint: accessGrants },
        ],
      }
      const representation = new BasicRepresentation(
        JSON.stringify(cid),
        operation.target,
        CID_MEDIA_TYPE
      )
      return new OkResponseDescription(representation.metadata, representation.data)
    }

    const client = {
      '@context': [
        'https://www.w3.org/ns/solid/oidc-context.jsonld',
        'https://www.w3.org/ns/solid/notifications-context/v1',
        {
          interop: 'http://www.w3.org/ns/solid/interop#',
          lws: 'https://www.w3.org/ns/lws#',
        },
      ],
      client_id: agentId,
      'interop:hasAuthorizationRedirectEndpoint': this.authorizationEndpoint.getPath(),
      'lws:AccessRequestService': accessRequests,
      'lws:AccessGrantService': accessGrants,
    }

    const credentials = await this.credentialsExtractor.handleSafe(request)
    if (credentials.agent) {
      const sai = await this.sessionManager.getSession(webId)
      const isOwner = sai.webId === credentials.agent.webId
      const registration = isOwner
        ? await sai.findApplicationRegistration(credentials.client.clientId)
        : await sai.findSocialAgentRegistration(credentials.agent.webId)

      if (registration) {
        const info = {
          agent: credentials.client.clientId,
          registration: registration.id,
        }
        const link = `<${info.agent}>; anchor="${info.registration}"; rel="${INTEROP.registeredAgent}"`
        addHeader(response, 'Link', link)

        // phase-2 org context: an admin of the org gets a second link exposing
        // the org's RegistrySet IRI (only when requesting a doc that is not
        // their own — the social-agent branch above). The header is
        // evaluated against request credentials, so the admin-only link stays
        // private while the body remains public.
        if (!isOwner) {
          const adminGrantIris = getAdminGrantIris(registration as SocialAgentRegistrationData)
          if (adminGrantIris.length > 0) {
            addHeader(response, 'Link', `<${sai.registrySet.id}>; rel="${INTEROP.hasRegistrySet}"`)
          }
        }
      }
    }

    const representation = new BasicRepresentation(
      JSON.stringify(client),
      operation.target,
      'application/ld+json'
    )
    return new OkResponseDescription(representation.metadata, representation.data)
  }
}
