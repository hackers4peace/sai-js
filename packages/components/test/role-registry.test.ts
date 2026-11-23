import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { describe, expect, test } from 'vitest'

import type { ResolvedContext } from '../src/services/Context.js'
import { getRoles } from '../src/services/RoleRegistry.js'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const ORG_WEBID = 'https://yoyo.example/profile/card#me'
const ORG_AA = 'https://yoyo.example/.sai/agents/zzzz'
const USER_WEBID = 'https://dan.example/profile/card#me'
const ROLE_REGISTRY = 'https://registry/yoyo/role/'
const ROLE_IRI = 'https://registry/yoyo/r1'
const MEMBER = 'https://id/dan'

/** Org webid doc exposing the org's authorization agent (admin discovery). */
const orgProfileDoc = {
  '@id': ORG_WEBID,
  'http://www.w3.org/ns/solid/interop#hasAuthorizationAgent': { '@id': ORG_AA },
}

const roleDoc = [
  {
    '@id': ROLE_IRI,
    '@type': ['http://www.w3.org/ns/solid/interop#Role'],
    'http://www.w3.org/2004/02/skos/core#prefLabel': [{ '@value': 'Admins' }],
    'http://www.w3.org/ns/solid/interop#hasMember': [{ '@id': MEMBER }],
  },
]

function mockResponse(body: unknown, status = 200, contentType = 'application/ld+json'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/** Minimal resolved org context (webId ≠ userWebId routes via /sparql-admin). */
function orgCtx(session: AuthorizationAgent): ResolvedContext {
  return {
    session,
    webId: ORG_WEBID,
    userWebId: USER_WEBID,
    registrySet: { hasRoleRegistry: { id: ROLE_REGISTRY } },
  } as unknown as ResolvedContext
}

const sparqlAdminUrl = `${new URL(ORG_AA).origin}/.sai/sparql-admin/${Buffer.from(ORG_WEBID).toString('base64url')}`

/**
 * Session answering: org webid profile → ORG_AA; /sparql-admin queries by
 * operation: SELECT → W3C JSON results (the listing), CONSTRUCT → the role
 * graph as JSON-LD (or an empty graph for a gone role).
 */
function sparqlAdminSession(roleDoc: unknown): {
  session: AuthorizationAgent
  requests: { url: string; init?: RequestInit }[]
} {
  const requests: { url: string; init?: RequestInit }[] = []
  const session = {
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (url === ORG_WEBID) {
        return mockResponse(orgProfileDoc)
      }
      if (url !== sparqlAdminUrl) {
        throw new Error(`unexpected request: ${url}`)
      }
      // the query travels as the POST body (application/sparql-query)
      const query = String(init?.body ?? '')
      if (query.includes('SELECT')) {
        // W3C SPARQL JSON results — what fetchBindings parses (response.json())
        return mockResponse(
          {
            head: { vars: ['child'] },
            results: { bindings: [{ child: { type: 'uri', value: ROLE_IRI } }] },
          },
          200,
          'application/sparql-results+json'
        )
      }
      if (query.includes('CONSTRUCT')) {
        // JSON-LD — what fetchTriples parses (toStore(response.json()))
        return mockResponse(roleDoc, 200, 'application/ld+json')
      }
      throw new Error(`unexpected sparql-admin query: ${query}`)
    },
  } as unknown as AuthorizationAgent
  return { session, requests }
}

// ──────────────────────────
// getRoles — roles listing via SPARQL (docs/sparql.md step 1)
// ──────────────────────────

describe('getRoles — org context lists roles via /sparql-admin', () => {
  test('listContained on the role registry, then one graph read per role', async () => {
    const { session, requests } = sparqlAdminSession(roleDoc)

    const roles = await getRoles(orgCtx(session), 'en')

    expect(roles).toEqual([{ id: ROLE_IRI, label: 'Admins', members: [MEMBER] }])
    const sparqlRequests = requests.filter((request) => request.url === sparqlAdminUrl)
    // one SELECT (listContained) + one CONSTRUCT (role graph read)
    expect(sparqlRequests).toHaveLength(2)
    expect(String(sparqlRequests[0].init?.body).includes('SELECT DISTINCT ?child')).toBe(true)
    expect(String(sparqlRequests[1].init?.body).includes('CONSTRUCT')).toBe(true)
  })

  test('skips roles whose graph no longer exists (empty CONSTRUCT)', async () => {
    const { session } = sparqlAdminSession([])

    const roles = await getRoles(orgCtx(session), 'en')

    expect(roles).toEqual([])
  })
})
