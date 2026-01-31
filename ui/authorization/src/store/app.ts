import * as effect from '@/effect'
import type {
  AccessAuthorization,
  AgentType,
  ApplicationList,
  Authorization,
  AuthorizationData,
  DataInstanceList,
  DataRegistryList,
  Resource,
  ShareAuthorization,
  ShareAuthorizationConfirmation,
  SocialAgent,
  SocialAgentInvitation,
  SocialAgentInvitationList,
  SocialAgentList,
  UnregisteredApplication,
} from '@janeirodigital/sai-api-messages'
import { IRI } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const lang = ref('en')
  const resource = ref<S.Schema.Type<typeof Resource> | null>(null)
  const shareAuthorizationConfirmation = ref<S.Schema.Type<
    typeof ShareAuthorizationConfirmation
  > | null>(null)
  const authorizationData = ref<S.Schema.Type<typeof AuthorizationData> | null>(null)
  const accessAuthorization = ref<S.Schema.Type<typeof AccessAuthorization> | null>(null)
  const socialAgentList = ref<S.Schema.Type<typeof SocialAgentList>>([])
  const application = ref<S.Schema.Type<typeof UnregisteredApplication>>()
  const loadedDataInstances = reactive<Record<string, S.Schema.Type<typeof DataInstanceList>>>({})
  const applicationList = ref<S.Schema.Type<typeof ApplicationList>>([])
  const dataRegistryList = reactive<Record<string, S.Schema.Type<typeof DataRegistryList>>>({})
  const invitationList = ref<S.Schema.Type<S.mutable<typeof SocialAgentInvitationList>>>([])

  async function getResource(resourceId: string) {
    resource.value = await effect.getResource(resourceId, lang.value)
  }

  async function shareResource(shareAuthorization: S.Schema.Type<typeof ShareAuthorization>) {
    shareAuthorizationConfirmation.value = await effect.shareResource(shareAuthorization)
  }

  async function getAuthoriaztion(
    agentId: string,
    agentType: AgentType,
    preferredLang = lang.value
  ) {
    authorizationData.value = await effect.getAuthoriaztionData(agentId, agentType, preferredLang)
  }

  // TODO rename list with load
  async function listDataInstances(agentId: string, registrationId: string) {
    const dataInstances = await effect.listDataInstances(
      IRI.make(agentId),
      IRI.make(registrationId)
    )
    loadedDataInstances[registrationId] = [...dataInstances]
  }

  async function listApplications(force = false) {
    if (!applicationList.value.length || force) {
      applicationList.value = await effect.listApplications()
    }
  }

  async function listSocialAgents(force = false) {
    if (!socialAgentList.value.length || force) {
      socialAgentList.value = await effect.listSocialAgents()
    }
  }

  async function listSocialAgentInvitations(force = false) {
    if (!invitationList.value.length || force) {
      invitationList.value = [...(await effect.listSocialAgentInvitations())]
    }
  }

  async function authorizeApp(authorization: S.Schema.Type<typeof Authorization>) {
    accessAuthorization.value = await effect.authorizeApp(authorization)
    listApplications(true)
    listSocialAgents(true)
  }

  async function requestAccess(applicationId: string, agentId: string) {
    await effect.requestAccessUsingApplicationNeeds(applicationId, agentId)
    listSocialAgents(true)
  }

  async function getUnregisteredApplication(applicationId: string) {
    application.value = await effect.getUnregisteredApplication(applicationId)
  }

  async function listDataRegistries(agentId: string, preferedLang = 'en') {
    const dataRegistries = await effect.listDataRegistries(agentId, preferedLang)
    dataRegistryList[agentId] = [...dataRegistries]
  }

  async function createInvitation(
    label: string,
    note?: string
  ): Promise<S.Schema.Type<typeof SocialAgentInvitation>> {
    const socialAgentInvitation = await effect.createInvitation(label, note)
    invitationList.value.push(socialAgentInvitation)
    return socialAgentInvitation
  }

  async function acceptInvitation(
    capabilityUrl: string,
    label: string,
    note?: string
  ): Promise<S.Schema.Type<typeof SocialAgent>> {
    const socialAgent = await effect.acceptInvitation(capabilityUrl, label, note)
    listSocialAgents(true)
    return socialAgent
  }

  return {
    lang,
    resource,
    authorizationData,
    accessAuthorization,
    loadedDataInstances,
    socialAgentList,
    application,
    applicationList,
    dataRegistryList,
    shareAuthorizationConfirmation,
    invitationList,
    getResource,
    shareResource,
    getAuthoriaztion,
    listDataInstances,
    authorizeApp,
    requestAccess,
    listSocialAgents,
    getUnregisteredApplication,
    listApplications,
    listDataRegistries,
    createInvitation,
    listSocialAgentInvitations,
    acceptInvitation,
  }
})
