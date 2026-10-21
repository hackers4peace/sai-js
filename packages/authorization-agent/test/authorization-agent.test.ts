import { randomUUID } from 'node:crypto'

import {
  type CRUDDataRegistry,
  CRUDRegistrySet,
  type GrantData,
  ReadableAccessAuthorization,
  type ReadableDataAuthorization,
  type ReadableDataInstance,
  type ReadableDataRegistration,
  ReadableWebIdProfile,
} from '@janeirodigital/interop-data-model'
import { createStatefulFetch, statelessFetch } from '@janeirodigital/interop-test-utils'
import {
  ACL,
  INTEROP,
  asyncIterableToArray,
  discoverAgentRegistration,
  discoverAuthorizationAgent,
} from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// wrap discovery helpers so tests can control the outcome of the session's
// reciprocal discovery without replacing the whole module
vi.mock('@janeirodigital/interop-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janeirodigital/interop-utils')>()
  return {
    ...actual,
    discoverAuthorizationAgent: vi.fn(actual.discoverAuthorizationAgent),
    discoverAgentRegistration: vi.fn(actual.discoverAgentRegistration),
  }
})
import {
  type AccessAuthorizationStructure,
  AuthorizationAgent,
  RevocationError,
  type ShareDataInstanceStructure,
  dataInstanceIrisForGrant,
  localSparqlTransport,
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

  test('should provide shortcut to find application registratons', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
    })
    const spy = vi.spyOn(agent.registrySet.hasApplicationRegistry, 'findApplicationRegistration')
    const iri = 'https://projectron.example/#app'
    await agent.findApplicationRegistration(iri)
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
      type: [INTEROP.DataAuthorization],
      grantee: 'https://acme.example/#corp',
      grantedBy: webId,
      registeredShapeTree: 'https://solidshapes.example/tree/Project',
      dataOwner: 'https://omni.example/#corp',
      accessMode: [ACL.Read],
      scopeOfAuthorization: INTEROP.AllFromAgent,
      children: [
        {
          type: [INTEROP.DataAuthorization],
          grantee: 'https://acme.example/#corp',
          grantedBy: webId,
          registeredShapeTree: 'https://solidshapes.example/tree/Task',
          dataOwner: 'https://omni.example/#corp',
          accessMode: [ACL.Read],
          scopeOfAuthorization: INTEROP.Inherited,
        },
      ],
    }
    const invalidDataAuthorizationData = {
      type: [INTEROP.DataAuthorization],
      grantee: 'https://acme.example/#corp',
      grantedBy: webId,
      registeredShapeTree: 'https://solidshapes.example/tree/Project',
      dataOwner: 'https://acme.example/#corp',
      accessMode: [ACL.Read],
      scopeOfAuthorization: INTEROP.AllFromAgent,
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
          INTEROP.terms.hasAccessAuthorization,
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
        type: [INTEROP.DataAuthorization],
        grantee: 'https://acme.example/#corp',
        grantedBy: webId,
        registeredShapeTree: 'https://solidshapes.example/tree/Project',
        dataOwner: 'https://omni.example/#corp',
        accessMode: [ACL.Read],
        scopeOfAuthorization: INTEROP.SelectedFromRegistry,
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
          INTEROP.terms.hasAccessAuthorization,
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
        type: [INTEROP.DataAuthorization],
        grantee: 'https://acme.example/#corp',
        grantedBy: webId,
        registeredShapeTree: 'https://solidshapes.example/tree/Project',
        dataOwner: 'https://omni.example/#corp',
        accessMode: [ACL.Read],
        scopeOfAuthorization: INTEROP.AllFromRegistry,
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
      const registry = agent.registrySet.hasAuthorizationRegistry as unknown as {
        accessAuthorizations: { iri?: string }[]
      }
      let matched
      for await (const authorization of registry.accessAuthorizations) {
        if (authorization.iri === accessAuthorization.iri) {
          matched = true
        }
      }
      expect(matched).toBeTruthy()
    })
  })

  describe.skip('generateDataGrants', () => {
    test('should generate grants without changing data grant iris', async () => {
      const statefulFetch = createStatefulFetch()
      const accessAuthorizationIri =
        'https://auth.alice.example/eac2c39c-c8b3-4880-8b9f-a3e12f7f6372'
      const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statefulFetch,
        randomUUID,
      })
      const registeredAgentIri = 'https://projectron.example/#app'
      const agentRegistration =
        await agent.registrySet.hasSocialAgentRegistry.findSocialAgentRegistration(
          registeredAgentIri
        )
      const beforeIris = getDataGrantIris(agentRegistration!)
      await agent.generateDataGrants(accessAuthorizationIri)
      const updatedAgentRegistration =
        await agent.registrySet.hasSocialAgentRegistry.findSocialAgentRegistration(
          registeredAgentIri
        )
      const afterIris = getDataGrantIris(updatedAgentRegistration!)
      expect(afterIris).not.toEqual(beforeIris)
      expect(afterIris.length).toBeGreaterThan(beforeIris.length)
    })
    test('should generate even if agent registration for the grantee does not exist', async () => {
      const accessAuthorizationIri =
        'https://auth.alice.example/0d12477a-a5ce-4b59-ab48-8be505ccd64c'
      const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
        fetch: statelessFetch,
        randomUUID,
      })
      const result = await agent.generateDataGrants(accessAuthorizationIri)
      expect(result.sourceGrants).toEqual([])
      expect(result.delegatedGrants).toEqual([])
    })
  })

  // TODO: test with more data to ensure doesn't include agents without access
  describe('findSocialAgentsWithAccess', () => {
    const authorization = {
      grantee: 'https://omni.example/#corp',
      registeredShapeTree: 'https://shapetrees.example/tree/Project',
      accessMode: [ACL.Read],
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
    })

    test('with scope All', async () => {
      const allAuthorization = {
        iri: 'mocked-all',
        scopeOfAuthorization: INTEROP.All,
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
        scopeOfAuthorization: INTEROP.AllFromAgent,
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
        scopeOfAuthorization: INTEROP.AllFromRegistry,
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
        scopeOfAuthorization: INTEROP.SelectedFromRegistry,
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
        accessMode: [INTEROP.Read],
        children: [
          {
            shapeTree: 'https://shapetrees.example/tree/Task',
            accessMode: [INTEROP.Read],
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
              type: [INTEROP.DataAuthorization],
              grantee: details.agents[0],
              registeredShapeTree: shapeTree,
              scopeOfAuthorization: INTEROP.SelectedFromRegistry,
              dataOwner: webId,
              hasDataRegistration: dataInstance.dataRegistration.iri,
              accessMode: details.accessMode,
              hasDataInstance: [dataInstance.iri],
              children: [
                {
                  type: [INTEROP.DataAuthorization],
                  grantee: details.agents[0],
                  registeredShapeTree: details.children[0].shapeTree,
                  scopeOfAuthorization: INTEROP.Inherited,
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

// ──────────────────────────
// findAuthorizationsForAgent — registry-plane reads (docs/sparql.md step 2)
// ──────────────────────────

// The session reads its own registry via the *internal* SPARQL endpoint
// (localSparqlTransport). Mock the fetch-sparql-endpoint fetcher and route
// by query text: the listing/membership SELECTs and one CONSTRUCT per
// authorization graph.
const sparqlMock = vi.hoisted(() => {
  const handlers: {
    bindings?: (query: string) => Array<Record<string, { termType: string; value: string }>>
    triples?: (query: string) => unknown[]
  } = {}
  return { handlers }
})

vi.mock('fetch-sparql-endpoint', () => ({
  SparqlEndpointFetcher: class {
    async fetchBindings(_endpoint: string, query: string) {
      if (!sparqlMock.handlers.bindings) throw new Error('mock: no bindings handler')
      return sparqlMock.handlers.bindings(query)
    }
    async fetchTriples(_endpoint: string, query: string) {
      if (!sparqlMock.handlers.triples) throw new Error('mock: no triples handler')
      return sparqlMock.handlers.triples(query)
    }
  },
}))

describe('findAuthorizationsForAgent', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const SHAPE_TREE = 'https://shapetrees.example/tree/Project'
  const BOB = 'https://bob.example/#id'
  const ROLE_REGISTRY = 'https://auth.alice.example/role/'
  const ROLE_ADMIN = 'https://auth.alice.example/role/admin'
  const AUTHZ_DIRECT = 'https://auth.alice.example/authz-direct'
  const AUTHZ_VIA_ROLE = 'https://auth.alice.example/authz-via-role'
  const AUTHZ_ADMIN = 'https://auth.alice.example/admin-authz'

  const authzGraph = (iri: string, type: string, grantee: string) => [
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(RDF_TYPE),
      DataFactory.namedNode(type)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.grantee),
      DataFactory.namedNode(grantee)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.grantedBy),
      DataFactory.namedNode(webId)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.registeredShapeTree),
      DataFactory.namedNode(SHAPE_TREE)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.scopeOfAuthorization),
      DataFactory.namedNode(INTEROP.All)
    ),
  ]

  test('grants to the peer directly and via role membership; other contained types excluded', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })
    // the fixture registry set has no role registry; the query only needs
    // the container IRI (routed by the mock)
    agent.registrySet.hasRoleRegistry = { id: ROLE_REGISTRY }

    sparqlMock.handlers.bindings = (query) => {
      if (query.includes('SELECT DISTINCT ?child')) {
        // listContained over the authorization registry
        return [AUTHZ_DIRECT, AUTHZ_VIA_ROLE, AUTHZ_ADMIN].map((iri) => ({
          child: { termType: 'NamedNode', value: iri },
        }))
      }
      // role-membership SELECT — BOB is a member of ROLE_ADMIN
      expect(query).toContain('hasMember')
      return [{ role: { termType: 'NamedNode', value: ROLE_ADMIN } }]
    }
    sparqlMock.handlers.triples = (query) => {
      const graphs: Record<string, unknown[]> = {
        [AUTHZ_DIRECT]: authzGraph(AUTHZ_DIRECT, INTEROP.DataAuthorization, BOB),
        [AUTHZ_VIA_ROLE]: authzGraph(AUTHZ_VIA_ROLE, INTEROP.DataAuthorization, ROLE_ADMIN),
        [AUTHZ_ADMIN]: authzGraph(AUTHZ_ADMIN, 'https://example/AdminAuthorization', BOB),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) return quads
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const authorizations = await agent.findAuthorizationsForAgent(BOB)

    expect(authorizations.map((authorization) => authorization.id)).toEqual([
      AUTHZ_DIRECT,
      AUTHZ_VIA_ROLE,
    ])
    expect(authorizations.map((authorization) => authorization.grantee)).toEqual([BOB, ROLE_ADMIN])
  })

  test('includes inherited children with their parent link', async () => {
    const PARENT = 'https://auth.alice.example/authz-parent'
    const CHILD = 'https://auth.alice.example/authz-child'
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })
    agent.registrySet.hasRoleRegistry = { id: ROLE_REGISTRY }

    sparqlMock.handlers.bindings = (query) => {
      if (query.includes('SELECT DISTINCT ?child')) {
        return [PARENT, CHILD].map((iri) => ({
          child: { termType: 'NamedNode', value: iri },
        }))
      }
      // role-membership SELECT — BOB is not a role member here
      expect(query).toContain('hasMember')
      return []
    }
    sparqlMock.handlers.triples = (query) => {
      if (query.includes(`GRAPH <${PARENT}>`)) {
        return authzGraph(PARENT, INTEROP.DataAuthorization, BOB)
      }
      if (query.includes(`GRAPH <${CHILD}>`)) {
        return [
          ...authzGraph(CHILD, INTEROP.DataAuthorization, BOB),
          DataFactory.quad(
            DataFactory.namedNode(CHILD),
            DataFactory.namedNode(INTEROP.inheritsFromAuthorization),
            DataFactory.namedNode(PARENT)
          ),
        ]
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const authorizations = await agent.findAuthorizationsForAgent(BOB)

    expect(authorizations.map((authorization) => authorization.id).toSorted()).toEqual(
      [PARENT, CHILD].toSorted()
    )
    expect(authorizations.find((authorization) => authorization.id === CHILD)).toMatchObject({
      inheritsFromAuthorization: PARENT,
      grantee: BOB,
    })
  })
})

