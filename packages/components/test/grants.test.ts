import { randomUUID } from 'node:crypto'

import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { AuthorizationAgent as AuthorizationAgentType } from '@janeirodigital/interop-authorization-agent'
import { INTEROP } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// Mocks
// ──────────────────────────

/** The activity gets its session via buildSessionManager — stub it. */
const sessionMock = vi.hoisted(() => {
  let session: unknown
  return {
    setSession: (s: unknown) => {
      session = s
    },
    getSession: () => session,
  }
})

vi.mock('../src/builders/sessionManager.js', () => ({
  buildSessionManager: () => ({ getSession: async () => sessionMock.getSession() }),
}))

/** The session reads its own registry via the internal SPARQL endpoint. */
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

import {
  findAffectedGrantees,
  findRoleUsage,
  groupAuthorizationDataAuthorizations,
  resolveActivityGrantee,
} from '../src/temporal/activities/grants.js'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const ALICE = 'https://alice.example/#id'
const ROLE_ID = 'https://auth.alice.example/role/admin'
const AUTHZ_REGISTRY = 'https://auth.alice.example/authorization/'
const SOCIAL_AGENT_REGISTRY = 'https://auth.alice.example/social-agent/'
const AUTHZ_GRANTEE = 'https://auth.alice.example/authz-grantee'
const AUTHZ_ADMIN = 'https://auth.alice.example/admin-authz'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

const authzGraph = (
  iri: string,
  type: string,
  grantee: string,
  dataOwner: string,
  scope = INTEROP.All
) => [
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
    DataFactory.namedNode(ALICE)
  ),
  DataFactory.quad(
    DataFactory.namedNode(iri),
    DataFactory.namedNode(INTEROP.dataOwner),
    DataFactory.namedNode(dataOwner)
  ),
  DataFactory.quad(
    DataFactory.namedNode(iri),
    DataFactory.namedNode(INTEROP.scopeOfAuthorization),
    DataFactory.namedNode(scope)
  ),
]

/** A social-agent registration graph for a grantee (typed via the agent plane). */
const registrationGraph = (iri: string) => [
  DataFactory.quad(
    DataFactory.namedNode(iri),
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(INTEROP.SocialAgentRegistration)
  ),
  DataFactory.quad(
    DataFactory.namedNode(iri),
    DataFactory.namedNode(INTEROP.registeredAgent),
    DataFactory.namedNode(iri)
  ),
]

/**
 * A real AuthorizationAgent (no bootstrap — no fetch used): the match/typing
 * sessions run purely over the registry plane, which the sparqlMock serves.
 */
function fakeSession(): AuthorizationAgentType {
  const agent = new AuthorizationAgent(ALICE, 'https://auth.alice.example/#agent', {
    fetch: async () => {
      throw new Error('no fetch expected')
    },
    randomUUID,
    sparqlEndpoint: 'http://example.test/sparql',
  })
  agent.registrySet = {
    type: [],
    hasAuthorizationRegistry: { id: AUTHZ_REGISTRY },
    hasGrantRegistry: { id: 'https://auth.alice.example/grant/' },
    hasSocialAgentRegistry: { id: SOCIAL_AGENT_REGISTRY },
    hasApplicationRegistry: { id: 'https://auth.alice.example/application/' },
    hasInvitationRegistry: { id: 'https://auth.alice.example/invitation/' },
    hasRoleRegistry: { id: 'https://auth.alice.example/role/' },
    hasDataRegistry: [],
  }
  return agent
}

const rolePayload = () => ({
  webId: { id: ALICE, type: [INTEROP.SocialAgent] } as never,
  roleId: { id: ROLE_ID, type: [INTEROP.Role] } as never,
})

// ──────────────────────────
// findRoleUsage — registry-plane sweep (docs/sparql.md, candidate 2)
// ──────────────────────────

