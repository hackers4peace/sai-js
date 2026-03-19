import {
  type AccessGrantData,
  AuthorizationAgentFactory,
  type CRUDApplicationRegistration,
  type CRUDRegistrySet,
  type CRUDSocialAgentInvitation,
  type CRUDSocialAgentRegistration,
  type DataGrant,
  type ReadableAccessAuthorization,
  type ReadableDataAuthorization,
  type ReadableDataInstance,
  type ReadableDataRegistration,
  type ReadableShapeTree,
  type ReadableWebIdProfile,
} from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  type RdfFetch,
  type WhatwgFetch,
  asyncIterableToArray,
  discoverStorageDescription,
  fetchWrapper,
  getStorageRoot,
} from '@janeirodigital/interop-utils'
import {
  type AccessAuthorizationStructure,
  type GrantedAuthorization,
  type NestedDataAuthorizationData,
  generateAuthorization,
} from './authorization'

interface AuthorizationAgentDependencies {
  fetch: WhatwgFetch
  randomUUID(): string
}

export interface AgentWithAccess {
  agent: string
  dataAuthorization: string
  accessMode: string[]
}

// TODO: duplicates ShareAuthorization from api-messages (sai-impl-service)
export type ShareDataInstanceStructure = {
  applicationId: string
  resource: string
  accessMode: string[]
  children: {
    shapeTree: string
    accessMode: string[]
  }[]
  agents: string[]
}

// TODO: adjust if registrations are not / nested in the registry
function registryOfRegistration(dataRegistrationIri: string): string {
  return `${dataRegistrationIri.split('/').slice(0, -2).join('/')}/`
}

function formatAgentWithAccess(dataAuthorization: ReadableDataAuthorization): AgentWithAccess {
  return {
    agent: dataAuthorization.grantee,
    dataAuthorization: dataAuthorization.iri,
    accessMode: dataAuthorization.accessMode,
  }
}

export class AuthorizationAgent {
  factory: AuthorizationAgentFactory

  rawFetch: WhatwgFetch

  fetch: RdfFetch

  webIdProfile: ReadableWebIdProfile

  ownersIndex: { [key: string]: string } = {}

  registrySet: CRUDRegistrySet

  constructor(
    public webId: string,
    public agentId: string,
    dependencies: AuthorizationAgentDependencies,
    public registrySetId?: string
  ) {
    this.rawFetch = dependencies.fetch
    this.fetch = fetchWrapper(this.rawFetch)
    this.factory = new AuthorizationAgentFactory(webId, agentId, {
      fetch: this.fetch,
      randomUUID: dependencies.randomUUID,
    })
  }

  get accessAuthorizations(): AsyncIterable<ReadableAccessAuthorization> {
    return this.registrySet.hasAuthorizationRegistry.accessAuthorizations
  }

  get applicationRegistrations(): AsyncIterable<CRUDApplicationRegistration> {
    return this.registrySet.hasAgentRegistry.applicationRegistrations
  }

  public async findApplicationRegistration(
    iri: string
  ): Promise<CRUDApplicationRegistration | undefined> {
    return this.registrySet.hasAgentRegistry.findApplicationRegistration(iri)
  }

  get socialAgentRegistrations(): AsyncIterable<CRUDSocialAgentRegistration> {
    return this.registrySet.hasAgentRegistry.socialAgentRegistrations
  }

  public async findSocialAgentRegistration(
    iri: string
  ): Promise<CRUDSocialAgentRegistration | undefined> {
    return this.registrySet.hasAgentRegistry.findSocialAgentRegistration(iri)
  }

  get socialAgentInvitations(): AsyncIterable<CRUDSocialAgentInvitation> {
    return this.registrySet.hasAgentRegistry.socialAgentInvitations
  }

  public async findSocialAgentInvitation(
    iri: string
  ): Promise<CRUDSocialAgentInvitation | undefined> {
    return this.registrySet.hasAgentRegistry.findSocialAgentInvitation(iri)
  }

  public async findDataRegistration(
    dataRegistryIri: string,
    shapeTree: string
  ): Promise<ReadableDataRegistration> {
    const dataRegistry = this.registrySet.hasDataRegistry.find(
      (registry) => registry.iri === dataRegistryIri
    )
    let dataRegistration: ReadableDataRegistration
    for await (const registration of dataRegistry.registrations) {
      if (registration.registeredShapeTree === shapeTree) {
        dataRegistration = registration
        break
      }
    }
    return dataRegistration
  }