describe('findApplicationRegistration', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const APP_REG = 'https://auth.alice.example/app-reg'
  const APP_WEBID = 'https://projectron.example/#app'

  test('finds the registration of the application webId via the ldp:contains listing', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('ldp#contains')
      return [{ child: { termType: 'NamedNode', value: APP_REG } }]
    }
    sparqlMock.handlers.triples = (query) => {
      expect(query).toContain(`GRAPH <${APP_REG}>`)
      return [
        DataFactory.quad(
          DataFactory.namedNode(APP_REG),
          DataFactory.namedNode(RDF_TYPE),
          DataFactory.namedNode(INTEROP.ApplicationRegistration)
        ),
        DataFactory.quad(
          DataFactory.namedNode(APP_REG),
          DataFactory.namedNode(INTEROP.registeredAgent),
          DataFactory.namedNode(APP_WEBID)
        ),
      ]
    }

    const registration = await agent.findApplicationRegistration(APP_WEBID)

    expect(registration).toEqual({
      id: APP_REG,
      type: [INTEROP.ApplicationRegistration],
      registeredAgent: APP_WEBID,
      hasDataGrant: [],
      granted: false,
    })
  })
})

describe('findDataRegistration', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const DATA_REGISTRY = 'https://auth.alice.example/data-registry/'
  const DATA_REG_PROJECT = 'https://auth.alice.example/projects/'
  const DATA_REG_TASK = 'https://auth.alice.example/tasks/'
  const PROJECT_TREE = 'https://shapetrees.example/tree/Project'
  const TASK_TREE = 'https://shapetrees.example/tree/Task'

  const registrationGraph = (iri: string, shapeTree: string) => [
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(RDF_TYPE),
      DataFactory.namedNode(INTEROP.DataRegistration)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.registeredShapeTree),
      DataFactory.namedNode(shapeTree)
    ),
  ]

  test('lists the data registry via the ldp:contains listing and matches the shape tree', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('ldp#contains')
      return [DATA_REG_PROJECT, DATA_REG_TASK].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = (query) => {
      const graphs: Record<string, unknown[]> = {
        [DATA_REG_PROJECT]: registrationGraph(DATA_REG_PROJECT, PROJECT_TREE),
        [DATA_REG_TASK]: registrationGraph(DATA_REG_TASK, TASK_TREE),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) return quads
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const registration = await agent.findDataRegistration(DATA_REGISTRY, PROJECT_TREE)

    expect(registration).toEqual({
      id: DATA_REG_PROJECT,
      type: [INTEROP.DataRegistration],
      registeredShapeTree: PROJECT_TREE,
      contains: [],
    })
  })

  test('returns undefined when no registration matches the shape tree', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = () => [
      { child: { termType: 'NamedNode', value: DATA_REG_PROJECT } },
    ]
    sparqlMock.handlers.triples = (query) => {
      if (query.includes(`GRAPH <${DATA_REG_PROJECT}>`)) {
        return registrationGraph(DATA_REG_PROJECT, TASK_TREE)
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    await expect(agent.findDataRegistration(DATA_REGISTRY, PROJECT_TREE)).resolves.toBeUndefined()
  })
})

