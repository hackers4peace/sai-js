import { INTEROP, asyncIterableToArray } from '@janeirodigital/interop-utils'
import { Memoize } from 'typescript-memoize'
import { ReadableResource, type SelectedFromRegistryDataGrant } from '.'
import type {
  AuthorizationAgentFactory,
  CRUDAgentRegistration,
  CRUDRegistrySet,
  DataGrantData,
  FinalDataGrantData,
  InheritableDataGrant,
  ReadableDataRegistration,
} from '..'

interface SourceAndDelegatedGrants {
  source: FinalDataGrantData[]
  delegated: DataGrantData[]
}

export class ReadableDataAuthorization extends ReadableResource {
  declare factory: AuthorizationAgentFactory

  hasInheritingAuthorization: ReadableDataAuthorization[]

  async inheritingAuthorizations(): Promise<ReadableDataAuthorization[]> {
    const childIris = this.getSubjectsArray(INTEROP.inheritsFromAuthorization).map(
      (subject) => subject.value
    )
    return Promise.all(childIris.map((iri) => this.factory.readable.dataAuthorization(iri)))
  }

  async bootstrap(): Promise<void> {
    await this.fetchData()
    this.hasInheritingAuthorization = await this.inheritingAuthorizations()
  }

  @Memoize()
  get grantee(): string {
    return this.getObject('grantee').value
  }

  @Memoize()
  get registeredShapeTree(): string {
    return this.getObject('registeredShapeTree').value
  }

  @Memoize()
  get scopeOfAuthorization(): string {
    return this.getObject('scopeOfAuthorization').value
  }

  @Memoize()
  get grantedBy(): string {
    return this.getObject('grantedBy').value
  }

  @Memoize()
  get dataOwner(): string | undefined {
    return this.getObject('dataOwner')?.value
  }

  @Memoize()
  get accessMode(): string[] {
    return this.getObjectsArray('accessMode').map((object) => object.value)
  }

  @Memoize()
  get hasDataRegistration(): string | undefined {
    return this.getObject('hasDataRegistration')?.value
  }

  @Memoize()
  get hasDataInstance(): string[] {
    return this.getObjectsArray('hasDataInstance').map((obj) => obj.value)
  }

  public static async build(
    iri: string,
    factory: AuthorizationAgentFactory
  ): Promise<ReadableDataAuthorization> {
    const instance = new ReadableDataAuthorization(iri, factory)
    await instance.bootstrap()
    return instance
  }

  private generateChildDelegatedGrantData(
    parentGrantIri: string,
    sourceGrant: InheritableDataGrant,
    registrySet: CRUDRegistrySet
  ): DataGrantData[] {
    return this.hasInheritingAuthorization
      .map((childAuthorization) => {
        const childGrantIri = registrySet.hasGrantRegistry.iriForContained()
        const childSourceGrant = [...sourceGrant.hasInheritingGrant].find(
          (grant) => grant.registeredShapeTree === childAuthorization.registeredShapeTree
        )
        if (!childSourceGrant) {
          return null
        }
        const childData: DataGrantData = {
          id: childGrantIri,
          grantee: this.grantee,
          grantedBy: this.grantedBy,
          dataOwner: childSourceGrant.dataOwner,
          registeredShapeTree: childAuthorization.registeredShapeTree,
          hasDataRegistration: childSourceGrant.hasDataRegistration,
          hasStorage: childSourceGrant.hasStorage,
          scopeOfGrant: INTEROP.Inherited.value,
          accessMode: childAuthorization.accessMode.filter((mode) =>
            childSourceGrant.accessMode.includes(mode)
          ),
          inheritsFromGrant: parentGrantIri,
          delegationOfGrant: childSourceGrant.iri,
        }
        return childData
      })
      .filter(Boolean) as DataGrantData[]
  }

  private async generateDelegatedDataGrants(
    registrySet: CRUDRegistrySet,
    granteeRegistration: CRUDAgentRegistration
  ): Promise<DataGrantData[]> {
    if (this.scopeOfAuthorization === INTEROP.Inherited.value) {
      throw new Error(
        'this method should not be callend on data authorizations with Inherited scope'
      )
    }
    const result: DataGrantData[] = []

    for await (const agentRegistration of registrySet.hasAgentRegistry.socialAgentRegistrations) {
      // data onwer is specified but it is not their registration
      if (this.dataOwner && this.dataOwner !== agentRegistration.registeredAgent) {
        continue
      }
      // don't create delegated data grants for data owned by the grantee (registeredAgent)
      if (this.grantee === agentRegistration.registeredAgent) {
        continue
      }
      const accessGrantIri = agentRegistration.reciprocalRegistration?.hasAccessGrant

      if (!accessGrantIri) continue

      const accessGrant = await this.factory.readable.accessGrant(accessGrantIri)

      let matchingDataGrants = accessGrant.hasDataGrant.filter(
        (grant) => grant.registeredShapeTree === this.registeredShapeTree
      )
      if (this.hasDataRegistration) {
        matchingDataGrants = matchingDataGrants.filter(
          (grant) => grant.hasDataRegistration === this.hasDataRegistration
        )
      }

      for (const sourceGrant of matchingDataGrants) {
        const regularGrantIri = registrySet.hasGrantRegistry.iriForContained()

        const childGrantData: DataGrantData[] = this.generateChildDelegatedGrantData(
          regularGrantIri,
          sourceGrant as InheritableDataGrant,
          registrySet
        )
        const data: DataGrantData = {
          id: regularGrantIri,
          grantee: this.grantee,
          grantedBy: this.grantedBy,
          dataOwner: sourceGrant.dataOwner,
          registeredShapeTree: sourceGrant.registeredShapeTree,
          hasDataRegistration: sourceGrant.hasDataRegistration,
          hasStorage: sourceGrant.hasStorage,
          scopeOfGrant: sourceGrant.scopeOfGrant.value,
          delegationOfGrant: sourceGrant.iri,
          accessMode: this.accessMode.filter((mode) => sourceGrant.accessMode.includes(mode)),
        }
        if (sourceGrant.scopeOfGrant.value === INTEROP.SelectedFromRegistry.value) {
          data.hasDataInstance = [...(sourceGrant as SelectedFromRegistryDataGrant).hasDataInstance]
        }
        if (childGrantData.length) {
          data.hasInheritingGrant = childGrantData
        }
        result.push(data, ...childGrantData)
      }
    }
    return result
  }

