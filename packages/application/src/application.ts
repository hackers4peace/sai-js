import {
  ApplicationRegistration,
  type ApplicationRegistrationData,
  type DataOwnerData,
  grantAccessModes,
} from '@janeirodigital/interop-data-model'
const loadApplicationRegistration = loader(ApplicationRegistration.fromJsonLd)

import { INTEROP } from '@janeirodigital/interop-utils'
import {
  ACCESS_ACTIONS,
  CachingIdentifierStrategyResolver,
  type IdentifierStrategyResolver,
  type WhatwgFetch,
  discoverAgentRegistration,
  discoverAuthorizationAgent,
  discoverAuthorizationRedirectEndpoint,
  discoverDescriptionResource,
  executeCreationPlan,
  loader,
} from '@janeirodigital/interop-utils'

import { getAccessGrants, getDataInstanceIterator, getGranted } from './grant.ts'

interface ApplicationDependencies {
  fetch: WhatwgFetch
  randomUUID(): string
}

type ParentInfo = {
  id: string
  scope: string
  resourceServer: string
}

type ChildInfo = {
  id: string
  scope: string
  resourceServer: string
  parent: string
}

export class Application {
  fetch: WhatwgFetch

  randomUUID: () => string

  identifierStrategies: IdentifierStrategyResolver

  authorizationAgentIri!: string

  authorizationRedirectEndpoint!: string

  registrationIri?: string

  // TODO rename
  applicationRegistration?: ApplicationRegistrationData

  public parentMap: Map<string, ParentInfo> = new Map()

  public childMap: Map<string, ChildInfo> = new Map()

  webId: string

  applicationId: string

  constructor(webId: string, applicationId: string, dependencies: ApplicationDependencies) {
    this.webId = webId
    this.applicationId = applicationId
    this.fetch = dependencies.fetch
    this.randomUUID = dependencies.randomUUID
    this.identifierStrategies = new CachingIdentifierStrategyResolver(this.fetch, this.randomUUID)
  }

  private async bootstrap(): Promise<void> {
    const authorizationAgentIri = await discoverAuthorizationAgent(this.webId, this.fetch)
    if (!authorizationAgentIri) {
      throw new Error(`cannot discover authorization agent for ${this.webId}`)
    }
    this.authorizationAgentIri = authorizationAgentIri
    this.registrationIri = await discoverAgentRegistration(this.authorizationAgentIri, this.fetch)
    this.authorizationRedirectEndpoint = await discoverAuthorizationRedirectEndpoint(
      this.authorizationAgentIri,
      this.fetch
    )
    if (!this.registrationIri) {
      return
    }
    await this.buildRegistration()
  }

  public async buildRegistration(): Promise<void> {
    if (this.registrationIri) {
      this.applicationRegistration = await loadApplicationRegistration(
        this.registrationIri,
        this.fetch
      )
    }
  }

  get authorizationRedirectUri(): string {
    return `${this.authorizationRedirectEndpoint}?client_id=${encodeURIComponent(this.applicationId)}`
  }

  getShareUri(resourceIri: string): string {
    return `${this.authorizationRedirectEndpoint}?resource=${encodeURIComponent(
      resourceIri
    )}&client_id=${encodeURIComponent(this.applicationId)}`
  }

  static async build(
    webId: string,
    applicationId: string,
    dependencies: ApplicationDependencies
  ): Promise<Application> {
    const application = new Application(webId, applicationId, dependencies)
    await application.bootstrap()
    return application
  }

  /**
   * Array of DataOwner instances out of all the data application can access.
   * @public
   */
  get dataOwners(): DataOwnerData[] {
    if (!this.applicationRegistration) {
      return []
    }
    // Note: this is now lazy — fetches access grants each time
    // The property access pattern changed from sync to async.
    // Consumers should use getDataOwnersAsync() instead.
    return []
  }

  public async getDataOwnersAsync(): Promise<DataOwnerData[]> {
    if (!this.applicationRegistration || !getGranted(this.applicationRegistration)) {
      return []
    }
    const accessGrants = await getAccessGrants(this.applicationRegistration, this.fetch)
    return accessGrants.reduce((acc, grant) => {
      let owner = acc.find((agent) => agent.id === grant.dataOwner)
      if (!owner) {
        owner = { id: grant.dataOwner, issuedGrants: [] }
        acc.push(owner)
      }
      owner.issuedGrants.push(grant)
      return acc
    }, [] as DataOwnerData[])
  }

  public async resourceOwners(): Promise<Set<string>> {
    const owners = await this.getDataOwnersAsync()
    return new Set(owners.map((dataOwner) => dataOwner.id))
  }