describe('findRoleUsage — authorizations sweep via SPARQL', () => {
  test('grantee match included; non-DataAuthorizations type-filtered', async () => {
    sessionMock.setSession(fakeSession())

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('SELECT DISTINCT ?child')
      if (query.includes(SOCIAL_AGENT_REGISTRY)) return []
      return [AUTHZ_GRANTEE, AUTHZ_ADMIN].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = (query) => {
      const graphs: Record<string, unknown[]> = {
        [AUTHZ_GRANTEE]: authzGraph(AUTHZ_GRANTEE, INTEROP.DataAuthorization, ROLE_ID, ALICE),
        [AUTHZ_ADMIN]: authzGraph(
          AUTHZ_ADMIN,
          'https://example/AdminAuthorization',
          ROLE_ID,
          ALICE
        ),
      }
      for (const [iri, quads] of Object.entries(graphs)) {
        if (query.includes(`GRAPH <${iri}>`)) return quads
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const usage = await findRoleUsage(rolePayload())

    expect(usage).toEqual({
      usedAsGrantee: true,
      affectedGrantees: [],
      authorizations: [{ id: AUTHZ_GRANTEE, type: [INTEROP.DataAuthorization] }],
    })
  })

  test('no match → the role is unused', async () => {
    sessionMock.setSession(fakeSession())

    sparqlMock.handlers.bindings = (query) => {
      if (query.includes(SOCIAL_AGENT_REGISTRY)) return []
      return [{ child: { termType: 'NamedNode', value: AUTHZ_GRANTEE } }]
    }
    sparqlMock.handlers.triples = (query) => {
      if (query.includes(`GRAPH <${AUTHZ_GRANTEE}>`)) {
        return authzGraph(
          AUTHZ_GRANTEE,
          INTEROP.DataAuthorization,
          'https://bob.example/#id',
          ALICE
        )
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const usage = await findRoleUsage(rolePayload())

    expect(usage).toEqual({
      usedAsGrantee: false,
      affectedGrantees: [],
      authorizations: [],
    })
  })
})

// ──────────────────────────
// findAffectedGrantees — delegation sweep via SPARQL (docs/sparql.md, candidate 3)
// ──────────────────────────

describe('findAffectedGrantees — delegation sweep via SPARQL', () => {
  const PEER = 'https://acme.example/#corp'
  const GRANTEE_A = 'https://bob.example/#id'
  const GRANTEE_B = 'https://jane.example/#id'
  const AUTHZ_DELEG = 'https://auth.alice.example/authz-deleg'
  const AUTHZ_ALL = 'https://auth.alice.example/authz-all'
  const AUTHZ_SELF = 'https://auth.alice.example/authz-self'
  const AUTHZ_ADMIN = 'https://auth.alice.example/authz-admin'
  const ROLE_ID = 'https://auth.alice.example/role/admin'

  const affectedPayload = (roleId?: string) => ({
    webId: { id: ALICE, type: [INTEROP.SocialAgent] } as never,
    peerId: { id: PEER, type: [INTEROP.SocialAgent] } as never,
    roleId: roleId ? ({ id: roleId, type: [INTEROP.Role] } as never) : undefined,
  })

  const routeTriples = (query: string): unknown[] => {
    const graphs: Record<string, unknown[]> = {
      [AUTHZ_DELEG]: authzGraph(AUTHZ_DELEG, INTEROP.DataAuthorization, GRANTEE_A, PEER),
      [AUTHZ_ALL]: authzGraph(
        AUTHZ_ALL,
        INTEROP.DataAuthorization,
        GRANTEE_B,
        'https://other.example/#corp'
      ),
      [AUTHZ_SELF]: authzGraph(AUTHZ_SELF, INTEROP.DataAuthorization, PEER, PEER),
      [AUTHZ_ADMIN]: authzGraph(AUTHZ_ADMIN, 'https://example/AdminAuthorization', GRANTEE_A, PEER),
    }
    for (const [iri, quads] of Object.entries(graphs)) {
      if (query.includes(`GRAPH <${iri}>`)) return quads
    }
    // the grantee registrations (session's plane-based typing)
    for (const iri of [GRANTEE_A, GRANTEE_B]) {
      if (query.includes(`GRAPH <${iri}>`)) return registrationGraph(iri)
    }
    throw new Error(`unexpected CONSTRUCT: ${query}`)
  }

  test('dataOwner and All-scope matches typed and deduped; self-grants and non-DataAuthorizations excluded', async () => {
    sessionMock.setSession(fakeSession())

    sparqlMock.handlers.bindings = (query) => {
      // the agent registry listing serves the grantee registrations so the
      // session types them as social agents
      if (query.includes(SOCIAL_AGENT_REGISTRY)) {
        return [GRANTEE_A, GRANTEE_B].map((iri) => ({
          child: { termType: 'NamedNode', value: iri },
        }))
      }
      return [AUTHZ_DELEG, AUTHZ_ALL, AUTHZ_SELF, AUTHZ_ADMIN].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = routeTriples

    const grantees = await findAffectedGrantees(affectedPayload())

    expect(grantees).toEqual([
      { id: GRANTEE_A, type: [INTEROP.SocialAgent] },
      { id: GRANTEE_B, type: [INTEROP.SocialAgent] },
    ])
  })

  test('with a roleId, All-scope authorizations are no longer matched', async () => {
    sessionMock.setSession(fakeSession())

    sparqlMock.handlers.bindings = (query) => {
      if (query.includes(SOCIAL_AGENT_REGISTRY)) {
        return [GRANTEE_A].map((iri) => ({ child: { termType: 'NamedNode', value: iri } }))
      }
      return [AUTHZ_DELEG, AUTHZ_ALL].map((iri) => ({
        child: { termType: 'NamedNode', value: iri },
      }))
    }
    sparqlMock.handlers.triples = routeTriples

    const grantees = await findAffectedGrantees(affectedPayload(ROLE_ID))

    expect(grantees).toEqual([{ id: GRANTEE_A, type: [INTEROP.SocialAgent] }])
  })
})

// ──────────────────────────
// resolveActivityGrantee — the grantee rides the object (parties ride the
// object; the wire contract in the OpenWiki `services/activity-lifecycle.md`).
// Granted authorizations embed the
// DataAuthorization POJO(s)-to-be — the grantee is read from the first DA
// (no deref — the resource does not exist until the workflow PUTs it).
// (The old deny-snapshot dispatch moved out of this path in Step 4 —
// declines are `AuthorizationDenied`, forward-only.)
// ──────────────────────────

describe('resolveActivityGrantee — object-carried grantee', () => {
  test('granted authorization: grantee from the first embedded DataAuthorization POJO', async () => {
    const GRANTEE = 'https://bob.example/#id'
    sessionMock.setSession(fakeSession())

    sparqlMock.handlers.bindings = (query) => {
      expect(query).toContain('SELECT DISTINCT ?child')
      if (query.includes(SOCIAL_AGENT_REGISTRY)) {
        return [{ child: { termType: 'NamedNode', value: GRANTEE } }]
      }
      // application + role registries empty
      return []
    }
    sparqlMock.handlers.triples = (query) => {
      if (query.includes(GRANTEE)) return registrationGraph(GRANTEE)
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    }

    const activity = {
      id: 'https://registry/alice/activity/grant',
      type: ['Activity', 'AuthorizationGranted'],
      target: AUTHZ_REGISTRY,
      createdAt: '2024-01-01T00:00:00.000Z',
      actor: ALICE,
      object: [
        {
          id: 'https://registry/alice/authorization/da-granted',
          type: [INTEROP.DataAuthorization],
          grantee: GRANTEE,
          grantedBy: ALICE,
          registeredShapeTree: 'https://data/shapetrees/trees/Project',
          scopeOfAuthorization: INTEROP.SelectedFromRegistry,
          dataOwner: ALICE,
          accessMode: ['http://www.w3.org/ns/auth/acl#Read'],
        },
      ],
    }

    const grantee = await resolveActivityGrantee({ activity })

    expect(grantee).toEqual({ id: GRANTEE, type: [INTEROP.SocialAgent] })
  })
})

describe('groupAuthorizationDataAuthorizations', () => {
  const da = (id: string, grantee: string) => ({
    id,
    type: [INTEROP.DataAuthorization],
    grantee,
    grantedBy: 'https://id/alice',
    registeredShapeTree: 'https://data/shapetrees/trees/Project',
    scopeOfAuthorization: INTEROP.SelectedFromRegistry,
    dataOwner: 'https://id/alice',
    accessMode: ['http://www.w3.org/ns/auth/acl#Read'],
  })

  test('groups embedded DAs by grantee — a parent + its child stay together', () => {
    const groups = groupAuthorizationDataAuthorizations([
      da('https://registry/alice/authorization/p-kim', 'https://id/kim'),
      da('https://registry/alice/authorization/c-kim', 'https://id/kim'),
      da('https://registry/alice/authorization/p-bob', 'https://id/bob'),
    ])
    expect(groups).toHaveLength(2)
    const ids = groups.map((group) =>
      Array.isArray(group) ? group.map((member) => member.id).toSorted() : []
    )
    expect(ids).toEqual([
      ['https://registry/alice/authorization/c-kim', 'https://registry/alice/authorization/p-kim'],
      ['https://registry/alice/authorization/p-bob'],
    ])
  })

  test('a single DA yields one group', () => {
    const groups = groupAuthorizationDataAuthorizations([
      da('https://registry/alice/authorization/p-kim', 'https://id/kim'),
    ])
    expect(groups).toHaveLength(1)
    expect(Array.isArray(groups[0])).toBe(true)
  })
})
