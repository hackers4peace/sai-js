import { randomUUID } from 'node:crypto'

import { grantAccess, grantAccessModes, grantGrantee } from '@janeirodigital/interop-data-model'
import type { GrantData } from '@janeirodigital/interop-data-model'
import {
  ACCESS_ACTIONS,
  INTEROP,
  LWS,
  ODRL,
  discoverAgentRegistration,
  discoverAuthorizationAgent,
} from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, expect, test, vi } from 'vitest'

import { createStatefulFetch, statelessFetch } from './mock-fetch.ts'

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
  AuthorizationAgent,
  RevocationError,
  dataInstanceIrisForGrant,
  localSparqlTransport,
} from '../src'

const webId = 'https://alice.example/#id'
const agentId = 'https://alice.jarvis.example/#agent'
const registryId = 'https://auth.alice.example/13e60d32-77a6-4239-864d-cfe2c90807c8'

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
    triples?: (query: string) => Array<unknown>
  } = {}
  return { handlers }
})

vi.mock('fetch-sparql-endpoint', () => ({
  SparqlEndpointFetcher: class {
    async fetchBindings(_endpoint: string, query: string) {
      if (!sparqlMock.handlers.bindings) {
        throw new Error('mock: no bindings handler')
      }
      return sparqlMock.handlers.bindings(query)
    }
    async fetchTriples(_endpoint: string, query: string) {
      if (!sparqlMock.handlers.triples) {
        throw new Error('mock: no triples handler')
      }
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
      const graphs: Record<string, Array<unknown>> = {
        [AUTHZ_DIRECT]: authzGraph(AUTHZ_DIRECT, INTEROP.DataAuthorization, BOB),
        [AUTHZ_VIA_ROLE]: authzGraph(AUTHZ_VIA_ROLE, INTEROP.DataAuthorization, ROLE_ADMIN),
        [AUTHZ_ADMIN]: authzGraph(AUTHZ_ADMIN, 'https://example/AdminAuthorization', BOB),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) {
          return quads
        }
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

    expect(
      authorizations.map((authorization) => authorization.id).toSorted((a, b) => a.localeCompare(b))
    ).toEqual([PARENT, CHILD].toSorted())
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

  test('finds the registration of the application webId via the lws:contains listing', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('lws#contains')
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

describe('findRegistration', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const APP_REG = 'https://auth.alice.example/app-reg'
  const APP_WEBID = 'https://projectron.example/#app'
  const SOCIAL_REG = 'https://auth.alice.example/social-reg'
  const SOCIAL_WEBID = 'https://acme.example/#corp'

  const registrationGraph = (iri: string, type: string, registeredAgent: string) => [
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(RDF_TYPE),
      DataFactory.namedNode(type)
    ),
    DataFactory.quad(
      DataFactory.namedNode(iri),
      DataFactory.namedNode(INTEROP.registeredAgent),
      DataFactory.namedNode(registeredAgent)
    ),
  ]

  // route the two registry listings by container IRI: application first, then
  // social agent — the plane counterpart of the former HTTP scan order
  const listings = (listed: { application: Array<string>; socialAgent: Array<string> }) => {
    return (agent: AuthorizationAgent, query: string) => {
      expect(query).toContain('lws#contains')
      if (query.includes(`GRAPH <meta:${agent.registrySet.hasApplicationRegistry.id}>`)) {
        return listed.application.map((iri) => ({ child: { termType: 'NamedNode', value: iri } }))
      }
      if (query.includes(`GRAPH <meta:${agent.registrySet.hasSocialAgentRegistry.id}>`)) {
        return listed.socialAgent.map((iri) => ({ child: { termType: 'NamedNode', value: iri } }))
      }
      throw new Error(`unexpected SELECT: ${query}`)
    }
  }

  test('returns the application registration from the application registry', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) =>
      listings({ application: [APP_REG], socialAgent: [] })(agent, query)
    sparqlMock.handlers.triples = (query) => {
      expect(query).toContain(`GRAPH <${APP_REG}>`)
      return registrationGraph(APP_REG, INTEROP.ApplicationRegistration, APP_WEBID)
    }

    await expect(agent.findRegistration(APP_WEBID)).resolves.toMatchObject({
      id: APP_REG,
      type: [INTEROP.ApplicationRegistration],
      registeredAgent: APP_WEBID,
    })
  })

  test('falls back to the social-agent registration', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) =>
      listings({ application: [], socialAgent: [SOCIAL_REG] })(agent, query)
    sparqlMock.handlers.triples = (query) => {
      expect(query).toContain(`GRAPH <${SOCIAL_REG}>`)
      return registrationGraph(SOCIAL_REG, INTEROP.SocialAgentRegistration, SOCIAL_WEBID)
    }

    await expect(agent.findRegistration(SOCIAL_WEBID)).resolves.toMatchObject({
      id: SOCIAL_REG,
      registeredAgent: SOCIAL_WEBID,
    })
  })

  test('returns undefined when neither registry lists the agent', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) =>
      listings({ application: [], socialAgent: [] })(agent, query)
    sparqlMock.handlers.triples = () => {
      throw new Error('no registration graph expected')
    }

    await expect(agent.findRegistration('https://id/nobody')).resolves.toBeUndefined()
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

  test('lists the data registry via the lws:contains listing and matches the shape tree', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('lws#contains')
      return [DATA_REG_PROJECT, DATA_REG_TASK].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = (query) => {
      const graphs: Record<string, Array<unknown>> = {
        [DATA_REG_PROJECT]: registrationGraph(DATA_REG_PROJECT, PROJECT_TREE),
        [DATA_REG_TASK]: registrationGraph(DATA_REG_TASK, TASK_TREE),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) {
          return quads
        }
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

  test('lists invitations via the lws:contains listing and matches the capability URL', async () => {
    const agent = await AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: createStatefulFetch(),
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('lws#contains')
      return [INVITE_1, INVITE_2].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = (query) => {
      const graphs: Record<string, Array<unknown>> = {
        [INVITE_1]: invitationGraph(INVITE_1, 'https://auth.alice.example/capability/invite-1'),
        [INVITE_2]: invitationGraph(INVITE_2, CAPABILITY_2),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) {
          return quads
        }
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
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const ADMIN_AUTHZ = `${MIXED_REGISTRY}/admin-auth`
  const DATA_AUTHZ_1 = `${MIXED_REGISTRY}/data-auth-1`
  const DATA_AUTHZ_2 = `${MIXED_REGISTRY}/data-auth-2`

  const buildAgent = async (fetchMock: typeof statelessFetch = createStatefulFetch()) =>
    AuthorizationAgent.build(webId, agentId, registryId, {
      fetch: fetchMock,
      randomUUID,
      sparqlEndpoint: 'http://example.test/sparql',
    })

  // the registry plane listing + one graph read per contained resource;
  // AdminAuthorizations share the container with the DataAuthorizations
  const mockAdminRegistry = () => {
    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain(`GRAPH <meta:${MIXED_REGISTRY}>`)
      return [DATA_AUTHZ_1, DATA_AUTHZ_2, ADMIN_AUTHZ].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = (query) => {
      if (query.includes(`GRAPH <${ADMIN_AUTHZ}>`)) {
        return [
          DataFactory.quad(
            DataFactory.namedNode(ADMIN_AUTHZ),
            DataFactory.namedNode(RDF_TYPE),
            DataFactory.namedNode(INTEROP.AdminAuthorization)
          ),
          DataFactory.quad(
            DataFactory.namedNode(ADMIN_AUTHZ),
            DataFactory.namedNode(INTEROP.grantee),
            DataFactory.namedNode('https://id/dan')
          ),
          DataFactory.quad(
            DataFactory.namedNode(ADMIN_AUTHZ),
            DataFactory.namedNode(INTEROP.grantedBy),
            DataFactory.namedNode('https://id/yoyo')
          ),
          DataFactory.quad(
            DataFactory.namedNode(ADMIN_AUTHZ),
            DataFactory.namedNode(INTEROP.scopeOfAuthorization),
            DataFactory.namedNode(INTEROP.All)
          ),
        ]
      }
      for (const iri of [DATA_AUTHZ_1, DATA_AUTHZ_2]) {
        if (query.includes(`GRAPH <${iri}>`)) {
          return [
            DataFactory.quad(
              DataFactory.namedNode(iri),
              DataFactory.namedNode(RDF_TYPE),
              DataFactory.namedNode(INTEROP.DataAuthorization)
            ),
          ]
        }
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }
  }

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

    // flat member: `{registryPodRoot}{uuid}`, independent of the registry IRI
    expect(recorded.id).toMatch(/^https:\/\/auth\.alice\.example\/[0-9a-f-]{36}$/u)
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
    mockAdminRegistry()

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
    mockAdminRegistry()

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
  const ROOT = 'https://auth.alice.example/root'
  const AB = 'https://auth.alice.example/ab'
  const BC = 'https://auth.alice.example/bc'
  const CHILD_SOURCE = 'https://auth.alice.example/child-source'
  const CHILD = 'https://auth.alice.example/child'
  const PROJECT_TREE = 'https://shapetrees.example/trees/Project'
  const TASK_TREE = 'https://shapetrees.example/trees/Task'
  const PROJECT_REG = 'https://data.alice.example/projects/'
  const TASK_REG = 'https://data.alice.example/tasks/'
  const STORAGE = 'https://data.alice.example/'

  interface GrantOverrides {
    grantee?: string
    accessMode?: Array<string>
    hasStorage?: string
    dataOwner?: string
    grantedBy?: string
    registeredShapeTree?: string
    hasDataRegistration?: string
    scopeOfGrant?: string
    hasDataInstance?: Array<string>
    inheritsFromGrant?: string
  }

  /** Build a canonical grant from the legacy-named fixture overrides. */
  const grantFixture = (id: string, overrides: GrantOverrides = {}): GrantData => {
    const grantee = overrides.grantee ?? BOB
    const actions = overrides.accessMode ?? [ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify]
    const storage = overrides.hasStorage ?? STORAGE
    const hasDataRegistration = overrides.hasDataRegistration ?? PROJECT_REG
    const scopeOfGrant = overrides.scopeOfGrant ?? INTEROP.AllFromRegistry
    return {
      id,
      type: [LWS.AccessGrant],
      storage,
      access: grantAccess({
        scopeOfGrant,
        owner: overrides.dataOwner ?? ALICE,
        storage,
        hasDataRegistration,
        hasDataInstance: overrides.hasDataInstance,
        registeredShapeTree: overrides.registeredShapeTree ?? PROJECT_TREE,
        assigner: overrides.grantedBy ?? ALICE,
        assignee: grantee,
        actions,
      }),
      dataOwner: overrides.dataOwner ?? ALICE,
      grantedBy: overrides.grantedBy ?? ALICE,
      registeredShapeTree: overrides.registeredShapeTree ?? PROJECT_TREE,
      hasDataRegistration,
      scopeOfGrant,
      ...(overrides.hasDataInstance ? { hasDataInstance: overrides.hasDataInstance } : {}),
      ...(overrides.inheritsFromGrant ? { inheritsFromGrant: overrides.inheritsFromGrant } : {}),
    }
  }

  // source D→A; delegated A→B; delegated B→C; the source child D→A for the
  // Task shape and the delegated child A→B inheriting from A→B Project
  const root = grantFixture(ROOT)
  const ab = grantFixture(AB, { grantedBy: BOB, grantee: KIM, accessMode: [ACCESS_ACTIONS.read] })
  const bc = grantFixture(BC, { grantedBy: KIM, grantee: DAN, accessMode: [ACCESS_ACTIONS.read] })
  const childSource = grantFixture(CHILD_SOURCE, {
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REG,
    scopeOfGrant: INTEROP.Inherited,
    inheritsFromGrant: ROOT,
    accessMode: [ACCESS_ACTIONS.read],
  })
  const child = grantFixture(CHILD, {
    grantedBy: BOB,
    grantee: KIM,
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REG,
    scopeOfGrant: INTEROP.Inherited,
    inheritsFromGrant: AB,
    accessMode: [ACCESS_ACTIONS.read],
  })
  const baseGrants = [root, ab, bc, childSource, child]
  const foreignGrant = grantFixture('https://auth.kim.example/foreign', {
    dataOwner: KIM,
    grantedBy: KIM,
    grantee: DAN,
  })
  const pathGrant = grantFixture(`${GRANT_REGISTRY}path-shaped`)

  const grantQuads = (grant: GrantData) => {
    const node = DataFactory.namedNode(grant.id!)
    const policy = DataFactory.namedNode(`urn:uuid:${grant.id}-policy`)
    const permission = DataFactory.namedNode(`urn:uuid:${grant.id}-permission`)
    const permissionNode = grant.access[0].permission[0]
    const target = DataFactory.namedNode(permissionNode.target.id!)
    const q = (predicate: string, object: string) =>
      DataFactory.quad(node, DataFactory.namedNode(predicate), DataFactory.namedNode(object))
    const targetQuads = (
      targetId: string,
      targetValue: {
        type: Array<string>
        source: Array<string>
        owner?: string
        storage?: string
        registeredShapeTree?: string
        hasDataRegistration?: string
      }
    ) => {
      const targetNode = DataFactory.namedNode(targetId)
      const quads = [
        DataFactory.quad(permission, DataFactory.namedNode(ODRL.target), targetNode),
        DataFactory.quad(targetNode, DataFactory.namedNode(ODRL.uid), targetNode),
      ]
      for (const type of targetValue.type) {
        quads.push(
          DataFactory.quad(targetNode, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(type))
        )
      }
      for (const source of targetValue.source) {
        quads.push(
          DataFactory.quad(
            targetNode,
            DataFactory.namedNode(ODRL.source),
            DataFactory.namedNode(source)
          )
        )
      }
      if (targetValue.owner) {
        quads.push(
          DataFactory.quad(
            targetNode,
            DataFactory.namedNode(INTEROP.dataOwner),
            DataFactory.namedNode(targetValue.owner)
          )
        )
      }
      if (targetValue.storage) {
        quads.push(
          DataFactory.quad(
            targetNode,
            DataFactory.namedNode(LWS.storage),
            DataFactory.namedNode(targetValue.storage)
          )
        )
      }
      if (targetValue.registeredShapeTree) {
        quads.push(
          DataFactory.quad(
            targetNode,
            DataFactory.namedNode(INTEROP.registeredShapeTree),
            DataFactory.namedNode(targetValue.registeredShapeTree)
          )
        )
      }
      if (targetValue.hasDataRegistration) {
        quads.push(
          DataFactory.quad(
            targetNode,
            DataFactory.namedNode(INTEROP.hasDataRegistration),
            DataFactory.namedNode(targetValue.hasDataRegistration)
          )
        )
      }
      return quads
    }
    const quads = [
      q(RDF_TYPE, LWS.AccessGrant),
      q(INTEROP.scopeOfGrant, grant.scopeOfGrant),
      DataFactory.quad(node, DataFactory.namedNode(LWS.access), policy),
      DataFactory.quad(
        policy,
        DataFactory.namedNode(RDF_TYPE),
        DataFactory.namedNode(ODRL.Agreement)
      ),
      DataFactory.quad(policy, DataFactory.namedNode(ODRL.uid), policy),
      DataFactory.quad(
        policy,
        DataFactory.namedNode(ODRL.profile),
        DataFactory.namedNode(INTEROP.AccessProfile)
      ),
      DataFactory.quad(
        policy,
        DataFactory.namedNode(INTEROP.scopeOfGrant),
        DataFactory.namedNode(grant.scopeOfGrant)
      ),
      DataFactory.quad(policy, DataFactory.namedNode(ODRL.permission), permission),
      DataFactory.quad(permission, DataFactory.namedNode(ODRL.uid), permission),
      DataFactory.quad(
        permission,
        DataFactory.namedNode(ODRL.assigner),
        DataFactory.namedNode(grant.grantedBy)
      ),
      DataFactory.quad(
        permission,
        DataFactory.namedNode(ODRL.assignee),
        DataFactory.namedNode(grantGrantee(grant) ?? '')
      ),
      ...grantAccessModes(grant).map((mode) =>
        DataFactory.quad(
          permission,
          DataFactory.namedNode(ODRL.action),
          DataFactory.namedNode(mode)
        )
      ),
    ]
    for (const [index, p] of grant.access.flatMap((policy) => policy.permission).entries()) {
      const targetId = index === 0 ? target.value : `${target.value}-${index}`
      quads.push(...targetQuads(targetId, p.target))
    }
    if (grant.inheritsFromGrant) {
      quads.push(q(INTEROP.inheritsFromGrant, grant.inheritsFromGrant))
    }
    return quads
  }

  /**
   * Serve the target registry listing from `contained` and every loadable grant
   * graph/authority from `existing` — a body may exist on the transport without
   * being a member of this registry.
   */
  const installRegistry = (
    existing: Array<GrantData> = baseGrants,
    contained: Array<GrantData> = existing
  ) => {
    sparqlMock.handlers.bindings = (query) => {
      if (query.includes('lws#contains')) {
        return contained.map((grant) => ({
          child: { termType: 'NamedNode', value: grant.id },
        }))
      }
      if (query.includes('?dataOwner')) {
        // the authority read filters with VALUES ?grant { … }
        const requested = new Set([...query.matchAll(/<([^>]+)>/g)].map((match) => match[1]))
        return existing.flatMap((grant) =>
          requested.has(grant.id!)
            ? [
                {
                  grant: { termType: 'NamedNode', value: grant.id },
                  dataOwner: { termType: 'NamedNode', value: grant.dataOwner },
                  grantedBy: { termType: 'NamedNode', value: grant.grantedBy },
                  grantee: { termType: 'NamedNode', value: grantGrantee(grant) ?? '' },
                },
              ]
            : []
        )
      }
      throw new Error(`unexpected SELECT: ${query}`)
    }
    sparqlMock.handlers.triples = (query) => {
      for (const grant of existing) {
        if (query.includes(`GRAPH <${grant.id}>`)) {
          return grantQuads(grant)
        }
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

  test('a mixed-owner request fails as a whole on the existing grants (B2)', async () => {
    installRegistry([...baseGrants, foreignGrant])
    const agent = await buildAgent()

    // both grants exist; ownership comes from their bodies, not their IRIs
    await expect(agent.revokeGrants([AB, foreignGrant.id!], ALICE)).rejects.toMatchObject({
      name: 'RevocationError',
      code: 'mixed-owner',
      grants: [AB, foreignGrant.id!],
    })
  })

  test('an existing grant from another registry is a typed wrong-data-owner refusal', async () => {
    // the body is loadable on this transport, but it is not a member of the
    // target registry
    installRegistry([...baseGrants, foreignGrant], baseGrants)
    const agent = await buildAgent()

    await expect(agent.revokeGrants([foreignGrant.id!], ALICE)).rejects.toMatchObject({
      name: 'RevocationError',
      code: 'wrong-data-owner',
      grants: [foreignGrant.id!],
    })
  })

  test('an existing path-shaped member of the target registry is revocable', async () => {
    // the IRI shape is irrelevant: membership in the target registry is what
    // makes it revocable
    installRegistry([...baseGrants, pathGrant])
    const agent = await buildAgent()

    const revoked = await agent.revokeGrants([pathGrant.id!], ALICE)
    expect(revoked.map((grant) => grant.iri)).toEqual([pathGrant.id])
  })

  test('a grant IRI with no body is an idempotent no-op regardless of path shape', async () => {
    installRegistry()
    const agent = await buildAgent()
    const missing = 'https://auth.kim.example/grant/missing'

    await expect(agent.revokeGrants([missing], ALICE)).resolves.toEqual([])
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

    const collected: Array<string> = []
    for await (const id of dataInstanceIrisForGrant(
      {
        id: 'https://auth.alice.example/grant/1',
        type: [LWS.AccessGrant],
        grantee: 'https://bob.example/#id',
        grantedBy: webId,
        dataOwner: webId,
        registeredShapeTree: 'https://shapetrees.example/Project',
        hasDataRegistration: REGISTRATION,
        hasStorage: 'https://storage/',
        scopeOfGrant: INTEROP.AllFromRegistry,
        accessMode: [ACCESS_ACTIONS.read],
      },
      localSparqlTransport('http://example.test/sparql'),
      statelessFetch
    )) {
      collected.push(id)
    }

    expect(collected).toEqual([INSTANCE_1, INSTANCE_2])
  })
})
