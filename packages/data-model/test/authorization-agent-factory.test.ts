import { randomUUID } from 'node:crypto'
import { fetch } from '@janeirodigital/interop-test-utils'
import { ACL, INTEROP } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'
import {
  AuthorizationAgentFactory,
  CRUDAgentRegistry,
  CRUDApplicationRegistration,
  CRUDAuthorizationRegistry,
  CRUDDataRegistry,
  CRUDRegistrySet,
  CRUDSocialAgentRegistration,
  ImmutableAccessAuthorization,
  ImmutableAccessGrant,
  ImmutableDataAuthorization,
  ImmutableDataGrant,
  ReadableAccessAuthorization,
  ReadableDataAuthorization,
} from '../src'

const webId = 'https://alice.example/#id'
const agentId = 'https://jarvis.alice.example/#agent'

describe('crud', () => {
  const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
  test('builds application registration', async () => {
    const agentRegistrationUrl = 'https://auth.alice.example/bcf22534-0187-4ae4-b88f-fe0f9fa96659'
    const agentRegistration = await factory.crud.applicationRegistration(agentRegistrationUrl)
    expect(agentRegistration).toBeInstanceOf(CRUDApplicationRegistration)
  })

  test('builds social agent registration', async () => {
    const agentRegistrationUrl = 'https://auth.alice.example/b1f69979-dd47-4709-b2ed-a7119f29b135'
    const agentRegistration = await factory.crud.socialAgentRegistration(agentRegistrationUrl)
    expect(agentRegistration).toBeInstanceOf(CRUDSocialAgentRegistration)
  })

  test('authorizationRegistry', async () => {
    const snippetIri = 'https://auth.alice.example/96feb105-063e-4996-ab74-5e504c6ceae5'
    const authorizationRegistry = await factory.crud.authorizationRegistry(snippetIri)
    expect(authorizationRegistry).toBeInstanceOf(CRUDAuthorizationRegistry)
  })

  test('dataRegistry', async () => {
    const snippetIri = 'https://home.alice.example/2d3d97b4-a26d-434e-afa2-e3bc8e8e2b56/'
    const dataRegistry = await factory.crud.dataRegistry(snippetIri)
    expect(dataRegistry).toBeInstanceOf(CRUDDataRegistry)
  })

  test('agentRegistry', async () => {
    const snippetIri = 'https://auth.alice.example/1cf3e08b-ffe2-465a-ac5b-94ce165cb8f0'
    const agentRegistry = await factory.crud.agentRegistry(snippetIri)
    expect(agentRegistry).toBeInstanceOf(CRUDAgentRegistry)
  })

  test('socialAgentRegistration', async () => {
    const snippetIri = 'https://auth.alice.example/5dc3c14e-7830-475f-b8e3-4748d6c0bccb'
    const socialAgentRegistration = await factory.crud.socialAgentRegistration(snippetIri)
    expect(socialAgentRegistration).toBeInstanceOf(CRUDSocialAgentRegistration)
  })
  test.skip('registrySet', async () => {
    const snippetIri = 'https://auth.alice.example/13e60d32-77a6-4239-864d-cfe2c90807c8'
    const registrySet = await factory.crud.registrySet(snippetIri)
    expect(registrySet).toBeInstanceOf(CRUDRegistrySet)
  })
})

