import { ActivityRegistry, setRegisteredAgent } from '@janeirodigital/interop-authorization-agent'
import type { AgentRegistrationAdded } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import {
  BasicRepresentation,
  ForbiddenHttpError,
  OkResponseDescription,
  OperationHttpHandler,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { SessionManager } from './SessionManager'

export class InvitationHandler extends OperationHttpHandler {
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
    const credentials = await this.credentialsExtractor.handleSafe(request)
    // TODO: check clientId if authorization agent
    if (!credentials.agent?.webId) {
      throw new ForbiddenHttpError()
    }
    const capabilityUrl = operation.target.path
    const invitedId = credentials.agent.webId
    const regex = /[^/]+$/
    const encoded = capabilityUrl.match(regex)[0].split('.')[0]
    const inviteeId = Buffer.from(encoded, 'base64url').toString('utf8')
    const sai = await this.sessionManager.getSession(inviteeId)

    const socialAgentInvitation = await sai.findSocialAgentInvitation(capabilityUrl)
    if (!socialAgentInvitation) {
      throw new Error(`Social Agent Invitation not found! (capabilityUrl: ${capabilityUrl})`)
    }

    // mint-in-service (the InvitationCreated form): pre-mint the registration
    // id and write the agentRegistrationAdded activity — the
    // establishReciprocal workflow creates the registration at the minted id
    // (real-id embedded projection: no target, object.id is the changed
    // record, `registeredAgent` — the peer — rides inside) and discovers the
    // reciprocal. The activity is written only when the registration does not
    // exist yet (a duplicated POST after the workflow already created it is
    // a no-op — find-first).
    const existing = await sai.findSocialAgentRegistration(invitedId)
    if (!existing) {
      // Mint the registration id through the social-agent registry storage's
      // identifier strategy (the same minting addSocialAgentRegistration uses).
      const registrationId = await sai.mintIdentifier(
        sai.registrySet.hasSocialAgentRegistry.id,
        true
      )
      const activityRegistry = sai.registrySet.hasActivityRegistry
      if (!activityRegistry) {
        throw new Error('activity registry not found in registry set')
      }
      const activity: Omit<AgentRegistrationAdded, 'id'> = {
        type: ['Activity', 'AgentRegistrationAdded', 'as:Add'],
        actor: sai.webId,
        object: {
          id: registrationId,
          type: [INTEROP.SocialAgentRegistration],
          registeredAgent: invitedId,
          // the invitation's label is already the language map the snapshot
          // carries — pass it through (the establishReciprocal workflow
          // materializes the registration with it)
          label: socialAgentInvitation.label,
          note: socialAgentInvitation.note,
        },
        createdAt: new Date().toISOString(),
      }
      await ActivityRegistry.createActivity(
        activityRegistry,
        {
          fetch: sai.fetch,
          randomUUID: sai.randomUUID,
          identifierStrategies: sai.identifierStrategies,
        },
        activity
      )
    }

    // update invitation with agent who accepted it
    await setRegisteredAgent(socialAgentInvitation, sai.fetch, invitedId)

    const representation = new BasicRepresentation(inviteeId, operation.target, 'text/plain')
    return new OkResponseDescription(representation.metadata, representation.data)
  }
}
