import {
  type AccessAuthorizationData,
  type AccessGrantData,
  type AgentRegistrationData,
  BaseFactory,
  type BaseReadableFactory,
  CRUDAgentRegistry,
  CRUDApplicationRegistration,
  CRUDAuthorizationRegistry,
  CRUDDataRegistration,
  CRUDDataRegistry,
  CRUDGrantRegistry,
  CRUDRegistrySet,
  CRUDSocialAgentInvitation,
  CRUDSocialAgentRegistration,
  type DataGrantData,
  type DataRegistrationData,
  type ExpandedDataAuthorizationData,
  type FactoryDependencies,
  ImmutableAccessAuthorization,
  ImmutableAccessGrant,
  ImmutableDataAuthorization,
  ImmutableDataGrant,
  ReadableAccessAuthorization,
  ReadableAccessDescriptionSet,
  ReadableAccessNeed,
  ReadableAccessNeedDescription,
  ReadableAccessNeedGroup,
  ReadableAccessNeedGroupDescription,
  ReadableDataAuthorization,
  type SocialAgentInvitationData,
  type SocialAgentRegistrationData,
} from '.'
import type { CRUDRegistrySetData } from './crud/registry-set'
import type { CRUDData } from './crud/resource'

interface AuthorizationAgentReadableFactory extends BaseReadableFactory {
  accessAuthorization(iri: string): Promise<ReadableAccessAuthorization>
  dataAuthorization(iri: string): Promise<ReadableDataAuthorization>
  accessNeedDescription(iri: string): Promise<ReadableAccessNeedDescription>
  accessNeedGroupDescription(iri: string): Promise<ReadableAccessNeedGroupDescription>
  accessDescriptionSet(iri: string): Promise<ReadableAccessDescriptionSet>
  accessNeed(iri: string, descriptionLang?: string): Promise<ReadableAccessNeed>
  accessNeedGroup(iri: string, descriptionLang?: string): Promise<ReadableAccessNeedGroup>
}
interface CRUDFactory {
  applicationRegistration(
    iri: string,
    data?: AgentRegistrationData
  ): Promise<CRUDApplicationRegistration>
  socialAgentRegistration(
    iri: string,
    reciprocal?: boolean,
    data?: SocialAgentRegistrationData
  ): Promise<CRUDSocialAgentRegistration>
  socialAgentInvitation(
    iri: string,
    data?: SocialAgentInvitationData
  ): Promise<CRUDSocialAgentInvitation>
  dataRegistry(iri: string, data?: CRUDData): Promise<CRUDDataRegistry>
  dataRegistration(iri: string, data?: DataRegistrationData): Promise<CRUDDataRegistration>
  authorizationRegistry(iri: string, data?: CRUDData): Promise<CRUDAuthorizationRegistry>
  grantRegistry(iri: string, data?: CRUDData): Promise<CRUDGrantRegistry>
  agentRegistry(iri: string, data?: CRUDData): Promise<CRUDAgentRegistry>
  registrySet(iri: string, data?: CRUDRegistrySetData): Promise<CRUDRegistrySet>
}

interface ImmutableFactory {
  dataGrant(iri: string, data: DataGrantData): ImmutableDataGrant
  accessGrant(iri: string, data: AccessGrantData): ImmutableAccessGrant
  dataAuthorization(iri: string, data: ExpandedDataAuthorizationData): ImmutableDataAuthorization
  accessAuthorization(iri: string, data: AccessAuthorizationData): ImmutableAccessAuthorization
}

export class AuthorizationAgentFactory extends BaseFactory {
  declare readable: AuthorizationAgentReadableFactory

  immutable: ImmutableFactory

  crud: CRUDFactory

  constructor(
    public webId: string,
    public agentId: string,
    dependencies: FactoryDependencies
  ) {
    super(dependencies)

    this.readable = this.readableFactory()
    this.immutable = this.immutableFactory()
    this.crud = this.crudFactory()
  }

