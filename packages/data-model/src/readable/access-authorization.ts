import { INTEROP } from '@janeirodigital/interop-utils'
import { Memoize } from 'typescript-memoize'
import { type ReadableDataAuthorization, ReadableResource } from '.'
import type {
  AccessGrantData,
  AuthorizationAgentFactory,
  CRUDAgentRegistration,
  CRUDRegistrySet,
  DataGrantData,
  FinalDataGrantData,
} from '..'

// reuse equivalent data grants
// reuse all child grants if parent grant was reused
// function reuseDataGrants(
//   immutableDataGrants: ImmutableDataGrant[],
//   readableDataGrants: DataGrant[]
// ): (ImmutableDataGrant | DataGrant)[] {
//   const finalGrants: (ImmutableDataGrant | DataGrant)[] = []
//   const parentGrants = immutableDataGrants.filter(
//     (grant) => grant.data.scopeOfGrant !== INTEROP.Inherited.value
//   )
//   for (const parentGrant of parentGrants) {
//     const priorGrant = readableDataGrants.find((readableGrant) =>
//       parentGrant.checkEquivalence(readableGrant)
//     ) as AllFromRegistryDataGrant | SelectedFromRegistryDataGrant
//     if (priorGrant) {
//       finalGrants.push(priorGrant)
//       if (priorGrant.hasInheritingGrant) {
//         finalGrants.push(...priorGrant.hasInheritingGrant)
//       }
//     } else {
//       finalGrants.push(parentGrant)
//       // push all children if any
//       if (parentGrant.data.hasInheritingGrant?.length) {
//         finalGrants.push(...parentGrant.data.hasInheritingGrant)
//       }
//     }
//   }

//   return finalGrants
// }
export class ReadableAccessAuthorization extends ReadableResource {
  declare factory: AuthorizationAgentFactory

  async bootstrap(): Promise<void> {
    await this.fetchData()
  }

  public static async build(
    iri: string,
    factory: AuthorizationAgentFactory
  ): Promise<ReadableAccessAuthorization> {
    const instance = new ReadableAccessAuthorization(iri, factory)
    await instance.bootstrap()
    return instance
  }

  // TODO change to a regular array, populate in bootstrap
  get dataAuthorizations(): AsyncIterable<ReadableDataAuthorization> {
    const { factory, hasDataAuthorization } = this
    return {
      async *[Symbol.asyncIterator]() {
        for (const iri of hasDataAuthorization) {
          yield factory.readable.dataAuthorization(iri)
        }
      },
    }
  }

  @Memoize()
  get granted(): boolean {
    return this.getObject('granted').value === 'true'
  }

  @Memoize()
  get grantedBy(): string {
    return this.getObject('grantedBy').value
  }

  @Memoize()
  get grantee(): string {
    return this.getObject('grantee').value
  }

  @Memoize()
  get hasAccessNeedGroup(): string | undefined {
    return this.getObject('hasAccessNeedGroup')?.value
  }

  @Memoize()
  get hasDataAuthorization(): string[] {
    return this.getObjectsArray(INTEROP.hasDataAuthorization).map((object) => object.value)
  }

  /*
   * Generates Access Grant with Data Grants
   */

  public async generateAccessGrant(
    registrySet: CRUDRegistrySet,
    granteeRegistration: CRUDAgentRegistration
  ): Promise<AccessGrantData> {
    const sourceGrants: FinalDataGrantData[] = []
    const delegatedGrants: DataGrantData[] = []

    if (this.granted) {
      const regularAuthorizations: ReadableDataAuthorization[] = []
      for await (const dataAuthorization of this.dataAuthorizations) {
        if (dataAuthorization.scopeOfAuthorization !== INTEROP.Inherited.value) {
          regularAuthorizations.push(dataAuthorization)
        }
      }
      for (const dataAuthorization of regularAuthorizations) {
        const grants = await dataAuthorization.generateDataGrants(registrySet, granteeRegistration)
        sourceGrants.push(...grants.source)
        delegatedGrants.push(...grants.delegated)
      }
    }

    return {
      id: granteeRegistration.iriForContained(),
      grantedBy: this.factory.webId,
      grantedWith: this.factory.agentId,
      grantee: this.grantee,
      hasAccessNeedGroup: this.hasAccessNeedGroup,
      sourceGrants,
      delegatedGrants,
      granted: this.granted,
    }
  }
}
