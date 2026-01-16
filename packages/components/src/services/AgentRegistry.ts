import { randomUUID } from 'node:crypto'
import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type {
  CRUDApplicationRegistration,
  CRUDSocialAgentInvitation,
  CRUDSocialAgentRegistration,
} from '@janeirodigital/interop-data-model'
import {
  Application,
  IRI,
  SocialAgent,
  SocialAgentInvitation,
  UnregisteredApplication,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { invitationUrl } from '../util/uriTemplates.js'

export const buildSocialAgentProfile = (registration: CRUDSocialAgentRegistration) =>
  // TODO (angel) data validation and how to handle when the social agents profile is missing some components?
  SocialAgent.make({
    id: IRI.make(registration.registeredAgent),
    label: registration.label,
    note: registration.note,
    //authorizationDate: registration.registeredAt!.toISOString(),
    //lastUpdateDate: registration.updatedAt?.toISOString(),
    accessGrant: registration.accessGrant?.iri,
    accessRequested: !!registration.hasAccessNeedGroup,
    accessNeedGroup: registration.reciprocalRegistration?.hasAccessNeedGroup,
  })

export const getSocialAgents = async (saiSession: AuthorizationAgent) => {
  const profiles = []
  for await (const registration of saiSession.socialAgentRegistrations) {
    profiles.push(buildSocialAgentProfile(registration))
  }
  return profiles
}

export const addSocialAgent = async (
  saiSession: AuthorizationAgent,
  data: { webId: string; label: string; note?: string }
) => {
  const existing = await saiSession.findSocialAgentRegistration(data.webId)
  if (existing) {
    // logger.error('SocialAgentRegistration already exists', { webId: data.webId })
    return buildSocialAgentProfile(existing)
  }
  const registration = await saiSession.registrySet.hasAgentRegistry.addSocialAgentRegistration(
    data.webId,
    data.label,
    data.note
  )

  return buildSocialAgentProfile(registration)
}

const buildApplicationProfile = (registration: CRUDApplicationRegistration) =>
  // TODO (angel) data validation and how to handle when the applications profile is missing some components?
  Application.make({
    id: IRI.make(registration.registeredAgent),
    name: registration.name!,
    logo: registration.logo,
    //authorizationDate: registration.registeredAt!.toISOString(),
    //lastUpdateDate: registration.updatedAt?.toISOString(),
    accessNeedGroup: registration.accessNeedGroup!,
    callbackEndpoint: registration.hasAuthorizationCallbackEndpoint,
  })
/**
 * Returns all the registered applications for the currently authenticated agent
 * @param saiSession
 */
export const getApplications = async (saiSession: AuthorizationAgent) => {
  const profiles = []
  for await (const registration of saiSession.applicationRegistrations) {
    profiles.push(buildApplicationProfile(registration))
  }
  return profiles
}

/**
 * Returns the application profile of an application that is _not_ registered for the given agent
 */
export const getUnregisteredApplication = async (agent: AuthorizationAgent, id: IRI) => {
  const { name, logo, accessNeedGroup } = await agent.factory.readable
    .clientIdDocument(id)
    .then((doc) => ({
      name: doc.clientName,
      logo: doc.logoUri,
      accessNeedGroup: doc.hasAccessNeedGroup,
    }))

  return UnregisteredApplication.make({ id: IRI.make(id), name, logo, accessNeedGroup })
}

function buildSocialAgentInvitation(socialAgentInvitation: CRUDSocialAgentInvitation) {
  return SocialAgentInvitation.make({
    id: IRI.make(socialAgentInvitation.iri),
    capabilityUrl: socialAgentInvitation.capabilityUrl,
    label: socialAgentInvitation.label,
    note: socialAgentInvitation.note,
  })
}

export async function getSocialAgentInvitations(saiSession: AuthorizationAgent) {
  const invitations = []
  for await (const invitation of saiSession.socialAgentInvitations) {
    if (!invitation.registeredAgent) {
      invitations.push(buildSocialAgentInvitation(invitation))
    }
  }
  return invitations
}

export async function createInvitation(
  saiSession: AuthorizationAgent,
  base: { label: string; note?: string }
): Promise<S.Schema.Type<typeof SocialAgentInvitation>> {
  const id = invitationUrl(saiSession.webId)
  const socialAgentInvitation =
    await saiSession.registrySet.hasAgentRegistry.addSocialAgentInvitation(
      id,
      base.label,
      base.note
    )
  return buildSocialAgentInvitation(socialAgentInvitation)
}

export async function acceptInvitation(
  saiSession: AuthorizationAgent,
  invitation: { capabilityUrl: string; label: string; note?: string }
): Promise<S.Schema.Type<typeof SocialAgent>> {
  // discover who issued the invitation
  const response = await saiSession.rawFetch(invitation.capabilityUrl, {
    method: 'POST',
  })
  if (!response.ok) throw new Error('fetching capability url failed')
  const webId = (await response.text()).trim()
  // TODO: validate with regex
  if (!webId) throw new Error('can not accept invitation without webid')
  // check if agent already has registration
  let socialAgentRegistration = await saiSession.findSocialAgentRegistration(webId)
  if (!socialAgentRegistration) {
    // create new social agent registration
    socialAgentRegistration =
      await saiSession.registrySet.hasAgentRegistry.addSocialAgentRegistration(
        webId,
        invitation.label,
        invitation.note
      )
  }
  // discover and add reciprocal
  if (!socialAgentRegistration.reciprocalRegistration) {
    socialAgentRegistration.discoverAndUpdateReciprocal(saiSession.fetch.raw)
  }

  // currently api-handler creates job for reciprocal registration

  return buildSocialAgentProfile(socialAgentRegistration)
}