describe('findSocialAgentInvitation', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const INVITE_1 = 'https://auth.alice.example/invite-1'
  const INVITE_2 = 'https://auth.alice.example/invite-2'
  const CAPABILITY_2 = 'https://auth.alice.example/capability/invite-2'

  const invitationGraph = (iri: string, capabilityUrl: string) => [
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(RDF_TYPE),
      DataFactory.namedNode(INTEROP.SocialAgentInvitation)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.hasCapabilityUrl),
      DataFactory.namedNode(capabilityUrl)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode('http://www.w3.org/2004/02/skos/core#prefLabel'),
      DataFactory.literal('Invite 2')
    ),
  ]

  test('lists invitations via the ldp:contains listing and matches the capability URL', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('ldp#contains')
      return [INVITE_1, INVITE_2].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = (query) => {
      const graphs: Record<string, unknown[]> = {
        [INVITE_1]: invitationGraph(INVITE_1, 'https://auth.alice.example/capability/invite-1'),
        [INVITE_2]: invitationGraph(INVITE_2, CAPABILITY_2),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) return quads
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const invitation = await agent.findSocialAgentInvitation(CAPABILITY_2)

    expect(invitation).toEqual({
      id: INVITE_2,
      type: [INTEROP.SocialAgentInvitation],
      capabilityUrl: CAPABILITY_2,
      label: { '@none': 'Invite 2' },
      note: undefined,
      registeredAgent: undefined,
    })
  })
})

