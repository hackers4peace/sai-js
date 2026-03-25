import { randomUUID } from 'node:crypto'
import {
  CRUDApplicationRegistration,
  type CRUDDataRegistry,
  CRUDRegistrySet,
  CRUDSocialAgentRegistration,
  ReadableAccessAuthorization,
  type ReadableDataAuthorization,
  type ReadableDataInstance,
  type ReadableDataRegistration,
  ReadableWebIdProfile,
} from '@janeirodigital/interop-data-model'
import { createStatefulFetch, statelessFetch } from '@janeirodigital/interop-test-utils'
import { ACL, INTEROP, asyncIterableToArray } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type AccessAuthorizationStructure,
  AuthorizationAgent,
  type ShareDataInstanceStructure,
} from '../src'

const webId = 'https://alice.example/#id'
const agentId = 'https://alice.jarvis.example/#agent'
const registryId = 'https://auth.alice.example/13e60d32-77a6-4239-864d-cfe2c90807c8'

describe.skip('authorization agent', () => {
  test('should build webIdProfile', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    expect(agent.webIdProfile).toBeInstanceOf(ReadableWebIdProfile)
    expect(agent.webIdProfile.iri).toBe(webId)
  })

  test('should build registrySet', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    const registrySetIri = 'https://auth.alice.example/13e60d32-77a6-4239-864d-cfe2c90807c8'
    expect(agent.registrySet).toBeInstanceOf(CRUDRegistrySet)
    expect(agent.registrySet.iri).toBe(registrySetIri)
  })

  test('have access to all the access authorizations', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    let count = 0
    for await (const authorization of agent.accessAuthorizations) {
      count += 1
      expect(authorization).toBeInstanceOf(ReadableAccessAuthorization)
    }
    expect(count).toBe(2)
  })

  test('have access to all the application registrations', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    let count = 0
    for await (const authorization of agent.applicationRegistrations) {
      count += 1
      expect(authorization).toBeInstanceOf(CRUDApplicationRegistration)
    }
    expect(count).toBe(2)
  })

  test('should provide shortcut to find application registratons', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    const spy = vi.spyOn(agent.registrySet.hasAgentRegistry, 'findApplicationRegistration')
    const iri = 'https://projectron.example/#app'
    await agent.findApplicationRegistration(iri)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(iri)
  })

  test('have access to all the social agent registrations', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    let count = 0
    for await (const authorization of agent.socialAgentRegistrations) {
      count += 1
      expect(authorization).toBeInstanceOf(CRUDSocialAgentRegistration)
    }
    expect(count).toBe(2)
  })

  test('should provide shortcut to find social agent registratons', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    const spy = vi.spyOn(agent.registrySet.hasAgentRegistry, 'findSocialAgentRegistration')
    const iri = 'https://alice.example/#id'
    await agent.findSocialAgentRegistration(iri)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(iri)
  })

  // TODO move tests to authorization-test and only test re-mapping here
  describe('recordAccessAuthorization', () => {
    const accessAuthorizationData = {
      granted: true,
      grantedBy: webId,
      grantedWith: agentId,
      grantee: 'https://acme.example/#corp',
      hasAccessNeedGroup: 'https://projectron.example/#some-access-group',
    } as const
    const validDataAuthorizationData = {
      grantee: 'https://acme.example/#corp',
      grantedBy: webId,
      registeredShapeTree: 'https://solidshapes.example/tree/Project',
      dataOwner: 'https://omni.example/#corp',
      accessMode: [ACL.Read.value],
      scopeOfAuthorization: INTEROP.AllFromAgent.value,
      children: [
        {
          grantee: 'https://acme.example/#corp',
          grantedBy: webId,
          registeredShapeTree: 'https://solidshapes.example/tree/Task',
          dataOwner: 'https://omni.example/#corp',
          accessMode: [ACL.Read.value],
          scopeOfAuthorization: INTEROP.Inherited.value,
        },
      ],
    }
    const invalidDataAuthorizationData = {
      grantee: 'https://acme.example/#corp',
      grantedBy: webId,
      registeredShapeTree: 'https://solidshapes.example/tree/Project',
      dataOwner: 'https://acme.example/#corp',
      accessMode: [ACL.Read.value],
      scopeOfAuthorization: INTEROP.AllFromAgent.value,
    }

    let agent: AuthorizationAgent

    beforeEach(async () => {
      const statefulFetch = createStatefulFetch()
      agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statefulFetch,
        randomUUID,
      })
    })

    test('should filter out data authorizations where grantee is the same as owner', async () => {
      const dataAuthorizationsData = [validDataAuthorizationData, invalidDataAuthorizationData]

      const accessAuthorization = await agent.recordAccessAuthorization({
        dataAuthorizations: dataAuthorizationsData,
        ...accessAuthorizationData,
      })
      for await (const dataAuthorization of accessAuthorization.dataAuthorizations) {
        expect(dataAuthorization.grantee).not.toBe(dataAuthorization.dataOwner)
      }
    })

    test('should extend existing access authorization', async () => {
      const existingDataAuthorizations = [
        'https://auth.alice.example/5ae2442a-75f7-4d5a-ba81-df0f5033e219',
        'https://auth.alice.example/99c56d7c-6ac3-4758-b234-5e33d3984d0b',
      ]
      const priorAuthorizationIri = 'https://auth.alice.example/some-authorization'
      const authorizationRegistry = agent.registrySet.hasAuthorizationRegistry
      authorizationRegistry.findAuthorization = vi.fn(
        async () =>
          ({
            iri: priorAuthorizationIri,
            hasDataAuthorization: existingDataAuthorizations,
            dataAuthorizations: [] as unknown as AsyncIterable<ReadableDataAuthorization>,
          }) as ReadableAccessAuthorization
      )

      authorizationRegistry.dataset.add(
        DataFactory.quad(
          authorizationRegistry.node,
          INTEROP.hasAccessAuthorization,
          DataFactory.namedNode(priorAuthorizationIri)
        )
      )

      const accessAuthorization = await agent.recordAccessAuthorization(
        {
          dataAuthorizations: [validDataAuthorizationData],
          ...accessAuthorizationData,
        },
        true
      )

      expect(accessAuthorization.hasDataAuthorization).toStrictEqual(
        expect.arrayContaining(existingDataAuthorizations)
      )
    })

    test('should extend existing access authorization when overlaping registry', async () => {
      const dataAuthorization = {
        grantee: 'https://acme.example/#corp',
        grantedBy: webId,
        registeredShapeTree: 'https://solidshapes.example/tree/Project',
        dataOwner: 'https://omni.example/#corp',
        accessMode: [ACL.Read.value],
        scopeOfAuthorization: INTEROP.SelectedFromRegistry.value,
        hasDataRegistration: 'https://home.alice.example/some-registration/',
        hasDataInstance: ['https://home.alice.example/06c7ac17-2825-411b-ad55-31bb46aa75cd'],
      }
      const matchingDataAuthorization = {
        iri: 'https://auth.alice.example/99c56d7c-6ac3-4758-b234-5e33d3984d0b',
        hasDataRegistration: dataAuthorization.hasDataRegistration,
        hasDataInstance: [
          'https://home.alice.example/edd03503-93cf-4a85-81cf-ef30874af3bf',
          'https://home.alice.example/a12cbc68-622a-4f9c-8bfa-66107a4c5f3a',
        ],
        hasInheritingAuthorization: [
          {
            iri: 'https://home.alice.example/da6be870-64b0-4b91-8ad3-8005ebb1444c',
          },
        ],
      } as ReadableDataAuthorization

      // we use existing one from snippets, just so it can be instantiated
      const otherExistingDataAuthorization = {
        iri: 'https://auth.alice.example/a691ee69-97d8-45c0-bb03-8e887b2db806',
      }

      const existingDataAuthorizations = [
        otherExistingDataAuthorization.iri,
        matchingDataAuthorization.iri,
        matchingDataAuthorization.hasInheritingAuthorization[0].iri,
      ]

      const priorAuthorizationIri = 'https://auth.alice.example/some-authorization'
      const authorizationRegistry = agent.registrySet.hasAuthorizationRegistry
      authorizationRegistry.findAuthorization = vi.fn(
        async () =>
          ({
            iri: priorAuthorizationIri,
            hasDataAuthorization: existingDataAuthorizations,
            dataAuthorizations: [
              matchingDataAuthorization,
            ] as unknown as AsyncIterable<ReadableDataAuthorization>,
          }) as ReadableAccessAuthorization
      )

      authorizationRegistry.dataset.add(
        DataFactory.quad(
          authorizationRegistry.node,
          INTEROP.hasAccessAuthorization,
          DataFactory.namedNode(priorAuthorizationIri)
        )
      )

      const accessAuthorization = await agent.recordAccessAuthorization(
        {
          dataAuthorizations: [dataAuthorization],
          ...accessAuthorizationData,
        },
        true
      )
      expect(accessAuthorization.hasDataAuthorization).not.toContain(matchingDataAuthorization.iri)
      expect(accessAuthorization.hasDataAuthorization).not.toContain(
        matchingDataAuthorization.hasInheritingAuthorization[0].iri
      )
      expect(accessAuthorization.hasDataAuthorization).toContain(otherExistingDataAuthorization.iri)
      const combinedDataAuthorization = (
        await asyncIterableToArray(accessAuthorization.dataAuthorizations)
      )[0]
      expect(combinedDataAuthorization.hasDataInstance).toEqual(
        expect.arrayContaining([
          ...dataAuthorization.hasDataInstance,
          ...matchingDataAuthorization.hasDataInstance,
        ])
      )
    })

    test('should throw if overlaping data authorization has unexpected scope', async () => {
      const dataAuthorization = {
        grantee: 'https://acme.example/#corp',
        grantedBy: webId,
        registeredShapeTree: 'https://solidshapes.example/tree/Project',
        dataOwner: 'https://omni.example/#corp',
        accessMode: [ACL.Read.value],
        scopeOfAuthorization: INTEROP.AllFromRegistry.value,
        hasDataRegistration: 'https://home.alice.example/some-registration/',
      }
      const matchingDataAuthorization = {
        iri: 'https://auth.alice.example/99c56d7c-6ac3-4758-b234-5e33d3984d0b',
        hasDataRegistration: dataAuthorization.hasDataRegistration,
        hasDataInstance: [
          'https://home.alice.example/edd03503-93cf-4a85-81cf-ef30874af3bf',
          'https://home.alice.example/a12cbc68-622a-4f9c-8bfa-66107a4c5f3a',
        ],
      } as ReadableDataAuthorization

      const existingDataAuthorizations = [matchingDataAuthorization.iri]

      agent.registrySet.hasAuthorizationRegistry.findAuthorization = vi.fn(
        async () =>
          ({
            hasDataAuthorization: existingDataAuthorizations,
            dataAuthorizations: [
              matchingDataAuthorization,
            ] as unknown as AsyncIterable<ReadableDataAuthorization>,
          }) as ReadableAccessAuthorization
      )

      const authorization = {
        dataAuthorizations: [dataAuthorization],
        ...accessAuthorizationData,
      }
      await expect(agent.recordAccessAuthorization(authorization, true)).rejects.toThrow(
        'unexpected scope'
      )
    })

    test('should throw if denied and tries to extend existing', async () => {
      const authorization = {
        granted: false,
      } as AccessAuthorizationStructure
      await expect(agent.recordAccessAuthorization(authorization, true)).rejects.toThrow(
        'Previous denied authorizations can not be extended'
      )
    })

    // TODO add PATCH support to the stateful fetch first
    test.skip('should link to new access authorization from access authorization registry', async () => {
      const accessAuthorization = await agent.recordAccessAuthorization({
        dataAuthorizations: [validDataAuthorizationData],
        ...accessAuthorizationData,
      })
      const registry = await agent.factory.crud.authorizationRegistry(
        agent.registrySet.hasAuthorizationRegistry.iri
      )
      let matched
      for await (const authorization of registry.accessAuthorizations) {
        if (authorization.iri === accessAuthorization.iri) {
          matched = true
        }
      }
      expect(matched).toBeTruthy()
    })
  })

  describe.skip('generateAccessGrant', () => {
    test('should call keept the same access grant if nothing changed', async () => {
      const statefulFetch = createStatefulFetch()
      const accessAuthorizationIri =
        'https://auth.alice.example/eac2c39c-c8b3-4880-8b9f-a3e12f7f6372'
      const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statefulFetch,
        randomUUID,
      })
      const registeredAgentIri = 'https://projectron.example/#app'
      const agentRegistration =
        await agent.registrySet.hasAgentRegistry.findRegistration(registeredAgentIri)
      await agent.generateAccessGrant(accessAuthorizationIri)
      const updatedAgentRegistration =
        await agent.registrySet.hasAgentRegistry.findRegistration(registeredAgentIri)
      expect(updatedAgentRegistration!.hasAccessGrant).toBe(agentRegistration!.hasAccessGrant)
    })
    test('should throw if agent registartion for the grantee does not exist', async () => {
      const accessAuthorizationIri =
        'https://auth.alice.example/0d12477a-a5ce-4b59-ab48-8be505ccd64c'
      const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statelessFetch,
        randomUUID,
      })
      await expect(() => agent.generateAccessGrant(accessAuthorizationIri)).rejects.toThrow(
        'agent registration for the grantee does not exist'
      )
    })
  })

  // TODO: test with more data to ensure doesn't include agents without access
  describe('findSocialAgentsWithAccess', () => {
    const authorization = {
      grantee: 'https://omni.example/#corp',
      registeredShapeTree: 'https://shapetrees.example/tree/Project',
      accessMode: [ACL.Read.value],
    }
    const dataInstance = {
      iri: 'https://home.alice.example/some-registration/some-resource',
      dataRegistration: {
        iri: 'https://home.alice.example/some-registration/',
        registeredShapeTree: authorization.registeredShapeTree,
      },
    } as ReadableDataInstance
    let agent: AuthorizationAgent

    beforeEach(async () => {
      const statefulFetch = createStatefulFetch()
      agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statefulFetch,
        randomUUID,
      })
      agent.factory.readable.dataInstance = vi.fn(async () => dataInstance)
    })

    test('with scope All', async () => {
      const allAuthorization = {
        iri: 'mocked-all',
        scopeOfAuthorization: INTEROP.All.value,
        ...authorization,
      }
      vi.spyOn(agent, 'accessAuthorizations', 'get').mockReturnValue([
        { dataAuthorizations: [allAuthorization] },
      ] as unknown as AsyncIterable<ReadableAccessAuthorization>)

      const result = await agent.findSocialAgentsWithAccess(dataInstance.iri)
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent: allAuthorization.grantee,
            dataAuthorization: allAuthorization.iri,
            accessMode: allAuthorization.accessMode,
          }),
        ])
      )
    })

    test('with scope AllFromAgent', async () => {
      const allAuthorization = {
        iri: 'mocked-all-from-agent',
        scopeOfAuthorization: INTEROP.AllFromAgent.value,
        dataOwner: webId,
        ...authorization,
      }
      vi.spyOn(agent, 'accessAuthorizations', 'get').mockReturnValue([
        { dataAuthorizations: [] }, // to catch the case with no matching data authorization
        { dataAuthorizations: [allAuthorization] },
      ] as unknown as AsyncIterable<ReadableAccessAuthorization>)

      const result = await agent.findSocialAgentsWithAccess(dataInstance.iri)
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent: allAuthorization.grantee,
            dataAuthorization: allAuthorization.iri,
            accessMode: allAuthorization.accessMode,
          }),
        ])
      )
    })

    test('with scope AllFromRegistry', async () => {
      const allAuthorization = {
        iri: 'mocked-all-from-registry',
        scopeOfAuthorization: INTEROP.AllFromRegistry.value,
        dataOwner: webId,
        hasDataRegistration: 'https://home.alice.example/some-registration/',
        ...authorization,
      }
      vi.spyOn(agent, 'accessAuthorizations', 'get').mockReturnValue([
        { dataAuthorizations: [allAuthorization] },
      ] as unknown as AsyncIterable<ReadableAccessAuthorization>)

      const result = await agent.findSocialAgentsWithAccess(dataInstance.iri)
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent: allAuthorization.grantee,
            dataAuthorization: allAuthorization.iri,
            accessMode: allAuthorization.accessMode,
          }),
        ])
      )
    })

    test('with scope SelectedFromRegistry', async () => {
      const allAuthorization = {
        iri: 'mocked-selected-instances',
        scopeOfAuthorization: INTEROP.SelectedFromRegistry.value,
        dataOwner: webId,
        hasDataRegistration: 'https://home.alice.example/some-registration/',
        hasDataInstance: [dataInstance.iri],
        ...authorization,
      }
      vi.spyOn(agent, 'accessAuthorizations', 'get').mockReturnValue([
        { dataAuthorizations: [allAuthorization] },
      ] as unknown as AsyncIterable<ReadableAccessAuthorization>)

      const result = await agent.findSocialAgentsWithAccess(dataInstance.iri)
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent: allAuthorization.grantee,
            dataAuthorization: allAuthorization.iri,
            accessMode: allAuthorization.accessMode,
          }),
        ])
      )
    })

    test('throws if invalid scope', async () => {
      const allAuthorization = {
        iri: 'mocked-invalid-scope',
        scopeOfAuthorization: 'Invalid',
        ...authorization,
      }
      vi.spyOn(agent, 'accessAuthorizations', 'get').mockReturnValue([
        { dataAuthorizations: [allAuthorization] },
      ] as unknown as AsyncIterable<ReadableAccessAuthorization>)

      await expect(agent.findSocialAgentsWithAccess(dataInstance.iri)).rejects.toThrow(
        'encountered incorect Data Authorization with scope:'
      )
    })
  })

  describe('findDataRegistration', () => {
    const dataRegistration = {
      iri: 'https://home.alice.example/projects/',
      registeredShapeTree: 'https://shapetrees.example/tree/Project',
    }
    const dataRegistry = {
      iri: 'https://home.alice.example/',
      registrations: [dataRegistration],
    } as unknown as CRUDDataRegistry

    test('should share data instance', async () => {
      const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statelessFetch,
        randomUUID,
      })
      agent.registrySet.hasDataRegistry = [dataRegistry]

      const registration = await agent.findDataRegistration(
        dataRegistry.iri,
        dataRegistration.registeredShapeTree
      )
      expect(registration).toBe(dataRegistration)
    })
  })

  describe('shareDataInstance', () => {
    // TODO: test with multiple agents and multiple child shape trees
    test('should share data instance', async () => {
      const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statelessFetch,
        randomUUID,
      })
      const shapeTree = 'https://shapetrees.example/tree/Project'
      const details: ShareDataInstanceStructure = {
        applicationId: 'https://projectron.example/',
        resource: 'https://home.alice.example/some-registration/some-resource',
        accessMode: [INTEROP.Read.value],
        children: [
          {
            shapeTree: 'https://shapetrees.example/tree/Task',
            accessMode: [INTEROP.Read.value],
          },
        ],
        agents: ['https://bob.example/#id'],
      }
      agent.findSocialAgentsWithAccess = vi.fn(async () => [])

      const dataInstance = {
        iri: details.resource,
        dataRegistration: {
          iri: 'https://home.alice.example/some-registration/',
          registeredShapeTree: shapeTree,
        },
      } as ReadableDataInstance
      agent.factory.readable.dataInstance = vi.fn(async () => dataInstance)
      const childDataRegistration = { iri: 'mocked' } as ReadableDataRegistration
      agent.findDataRegistration = vi.fn(async () => childDataRegistration)

      const mockedAuthorization = { iri: 'also-mocked' } as ReadableAccessAuthorization
      const recordMock = vi.fn(async () => mockedAuthorization)

      agent.recordAccessAuthorization = recordMock

      const authorizationIris = await agent.shareDataInstance(details)

      expect(authorizationIris.length).toBe(1)

      expect(recordMock).toBeCalledWith(
        {
          grantee: details.agents[0],
          granted: true,
          dataAuthorizations: [
            {
              grantee: details.agents[0],
              registeredShapeTree: shapeTree,
              scopeOfAuthorization: INTEROP.SelectedFromRegistry.value,
              dataOwner: webId,
              hasDataRegistration: dataInstance.dataRegistration.iri,
              accessMode: details.accessMode,
              hasDataInstance: [dataInstance.iri],
              children: [
                {
                  grantee: details.agents[0],
                  registeredShapeTree: details.children[0].shapeTree,
                  scopeOfAuthorization: INTEROP.Inherited.value,
                  dataOwner: webId,
                  hasDataRegistration: childDataRegistration.iri,
                  accessMode: details.children[0].accessMode,
                },
              ],
            },
          ],
        },
        true
      )
    })
  })
})