  private async findResourceServerOwner(resourceServerId: string): Promise<string> {
    const cached = this.ownersIndex[resourceServerId]
    if (cached) return cached
    let ownerId: string
    for (const dataRegistry of this.registrySet.hasDataRegistry) {
      if ((await dataRegistry.storageIri()) === resourceServerId) ownerId = this.webId
    }
    if (!ownerId) {
      for await (const socialAgentRegistration of this.socialAgentRegistrations) {
        const grant =
          socialAgentRegistration?.reciprocalRegistration?.accessGrant?.hasDataGrant.find(
            (dataGrant) => dataGrant.hasStorage === resourceServerId
          )
        if (grant) ownerId = socialAgentRegistration.registeredAgent
      }
    }
    this.ownersIndex[resourceServerId] = ownerId
  }

  public async findResourceOwner(resourceId: string): Promise<string> {
    // find storage root
    // TODO: move to utils
    const storageDescriptionIri = await discoverStorageDescription(resourceId, this.rawFetch)
    const storageDescriptionResponse = await this.fetch(storageDescriptionIri)
    const storageDescription = await storageDescriptionResponse.dataset()
    const storageRoot = getStorageRoot(storageDescription)

    return this.findResourceServerOwner(storageRoot)
  }

  public async findGrantForResource(resourceId: string, ownerId: string): Promise<DataGrant> {
    const socialAgentRegistration = await this.findSocialAgentRegistration(ownerId)
    const dataRegistrationIri = `${resourceId.split('/').slice(0, -1).join('/')}/`
    return socialAgentRegistration.reciprocalRegistration.accessGrant.hasDataGrant.find(
      (dataGtant) => dataGtant.hasDataRegistration === dataRegistrationIri
    )
  }

  public async findDataRegistrationForResource(
    resourceId: string
  ): Promise<ReadableDataRegistration> {
    const registrationId = `${resourceId.split('/').slice(0, -1).join('/')}/`
    return this.factory.readable.dataRegistration(registrationId)
  }

  public async findShapeTreeForResource(resourceId: string): Promise<ReadableShapeTree> {
    let shapeTreeId: string
    const ownerId = await this.findResourceOwner(resourceId)
    if (ownerId === this.webId) {
      const dataRegistration = await this.findDataRegistrationForResource(resourceId)
      shapeTreeId = dataRegistration.registeredShapeTree
    } else {
      const dataGrant = await this.findGrantForResource(resourceId, ownerId)
      shapeTreeId = dataGrant.registeredShapeTree
    }
    return this.factory.readable.shapeTree(shapeTreeId)
  }

  private async bootstrap(): Promise<void> {
    this.webIdProfile = await this.factory.readable.webIdProfile(this.webId)
    if (!this.registrySetId) this.registrySetId = this.webIdProfile.hasRegistrySet
    if (this.registrySetId) {
      this.registrySet = await this.factory.crud.registrySet(this.registrySetId)
    }
  }

  public static async build(
    webId: string,
    agentId: string,
    dependencies: AuthorizationAgentDependencies,
    // TODO: reorder argumets
    registrySetId?: string
  ): Promise<AuthorizationAgent> {
    const instance = new AuthorizationAgent(webId, agentId, dependencies, registrySetId)
    await instance.bootstrap()
    return instance
  }

  /*
   * Sincle solid doesn't provide atomic transactions we should follow this order
   * 1. Create Access Authorization with Data Authorizations (or reuse existing when possible)
   *    AccessAuthorization#store does it
   * 2. Update Access Authorization Registry in single request
   *   * a) Remove reference to prior Access Authorization
   *   * b) Add reference to new Access Authorization
   * TODO: reuse existing Data Authorizations wherever possible - see Data Authorization tests
   */
  public async recordAccessAuthorization(
    authorization: AccessAuthorizationStructure,
    extendIfExists = false
  ): Promise<ReadableAccessAuthorization> {
    // create data authorizations

    // TODO explore moving into AccessAuthorization
    return generateAuthorization(
      authorization,
      this.webId,
      this.registrySet.hasAuthorizationRegistry,
      this.agentId,
      this.factory,
      extendIfExists
    )
  }

  public async generateAccessGrant(accessAuthorizationIri: string): Promise<AccessGrantData> {
    const accessAuthorization =
      await this.factory.readable.accessAuthorization(accessAuthorizationIri)
    const agentRegistration = await this.registrySet.hasAgentRegistry.findRegistration(
      accessAuthorization.grantee
    )
    if (!agentRegistration) {
      throw new Error('agent registration for the grantee does not exist')
    }
    return accessAuthorization.generateAccessGrant(this.registrySet, agentRegistration)
  }