// ──────────────────────────
// AdminAuthorization session methods (relocated from data-model — Phase 3)
// ──────────────────────────

describe('AdminAuthorization session methods', () => {
  const MIXED_REGISTRY = 'https://auth.alice.example/authorization-registry-mixed'

  const buildAgent = async (fetchMock: typeof statelessFetch = createStatefulFetch()) =>
    AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: fetchMock,
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

  test('recordAdminAuthorization writes the AdminAuthorization resource', async () => {
    const statefulFetch = createStatefulFetch()
    const agent = await buildAgent(statefulFetch)

    const recorded = await agent.recordAdminAuthorization(
      {
        grantee: 'https://id/eve',
        grantedBy: 'https://id/yoyo',
        scopeOfAuthorization: INTEROP.All,
      },
      { id: MIXED_REGISTRY }
    )

    expect(recorded.id).toMatch(new RegExp(`^${MIXED_REGISTRY}`))
    expect(recorded.type).toEqual([INTEROP.AdminAuthorization])
    expect(recorded.grantee).toBe('https://id/eve')
    expect(recorded.grantedBy).toBe('https://id/yoyo')
    expect(recorded.scopeOfAuthorization).toBe(INTEROP.All)

    const doc = JSON.parse(await (await statefulFetch(recorded.id)).text())
    const node = Array.isArray(doc) ? doc.find((n) => n['@id'] === recorded.id) : doc
    expect(node['@type']).toContain(INTEROP.AdminAuthorization)
  })

  test('findAdminAuthorization returns the admin authorization for the grantee / undefined otherwise', async () => {
    const agent = await buildAgent()
    const registry = { id: MIXED_REGISTRY }

    const result = await agent.findAdminAuthorization('https://id/dan', registry)
    expect(result).toBeDefined()
    expect(result!.type).toContain(INTEROP.AdminAuthorization)
    expect(result!.grantee).toBe('https://id/dan')
    expect(result!.grantedBy).toBe('https://id/yoyo')
    expect(result!.scopeOfAuthorization).toBe(INTEROP.All)

    expect(await agent.findAdminAuthorization('https://id/nobody', registry)).toBeUndefined()
  })

  test('adminAuthorizations yields only AdminAuthorizations', async () => {
    const agent = await buildAgent()

    const result = await agent.adminAuthorizations({ id: MIXED_REGISTRY })
    expect(result).toHaveLength(1)
    for (const adminAuthorization of result) {
      expect(adminAuthorization.type).toContain(INTEROP.AdminAuthorization)
      expect(adminAuthorization.type).not.toContain(INTEROP.DataAuthorization)
    }
  })

  test('deleteAdminAuthorization removes the resource', async () => {
    const statefulFetch = createStatefulFetch()
    const agent = await buildAgent(statefulFetch)

    const recorded = await agent.recordAdminAuthorization(
      {
        grantee: 'https://id/eve',
        grantedBy: 'https://id/yoyo',
        scopeOfAuthorization: INTEROP.All,
      },
      { id: MIXED_REGISTRY }
    )
    await agent.deleteAdminAuthorization(recorded.id)
    await expect(statefulFetch(recorded.id).then((response) => response.text())).rejects.toThrow(
      'missing snippet'
    )
  })
})