  private crudFactory(): CRUDFactory {
    const factory = this
    return {
      applicationRegistration: async function applicationRegistration(
        iri: string,
        data?: AgentRegistrationData
      ): Promise<CRUDApplicationRegistration> {
        return CRUDApplicationRegistration.build(iri, factory, data)
      },
      socialAgentRegistration: async function socialAgentRegistration(
        iri: string,

        reciprocal = false,
        data?: SocialAgentRegistrationData
      ): Promise<CRUDSocialAgentRegistration> {
        return CRUDSocialAgentRegistration.build(iri, factory, reciprocal, data)
      },
      socialAgentInvitation: async function socialAgentInvitation(
        iri: string,
        data?: SocialAgentInvitationData
      ): Promise<CRUDSocialAgentInvitation> {
        return CRUDSocialAgentInvitation.build(iri, factory, data)
      },
      dataRegistry: async function dataRegistry(
        iri: string,
        data?: CRUDData
      ): Promise<CRUDDataRegistry> {
        return CRUDDataRegistry.build(iri, factory, data)
      },
      dataRegistration: async function dataRegistration(
        iri: string,
        data?: DataRegistrationData
      ): Promise<CRUDDataRegistration> {
        return CRUDDataRegistration.build(iri, factory, data)
      },
      authorizationRegistry: async function authorizationRegistry(
        iri: string,
        data?: CRUDData
      ): Promise<CRUDAuthorizationRegistry> {
        return CRUDAuthorizationRegistry.build(iri, factory, data)
      },
      grantRegistry: async function grantRegistry(
        iri: string,
        data?: CRUDData
      ): Promise<CRUDGrantRegistry> {
        return CRUDGrantRegistry.build(iri, factory, data)
      },
      agentRegistry: async function agentRegistry(
        iri: string,
        data?: CRUDData
      ): Promise<CRUDAgentRegistry> {
        return CRUDAgentRegistry.build(iri, factory, data)
      },
      registrySet: async function registrySet(
        iri: string,
        data?: CRUDRegistrySetData
      ): Promise<CRUDRegistrySet> {
        return CRUDRegistrySet.build(iri, factory, data)
      },
    }
  }

  private immutableFactory(): ImmutableFactory {
    const factory = this
    return {
      dataGrant: function dataGrant(iri: string, data: DataGrantData): ImmutableDataGrant {
        return new ImmutableDataGrant(iri, factory, data)
      },
      accessGrant: function accessGrant(iri: string, data: AccessGrantData): ImmutableAccessGrant {
        return new ImmutableAccessGrant(iri, factory, data)
      },
      dataAuthorization: function dataAuthorization(
        iri: string,
        data: ExpandedDataAuthorizationData
      ): ImmutableDataAuthorization {
        return new ImmutableDataAuthorization(iri, factory, data)
      },
      accessAuthorization: function accessAuthorization(
        iri: string,
        data: AccessAuthorizationData
      ): ImmutableAccessAuthorization {
        return new ImmutableAccessAuthorization(iri, factory, data)
      },
    }
  }

  protected readableFactory() {
    const factory = this
    return {
      accessAuthorization: async function accessAuthorization(
        iri: string
      ): Promise<ReadableAccessAuthorization> {
        return ReadableAccessAuthorization.build(iri, factory)
      },
      dataAuthorization: async function dataAuthorization(
        iri: string
      ): Promise<ReadableDataAuthorization> {
        return ReadableDataAuthorization.build(iri, factory)
      },
      accessNeedDescription: async function accessNeedDescription(
        iri: string
      ): Promise<ReadableAccessNeedDescription> {
        return ReadableAccessNeedDescription.build(iri, factory)
      },
      accessNeedGroupDescription: async function accessNeedGroupDescription(
        iri: string
      ): Promise<ReadableAccessNeedGroupDescription> {
        return ReadableAccessNeedGroupDescription.build(iri, factory)
      },
      accessDescriptionSet: async function accessDescription(
        iri: string
      ): Promise<ReadableAccessDescriptionSet> {
        return ReadableAccessDescriptionSet.build(iri, factory)
      },
      accessNeed: async function accessNeed(
        iri: string,
        descriptionLang?: string
      ): Promise<ReadableAccessNeed> {
        return ReadableAccessNeed.build(iri, factory, descriptionLang)
      },
      accessNeedGroup: async function accessNeedGroup(
        iri: string,
        descriptionLang?: string
      ): Promise<ReadableAccessNeedGroup> {
        return ReadableAccessNeedGroup.build(iri, factory, descriptionLang)
      },
      ...super.readableFactory(),
    }
  }
}