  public async resourceServers(resourceOwner: string, scope: string): Promise<Set<string>> {
    const owners = await this.getDataOwnersAsync()
    const dataOwner = owners.find((owner) => owner.id === resourceOwner)
    if (!dataOwner) {
      return new Set()
    }
    const grants = dataOwner.issuedGrants.filter((grant) => grant.registeredShapeTree === scope)
    return new Set(grants.map((grant) => grant.storage))
  }

  private async findGrant(storage: string, scope: string) {
    const owners = await this.getDataOwnersAsync()
    return owners
      .flatMap((owner) => owner.issuedGrants)
      .find(
        (accessGrant) =>
          accessGrant.storage === storage && accessGrant.registeredShapeTree === scope
      )
  }

  public async resources(resourceServer: string, scope: string): Promise<Set<string>> {
    const grant = await this.findGrant(resourceServer, scope)
    if (!grant) {
      throw new Error('No grant found')
    }
    if (grant.scopeOfGrant === INTEROP.Inherited) {
      throw new Error('Cannot list instances from Inherited grants')
    }
    const list: string[] = []
    for await (const resource of getDataInstanceIterator(grant, this.fetch)) {
      list.push(resource)
    }
    for (const resource of list) {
      this.parentMap.set(resource, {
        id: resource,
        scope,
        resourceServer,
      })
    }
    return new Set(list)
  }

  public childInfo(childId: string, scope: string, parentId: string): ChildInfo {
    const parentInfo = this.parentMap.get(parentId)
    if (!parentInfo) {
      throw new Error(`no parent info for ${parentId}`)
    }
    return {
      id: childId,
      scope,
      resourceServer: parentInfo.resourceServer,
      parent: parentInfo.id,
    }
  }

  public setChildInfo(childId: string, scope: string, parentId: string): void {
    this.childMap.set(childId, this.childInfo(childId, scope, parentId))
  }

  private getInfo(id: string): ParentInfo | ChildInfo {
    return (this.parentMap.get(id) || this.childMap.get(id))!
  }

  public async canCreate(resourceServer: string, scope: string): Promise<boolean> {
    const grant = await this.findGrant(resourceServer, scope)
    return grant ? grantAccessModes(grant).includes(ACCESS_ACTIONS.create) : false
  }

  public async canCreateChild(parentId: string, scope: string): Promise<boolean> {
    const parentInfo = this.parentMap.get(parentId)
    if (!parentInfo) {
      throw new Error(`no parent info for ${parentId}`)
    }
    const grant = await this.findGrant(parentInfo.resourceServer, scope)
    return grant ? grantAccessModes(grant).includes(ACCESS_ACTIONS.create) : false
  }

  public async canUpdate(id: string): Promise<boolean> {
    const info = this.getInfo(id)
    const grant = await this.findGrant(info.resourceServer, info.scope)
    return grant ? grantAccessModes(grant).includes(ACCESS_ACTIONS.modify) : false
  }

  public async canDelete(id: string): Promise<boolean> {
    const info = this.getInfo(id)
    const grant = await this.findGrant(info.resourceServer, info.scope)
    return grant ? grantAccessModes(grant).includes(ACCESS_ACTIONS.delete) : false
  }

  // TODO: rename to idForNew
  public async iriForNew(resourceServer: string, scope: string): Promise<string> {
    const grant = await this.findGrant(resourceServer, scope)
    if (!grant) {
      throw new Error('No grant found')
    }
    const registration = grant.hasDataRegistration
    const { strategy } = await this.identifierStrategies.resolve(grant.storage)
    const id = strategy.mint({ parent: registration, isContainer: false })
    // The creation plan creates the empty resource and the containment; the
    // caller writes its representation afterwards.
    await executeCreationPlan(
      strategy.create({ parent: registration, identifier: id, isContainer: false }),
      this.fetch
    )
    return id
  }

  public async iriForChild(parentId: string, scope: string): Promise<string> {
    const parentInfo = this.parentMap.get(parentId)
    if (!parentInfo) {
      throw new Error(`no parent info for ${parentId}`)
    }
    const iri = await this.iriForNew(parentInfo.resourceServer, scope)
    this.childMap.set(iri, this.childInfo(iri, scope, parentId))
    return iri
  }

  public findParent(childId: string): string {
    const child = this.childMap.get(childId)
    if (!child) {
      throw new Error(`no child info for ${childId}`)
    }
    return child.parent
  }

  public async discoverDescription(resourceIri: string): Promise<string | undefined> {
    return discoverDescriptionResource(resourceIri, this.fetch)
  }
}