// ──────────────────────────
// Reciprocal discovery session methods (relocated from data-model — Phase 3)
// ──────────────────────────

describe('reciprocal discovery session methods', () => {
  const agentRegistrationIri = 'https://auth.alice.example/bcf22534-0187-4ae4-b88f-fe0f9fa96659'
  const registration = {
    id: 'https://auth.acme.example/2437895a-3a68-4048-8965-889b7e93936c',
    type: [INTEROP.SocialAgentRegistration],
    registeredAgent: 'https://acme.example/#corp',
    label: 'ACME',
    hasDataGrant: [],
    hasAdminGrant: [],
  }
  const buildAgent = async () =>
    AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

  test('discoverReciprocal discovers the reciprocal registration IRI', async () => {
    vi.mocked(discoverAuthorizationAgent).mockResolvedValue('https://auth.acme.example/')
    vi.mocked(discoverAgentRegistration).mockResolvedValue(agentRegistrationIri)
    const agent = await buildAgent()

    expect(await agent.discoverReciprocal(registration)).toBe(agentRegistrationIri)
  })

  test('discoverReciprocal returns null when no authorization agent is found', async () => {
    vi.mocked(discoverAuthorizationAgent).mockResolvedValue(null)
    const agent = await buildAgent()

    expect(await agent.discoverReciprocal(registration)).toBeNull()
  })

  test('discoverAndUpdateReciprocal patches the link onto the registration', async () => {
    vi.mocked(discoverAuthorizationAgent).mockResolvedValue('https://auth.acme.example/')
    vi.mocked(discoverAgentRegistration).mockResolvedValue(agentRegistrationIri)
    const agent = await buildAgent()
    const reg = { ...registration }

    expect(reg.reciprocalRegistration).toBeUndefined()
    await agent.discoverAndUpdateReciprocal(reg)
    expect(reg.reciprocalRegistration).toBe(agentRegistrationIri)
  })

  test('discoverAndUpdateReciprocal is a no-op when nothing is discovered', async () => {
    vi.mocked(discoverAuthorizationAgent).mockResolvedValue('https://auth.acme.example/')
    vi.mocked(discoverAgentRegistration).mockResolvedValue(undefined)
    const agent = await buildAgent()
    const reg = { ...registration }

    await agent.discoverAndUpdateReciprocal(reg)
    expect(reg.reciprocalRegistration).toBeUndefined()
  })
})