  public async findSocialAgentsWithAccess(dataInstanceIri: string): Promise<AgentWithAccess[]> {
    const agentsWithAccess = await this.findAgentsWithAccess(dataInstanceIri)
    const socialAgentsWithAccess: AgentWithAccess[] = []
    for await (const registration of this.socialAgentRegistrations) {
      const socialAgentWithAccess = agentsWithAccess.find(
        ({ agent }) => agent === registration.registeredAgent
      )
      if (socialAgentWithAccess) {
        socialAgentsWithAccess.push(socialAgentWithAccess)
      }
    }
    return socialAgentsWithAccess
  }

  public async findAgentsWithAccess(dataInstanceIri: string): Promise<AgentWithAccess[]> {
    const dataInstance = await this.factory.readable.dataInstance(dataInstanceIri)
    const shapeTree = dataInstance.dataRegistration.registeredShapeTree
    const agentsWithAccess: AgentWithAccess[] = []
    for await (const accessAuthorization of this.accessAuthorizations) {
      const dataAuthorization = (
        await asyncIterableToArray<ReadableDataAuthorization>(
          accessAuthorization.dataAuthorizations
        )
      ).find((autorization) => autorization.registeredShapeTree === shapeTree)

      if (!dataAuthorization) continue

      switch (dataAuthorization.scopeOfAuthorization) {
        case INTEROP.All.value:
          agentsWithAccess.push(formatAgentWithAccess(dataAuthorization))
          break
        case INTEROP.AllFromAgent.value:
          // TODO: rethink for delegated sharing, e.g. Alice shares project owned by ACME
          if (dataAuthorization.dataOwner === this.webId) {
            agentsWithAccess.push(formatAgentWithAccess(dataAuthorization))
          }
          break
        case INTEROP.AllFromRegistry.value:
          if (dataAuthorization.hasDataRegistration === dataInstance.dataRegistration.iri) {
            agentsWithAccess.push(formatAgentWithAccess(dataAuthorization))
          }
          break
        case INTEROP.SelectedFromRegistry.value:
          if (
            dataAuthorization.hasDataRegistration === dataInstance.dataRegistration.iri &&
            dataAuthorization.hasDataInstance.includes(dataInstanceIri)
          ) {
            agentsWithAccess.push(formatAgentWithAccess(dataAuthorization))
          }
          break
        default:
          throw new Error(
            `encountered incorect Data Authorization with scope:${dataAuthorization.scopeOfAuthorization}`
          )
      }
    }
    return agentsWithAccess
  }

  private async formatAuthorization(
    agent: string,
    dataInstance: ReadableDataInstance,
    details: ShareDataInstanceStructure
  ): Promise<GrantedAuthorization> {
    const dataAuthorization: NestedDataAuthorizationData = {
      grantee: agent,
      registeredShapeTree: dataInstance.dataRegistration.registeredShapeTree,
      scopeOfAuthorization: INTEROP.SelectedFromRegistry.value,
      dataOwner: this.webId, // TODO: delegated authorizations and trusted agents
      hasDataRegistration: dataInstance.dataRegistration.iri,
      accessMode: details.accessMode,
      hasDataInstance: [dataInstance.iri],
      children: await Promise.all(
        details.children.map(async (child) => ({
          grantee: agent,
          registeredShapeTree: child.shapeTree,
          scopeOfAuthorization: INTEROP.Inherited.value,
          dataOwner: this.webId, // TODO: delegated authorizations and trusted agents
          hasDataRegistration: (
            await this.findDataRegistration(
              registryOfRegistration(dataInstance.dataRegistration.iri),
              child.shapeTree
            )
          ).iri,
          accessMode: child.accessMode,
        }))
      ),
    }

    return {
      grantee: agent,
      granted: true,
      dataAuthorizations: [dataAuthorization],
    }
  }

  /*
   * Authorizes access to a specific Data Instance to multiple agents
   * TODO: support delegated authorization
   */
  public async shareDataInstance(details: ShareDataInstanceStructure): Promise<string[]> {
    // ensure owner doesn't grant acces for oneself
    // TODO: reconsider for TrustedGrants grantees, compare with data instance owner instead
    const requestedAgents = details.agents.filter((agent) => agent !== this.webId)
    // filter out agents who already have access
    // TODO: do we need to adjust once we handle access modes? or require separate operation for such change
    const agentsWithAccess = (await this.findSocialAgentsWithAccess(details.resource)).map(
      (obj) => obj.agent
    )
    const agents = requestedAgents.filter((agent) => !agentsWithAccess.includes(agent))

    // TODO: ensure all agents have social agent registrations, throw error

    const dataInstance = await this.factory.readable.dataInstance(details.resource)
    const authorizations = await Promise.all(
      agents.map(async (agent) => {
        const authorization = await this.formatAuthorization(agent, dataInstance, details)
        return this.recordAccessAuthorization(authorization, true)
      })
    )
    return authorizations.map((authorization) => authorization.iri)
  }
}