describe('immutable', () => {
  describe('data grant', () => {
    const commonData = {
      dataOwner: 'https://alice.example/#id',
      registeredShapeTree: 'https://solidshapes.example/tree/Project',
      hasDataRegistration: 'https://pro.alice.example/123',
      accessMode: [ACL.Read.value],
    }

    test('builds AllFromRegistry data grant', async () => {
      const allFromRegistryData = {
        scopeOfGrant: INTEROP.AllFromRegistry.value,
        ...commonData,
      }
      const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
      const dataGrantIri = 'https://auth.alice.example/7b2bc4ff-b4b8-47b8-96f6-06695f4c5126'
      const dataGrant = factory.immutable.dataGrant(dataGrantIri, allFromRegistryData)
      expect(dataGrant).toBeInstanceOf(ImmutableDataGrant)
    })

    test('builds SelectedFromRegistry data grant', async () => {
      const selectedFromRegistryData = {
        scopeOfGrant: INTEROP.SelectedFromRegistry.value,
        ...commonData,
      }
      const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
      const dataGrantIri = 'https://auth.alice.example/cd247a67-0879-4301-abd0-828f63abb252'
      const dataGrant = factory.immutable.dataGrant(dataGrantIri, selectedFromRegistryData)
      expect(dataGrant).toBeInstanceOf(ImmutableDataGrant)
    })

    test('builds Inherited data grant', async () => {
      const inheritnstancesData = {
        scopeOfGrant: INTEROP.Inherited.value,
        ...commonData,
      }
      const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
      const dataGrantIri = 'https://auth.alice.example/9827ae00-2778-4655-9f22-08bb9daaee26'
      const dataGrant = factory.immutable.dataGrant(dataGrantIri, inheritnstancesData)
      expect(dataGrant).toBeInstanceOf(ImmutableDataGrant)
    })
  })

  test('builds Access Grant with Data Grant', async () => {
    const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
    const dataGrantIri = 'https://auth.alice.example/25b18e05-7f75-4e13-94f6-9950a67a89dd'
    const dataGrant = factory.immutable.dataGrant(dataGrantIri, {
      dataOwner: 'https://acme.example/#corp',
      registeredShapeTree: 'https://solidshapes.example/trees/Project',
      hasDataRegistration: 'https://finance.acme.example/4f3fbf70-49df-47ce-a573-dc54366b01ad',
      accessMode: [ACL.Read.value, ACL.Write.value],
      scopeOfGrant: INTEROP.AllFromRegistry.value,
    })
    expect(dataGrant).toBeInstanceOf(ImmutableDataGrant)
    const accessGrantData = {
      granted: true,
      grantedBy: webId,
      grantedWith: agentId,
      grantee: 'https://projectron.example/#app',
      hasAccessNeedGroup: 'https://projectron.example/#some-access-group',
      dataGrants: [dataGrant],
    }
    const accessGrantIri = 'https://auth.alice.example/5e8d3d6f-9e61-4e5c-acff-adee83b68ad1'
    const accessGrant = factory.immutable.accessGrant(accessGrantIri, accessGrantData)
    expect(accessGrant).toBeInstanceOf(ImmutableAccessGrant)
  })

  test('builds Access Authorization with Data Authorization', async () => {
    const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
    const dataAuthorizationIri = 'https://auth.alice.example/25b18e05-7f75-4e13-94f6-9950a67a89dd'
    const dataAuthorization = factory.immutable.dataAuthorization(dataAuthorizationIri, {
      grantee: 'https://projectron.example/#app',
      grantedBy: webId,
      registeredShapeTree: 'https://solidshapes.example/trees/Project',
      accessMode: [ACL.Read.value, ACL.Write.value],
      scopeOfAuthorization: INTEROP.All.value,
    })
    expect(dataAuthorization).toBeInstanceOf(ImmutableDataAuthorization)
    const accessAuthorizationData = {
      granted: true,
      grantedBy: webId,
      grantedWith: agentId,
      grantee: 'https://projectron.example/#app',
      hasAccessNeedGroup: 'https://projectron.example/#some-access-group',
      dataAuthorizations: [dataAuthorization],
    }
    const accessAuthorizationIri = 'https://auth.alice.example/5e8d3d6f-9e61-4e5c-acff-adee83b68ad1'
    const accessAuthorization = factory.immutable.accessAuthorization(
      accessAuthorizationIri,
      accessAuthorizationData
    )
    expect(accessAuthorization).toBeInstanceOf(ImmutableAccessAuthorization)
  })
})

describe('readable', () => {
  const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
  test('accessAuthorization', async () => {
    const snippetIri = 'https://auth.alice.example/eac2c39c-c8b3-4880-8b9f-a3e12f7f6372'
    const accessAuthorization = await factory.readable.accessAuthorization(snippetIri)
    expect(accessAuthorization).toBeInstanceOf(ReadableAccessAuthorization)
  })

  test('dataAuthorization', async () => {
    const snippetIri = 'https://auth.alice.example/e2765d6c-848a-4fc0-9092-556903730263'
    const dataAuthorization = await factory.readable.dataAuthorization(snippetIri)
    expect(dataAuthorization).toBeInstanceOf(ReadableDataAuthorization)
  })
})