// ──────────────────────────

describe('revokeGrants core (C1)', () => {
  const ALICE = 'https://alice.example/#id'
  const BOB = 'https://bob.example/#id'
  const KIM = 'https://kim.example/#id'
  const DAN = 'https://dan.example/#id'
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const GRANT_REGISTRY = 'https://auth.alice.example/grant/'
  const ROOT = `${GRANT_REGISTRY}root`
  const AB = `${GRANT_REGISTRY}ab`
  const BC = `${GRANT_REGISTRY}bc`
  const CHILD_SOURCE = `${GRANT_REGISTRY}child-source`
  const CHILD = `${GRANT_REGISTRY}child`
  const PROJECT_TREE = 'https://shapetrees.example/trees/Project'
  const TASK_TREE = 'https://shapetrees.example/trees/Task'
  const PROJECT_REG = 'https://data.alice.example/projects/'
  const TASK_REG = 'https://data.alice.example/tasks/'
  const STORAGE = 'https://data.alice.example/'

  const grantFixture = (id: string, overrides: Partial<GrantData> = {}): GrantData => ({
    id,
    type: [INTEROP.DataGrant],
    dataOwner: ALICE,
    grantedBy: ALICE,
    grantee: BOB,
    registeredShapeTree: PROJECT_TREE,
    hasDataRegistration: PROJECT_REG,
    hasStorage: STORAGE,
    scopeOfGrant: INTEROP.AllFromRegistry,
    accessMode: [ACL.Read, ACL.Update],
    ...overrides,
  })

  // source D→A; delegated A→B; delegated B→C; the source child D→A for the
  // Task shape and the delegated child A→B inheriting from A→B Project
  const root = grantFixture(ROOT)
  const ab = grantFixture(AB, { grantedBy: BOB, grantee: KIM, accessMode: [ACL.Read] })
  const bc = grantFixture(BC, { grantedBy: KIM, grantee: DAN, accessMode: [ACL.Read] })
  const childSource = grantFixture(CHILD_SOURCE, {
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REG,
    scopeOfGrant: INTEROP.Inherited,
    inheritsFromGrant: ROOT,
    accessMode: [ACL.Read],
  })
  const child = grantFixture(CHILD, {
    grantedBy: BOB,
    grantee: KIM,
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REG,
    scopeOfGrant: INTEROP.Inherited,
    inheritsFromGrant: AB,
    accessMode: [ACL.Read],
  })

  const grantQuads = (grant: GrantData) => {
    const node = DataFactory.namedNode(grant.id!)
    const q = (predicate: string, object: string) =>
      DataFactory.quad(node, DataFactory.namedNode(predicate), DataFactory.namedNode(object))
    const quads = [
      q(RDF_TYPE, INTEROP.DataGrant),
      q(INTEROP.grantee, grant.grantee),
      q(INTEROP.grantedBy, grant.grantedBy),
      q(INTEROP.dataOwner, grant.dataOwner),
      q(INTEROP.registeredShapeTree, grant.registeredShapeTree),
      q(INTEROP.hasDataRegistration, grant.hasDataRegistration),
      q(INTEROP.hasStorage, grant.hasStorage),
      q(INTEROP.scopeOfGrant, grant.scopeOfGrant),
      ...grant.accessMode.map((mode) => q(INTEROP.accessMode, mode)),
    ]
    if (grant.inheritsFromGrant) quads.push(q(INTEROP.inheritsFromGrant, grant.inheritsFromGrant))
    return quads
  }

  /** Serve the grant registry listing and every grant graph from `existing`. */
  const installRegistry = (existing: GrantData[] = [root, ab, bc, childSource, child]) => {
    sparqlMock.handlers.bindings = (query) => {
      if (query.includes('ldp#contains')) {
        return existing.map((grant) => ({
          child: { termType: 'NamedNode', value: grant.id },
        }))
      }
      if (query.includes('?dataOwner')) {
        // the authority read filters with VALUES ?grant { … }
        const requested = new Set([...query.matchAll(/<([^>]+)>/g)].map((match) => match[1]))
        return existing
          .filter((grant) => requested.has(grant.id!))
          .map((grant) => ({
            grant: { termType: 'NamedNode', value: grant.id },
            dataOwner: { termType: 'NamedNode', value: grant.dataOwner },
            grantedBy: { termType: 'NamedNode', value: grant.grantedBy },
            grantee: { termType: 'NamedNode', value: grant.grantee },
          }))
      }
      throw new Error(`unexpected SELECT: ${query}`)
    }
    sparqlMock.handlers.triples = (query) => {
      for (const grant of existing) {
        if (query.includes(`GRAPH <${grant.id}>`)) return grantQuads(grant)
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }
  }

  const buildAgent = async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: statelessFetch,
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })
    agent.registrySet.hasGrantRegistry = { id: GRANT_REGISTRY }
    return agent
  }

  test('removes the entry point, its downstream chain and its inheriting child', async () => {
    installRegistry()
    const agent = await buildAgent()

    const revoked = await agent.revokeGrants([AB], ALICE)

    expect(revoked.map((grant) => grant.iri).toSorted()).toEqual([AB, BC, CHILD].toSorted())
    for (const grant of revoked) {
      expect(grant.dataOwner).toBe(ALICE)
    }
  })

  test('removing the source root invalidates the whole dependent chain', async () => {
    installRegistry()
    const agent = await buildAgent()

    const revoked = await agent.revokeGrants([ROOT], ALICE)

    expect(revoked.map((grant) => grant.iri).toSorted()).toEqual(
      [ROOT, AB, BC, CHILD_SOURCE, CHILD].toSorted()
    )
  })

  test('rejects a requester that is neither grantor nor the data owner', async () => {
    installRegistry()
    const agent = await buildAgent()

    // BOB is not BC's grantor (KIM) or owner (ALICE)
    await expect(agent.revokeGrants([BC], BOB)).rejects.toMatchObject({
      name: 'RevocationError',
      code: 'unauthorized',
      grants: [BC],
    })
  })

  test('grantee self-revocation is not an authority branch (D17)', async () => {
    installRegistry()
    const agent = await buildAgent()

    // KIM holds AB, but the grant boundary is grantor/owner only
    await expect(agent.revokeGrants([AB], KIM)).rejects.toMatchObject({
      name: 'RevocationError',
      code: 'unauthorized',
      grants: [AB],
    })
  })

  test('a mixed-owner request fails as a whole on the requested set (B2)', async () => {
    installRegistry()
    const agent = await buildAgent()
    const foreign = 'https://auth.kim.example/grant/foreign'

    // `foreign` does not even exist in either store — the container check runs
    // on the request, not on whatever happened to load
    await expect(agent.revokeGrants([AB, foreign], ALICE)).rejects.toMatchObject({
      name: 'RevocationError',
      code: 'mixed-owner',
      grants: [AB, foreign],
    })
  })

  test('grants outside the session registry are a typed wrong-data-owner refusal', async () => {
    installRegistry()
    const agent = await buildAgent()
    const foreign = 'https://auth.kim.example/grant/foreign'

    await expect(agent.revokeGrants([foreign], ALICE)).rejects.toMatchObject({
      name: 'RevocationError',
      code: 'wrong-data-owner',
      grants: [foreign],
    })
  })

  test('an already-removed grant is an empty closure (idempotent no-op)', async () => {
    installRegistry([])
    const agent = await buildAgent()

    await expect(agent.revokeGrants([AB], ALICE)).resolves.toEqual([])
  })

  test('RevocationError is exported for callers that map it', () => {
    const error = new RevocationError('unauthorized', [AB], 'no authority')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('unauthorized')
    expect(error.grants).toEqual([AB])
  })
})