  private generateChildSourceGrantData(
    parentGrantIri: string,
    dataRegistrations: ReadableDataRegistration[],
    registrySet: CRUDRegistrySet,
    storageIri: string
  ): FinalDataGrantData[] {
    return this.hasInheritingAuthorization
      .map((childAuthorization) => {
        const childGrantIri = registrySet.hasGrantRegistry.iriForContained()
        const dataRegistration = dataRegistrations.find(
          (registration) =>
            registration.registeredShapeTree === childAuthorization.registeredShapeTree
        )
        if (!dataRegistration) {
          return null
        }
        const childData: FinalDataGrantData = {
          id: childGrantIri,
          grantee: childAuthorization.grantee,
          grantedBy: childAuthorization.grantedBy,
          dataOwner: childAuthorization.grantedBy,
          registeredShapeTree: childAuthorization.registeredShapeTree,
          hasDataRegistration: dataRegistration.iri,
          hasStorage: storageIri,
          scopeOfGrant: INTEROP.Inherited.value,
          accessMode: childAuthorization.accessMode,
          inheritsFromGrant: parentGrantIri,
        }
        return childData
      })
      .filter(Boolean)
  }

  private async generateSourceDataGrants(
    registrySet: CRUDRegistrySet,
    granteeRegistration: CRUDAgentRegistration
  ): Promise<FinalDataGrantData[]> {
    if (this.scopeOfAuthorization === INTEROP.Inherited.value) {
      throw new Error(
        'this method should not be callend on data authorizations with Inherited scope'
      )
    }

    const result: FinalDataGrantData[] = []

    for (const dataRegistry of registrySet.hasDataRegistry) {
      // FIXME handle each data registry independently

      const dataRegistrations = await asyncIterableToArray(dataRegistry.registrations)

      let matchingRegistration: ReadableDataRegistration

      if (this.hasDataRegistration) {
        // match registration if specified
        matchingRegistration = dataRegistrations.find(
          (registration) => registration.iri === this.hasDataRegistration
        )
      } else {
        // match shape tree
        matchingRegistration = dataRegistrations.find(
          (registration) => registration.registeredShapeTree === this.registeredShapeTree
        )
      }

      if (!matchingRegistration) continue

      // create source grant
      const regularGrantIri = registrySet.hasGrantRegistry.iriForContained()

      // create children if needed
      const childGrantData: FinalDataGrantData[] = this.generateChildSourceGrantData(
        regularGrantIri,
        dataRegistrations,
        registrySet,
        await dataRegistry.storageIri()
      )

      let scopeOfGrant = INTEROP.AllFromRegistry.value
      if (this.scopeOfAuthorization === INTEROP.SelectedFromRegistry.value)
        scopeOfGrant = INTEROP.SelectedFromRegistry.value
      const data: FinalDataGrantData = {
        id: regularGrantIri,
        grantee: this.grantee,
        grantedBy: this.grantedBy,
        dataOwner: this.grantedBy,
        registeredShapeTree: this.registeredShapeTree,
        hasDataRegistration: matchingRegistration.iri,
        hasStorage: await dataRegistry.storageIri(),
        scopeOfGrant,
        accessMode: this.accessMode,
      }
      if (this.hasDataInstance.length) {
        data.hasDataInstance = this.hasDataInstance
      }
      if (childGrantData.length) {
        data.hasInheritingGrant = childGrantData
      }
      result.push(data, ...childGrantData)
    }

    if (!result.length) throw new Error('no data grants were generated!')
    return result
  }

  public async generateDataGrants(
    registrySet: CRUDRegistrySet,
    granteeRegistration: CRUDAgentRegistration
  ): Promise<SourceAndDelegatedGrants> {
    const dataGrantData: SourceAndDelegatedGrants = {
      source: [],
      delegated: [],
    }
    /* Source grants are only created if Data Authorization is registred by the data owner.
     * This can only happen with scope:
     * - All - there will be no dataOwner set
     * - AllFromAgent - dataOwner will equal grantedBy
     * - lower with same condition as previous
     * Otherwise only delegated data grants are created
     */
    if (!this.dataOwner || this.dataOwner === this.grantedBy) {
      dataGrantData.source = await this.generateSourceDataGrants(registrySet, granteeRegistration)
    }

    // do not create delegated data grants if granted by data owner, source grants will be created instead
    /* Delegated grants are only created for data owned by others than agent granting the authorization
     * This can only happen with scopes:
     * - All - there will be no dataOwner set
     * - All From Agent - dataOwner will be different than grantedBy
     * - lower with same condition as previous
     * Otherwise only source data grants are created
     */
    if (!this.dataOwner || this.dataOwner !== this.grantedBy) {
      dataGrantData.delegated = await this.generateDelegatedDataGrants(
        registrySet,
        granteeRegistration
      )
    }

    return dataGrantData
  }
}
