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
import { INTEROP } from './vocabularies.js'

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
    const client = {
      '@context': [
        'https://www.w3.org/ns/solid/oidc-context.jsonld',
        'https://www.w3.org/ns/solid/notifications-context/v1',
        {
          interop: 'http://www.w3.org/ns/solid/interop#',
        },
      ],
      client_id: agentId,
      'interop:hasAuthorizationRedirectEndpoint': this.authorizationEndpoint.getPath(),
    }

    const credentials = await this.credentialsExtractor.handleSafe(request)
    if (credentials.agent) {
      const regex = /[^/]+$/
      const webId = Buffer.from(agentId.match(regex)[0], 'base64url').toString('utf8')

      const sai = await this.sessionManager.getSession(webId)
      let registration
      if (sai.webId === credentials.agent.webId) {
        registration = await sai.findApplicationRegistration(credentials.client.clientId)
      } else {
        registration = await sai.findSocialAgentRegistration(credentials.agent.webId)
      }

      if (registration) {
        const info = {
          agent: credentials.client.clientId,
          registration: registration.iri,
        }
        const link = `<${info.agent}>; anchor="${info.registration}"; rel="${INTEROP.registeredAgent}"`
        addHeader(response, 'Link', link)
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