describe('dataInstanceIrisForGrant (Phase 4)', () => {
  const REGISTRATION = 'https://data.alice.example/reg/'
  const INSTANCE_1 = 'https://data.alice.example/reg/1'
  const INSTANCE_2 = 'https://data.alice.example/reg/2'

  test('AllFromRegistry via the data registration contains (registry plane)', async () => {
    sparqlMock.handlers.triples = (query) => {
      if (query.includes(`GRAPH <${REGISTRATION}>`)) {
        return [
          DataFactory.quad(
            DataFactory.namedNode(REGISTRATION),
            DataFactory.namedNode(INTEROP.registeredShapeTree),
            DataFactory.namedNode('https://shapetrees.example/Project')
          ),
          DataFactory.quad(
            DataFactory.namedNode(REGISTRATION),
            DataFactory.namedNode('http://www.w3.org/ns/ldp#contains'),
            DataFactory.namedNode(INSTANCE_1)
          ),
          DataFactory.quad(
            DataFactory.namedNode(REGISTRATION),
            DataFactory.namedNode('http://www.w3.org/ns/ldp#contains'),
            DataFactory.namedNode(INSTANCE_2)
          ),
        ]
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const collected: string[] = []
    for await (const id of dataInstanceIrisForGrant(
      {
        id: 'https://auth.alice.example/grant/1',
        type: [INTEROP.DataGrant],
        grantee: 'https://bob.example/#id',
        grantedBy: webId,
        dataOwner: webId,
        registeredShapeTree: 'https://shapetrees.example/Project',
        hasDataRegistration: REGISTRATION,
        hasStorage: 'https://storage/',
        scopeOfGrant: INTEROP.AllFromRegistry,
        accessMode: [ACL.Read],
      },
      localSparqlTransport('http://example.test/sparql'),
      statelessFetch
    )) {
      collected.push(id)
    }

    expect(collected).toEqual([INSTANCE_1, INSTANCE_2])
  })
})
