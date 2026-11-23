import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { grantAccess } from '@janeirodigital/interop-data-model'
import type {
  DataAuthorizationData,
  DataInstanceData,
  GrantData,
} from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP, LWS, ODRL } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import type { ResolvedContext } from '../src/services/Context.js'
import {
  PeerProxyError,
  dataRegistrationContains,
  fetchPeerDocument,
  peerInstanceIris,
} from '../src/services/peerData.js'
import {
  getSocialAgentRegistration,
  listContained,
  sparqlTransportFor,
} from '../src/services/queries/org.js'
import { agentsWithAccessMatching, whoHasAccessMatching } from '../src/services/ShareResource.js'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const YOYO_WEBID = 'https://yoyo.example/profile/card#me'
const YOYO_AA = 'https://yoyo.example/.sai/agents/zzzz'
const DAN_WEBID = 'https://dan.example/profile/card#me'
const PEER_STORAGE = 'https://peer.example/data/'
const PEER_REGISTRATION = 'https://peer.example/data/registrations/abc/'
const PEER_INSTANCE = 'https://peer.example/data/abc/123'

/** WebID profile doc with `interop:hasAuthorizationAgent` as a full-IRI key. */
const yoyoProfileDoc = {
  '@id': YOYO_WEBID,
  'http://www.w3.org/ns/solid/interop#hasAuthorizationAgent': { '@id': YOYO_AA },
}

/** Static JSON-LD doc for the peer data registration (absolute-IRI keys, no context). */
const peerRegistrationDoc = {
  '@id': PEER_REGISTRATION,
  'http://www.w3.org/ns/solid/interop#registeredShapeTree': {
    '@id': 'https://shapetrees.example/Project',
  },
  'http://www.w3.org/ns/ldp#contains': [{ '@id': PEER_INSTANCE }],
}

// Minimal Response-like object for mocked fetches (same pattern as the
// packages/data-model tests); exposes only the members the code touches.
function jsonResponse(body: unknown, status = 200, contentType = 'application/ld+json'): Response {
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

/** Fake session: a WhatwgFetch that answers by URL. */
function fakeSession(
  onRequest: (url: string, init?: RequestInit) => Promise<Response>
): AuthorizationAgent {
  return {
    fetch: onRequest as unknown as AuthorizationAgent['fetch'],
  } as unknown as AuthorizationAgent
}

/**
 * Minimal ResolvedContext. `storageFetch` is what the data plane now uses for
 * peer documents — in the org context it carries the read-only impersonation,
 * in the personal context the user's own credentials. `session.fetch` stays for
 * public documents (shape trees) and for the user's own plane.
 */
function fakeCtx(
  byIri: Record<string, unknown>,
  options: {
    ctxWebId?: string
    userWebId?: string
    status?: Record<string, number>
    storageFetchError?: Error
  } = {}
): { ctx: ResolvedContext; requests: Array<{ storage: string; url: string }> } {
  const requests: Array<{ storage: string; url: string }> = []
  const answer = async (url: string): Promise<Response> => {
    const failed = options.status?.[url]
    if (failed) {
      return jsonResponse({ error: 'denied' }, failed, 'text/plain')
    }
    const doc = byIri[url]
    if (!doc) {
      throw new Error(`unexpected fetch for ${url}`)
    }
    return jsonResponse(doc)
  }
  const ctx = {
    session: { fetch: ((url: string) => answer(url)) as unknown as WhatwgFetch },
    webId: options.ctxWebId ?? YOYO_WEBID,
    userWebId: options.userWebId ?? DAN_WEBID,
    storageFetch: async (storage: string) => {
      if (options.storageFetchError) {
        throw options.storageFetchError
      }
      return (async (url: string) => {
        requests.push({ storage, url })
        return answer(url)
      }) as unknown as WhatwgFetch
    },
  } as unknown as ResolvedContext
  return { ctx, requests }
}

/** Minimal context for the registry-plane tests (no storage fetch involved). */
function fakeSessionCtx(
  session: AuthorizationAgent,
  webId: string,
  userWebId: string
): ResolvedContext {
  return { session, webId, userWebId } as unknown as ResolvedContext
}

const collect = async (iter: AsyncIterable<string>): Promise<Array<string>> => {
  const out: Array<string> = []
  for await (const iri of iter) {
    out.push(iri)
  }
  return out
}

// ──────────────────────────
// fetchPeerDocument
// ──────────────────────────

describe('fetchPeerDocument', () => {
  test('reads the document through the storage fetch, scoped to the grant storage', async () => {
    const { ctx, requests } = fakeCtx({ [PEER_REGISTRATION]: peerRegistrationDoc })

    await expect(fetchPeerDocument(ctx, PEER_STORAGE, PEER_REGISTRATION)).resolves.toEqual(
      peerRegistrationDoc
    )
    // one request, through the storage the context holds credentials for —
    // no document-proxy endpoint, no discovery round trip
    expect(requests).toEqual([{ storage: PEER_STORAGE, url: PEER_REGISTRATION }])
  })

  test('surfaces the upstream status as PeerProxyError', async () => {
    const { ctx } = fakeCtx({}, { status: { [PEER_REGISTRATION]: 403 } })

    await expect(fetchPeerDocument(ctx, PEER_STORAGE, PEER_REGISTRATION)).rejects.toMatchObject({
      name: 'PeerProxyError',
      status: 403,
    })
  })

  test('wraps a storage fetch that cannot be created (no authority) in PeerProxyError', async () => {
    const { ctx } = fakeCtx({}, { storageFetchError: new Error('not an admin') })

    const error = await fetchPeerDocument(ctx, PEER_STORAGE, PEER_REGISTRATION).catch(
      (error_: unknown) => error_
    )
    expect(PeerProxyError.isInstance?.(error) ?? error instanceof PeerProxyError).toBe(true)
    expect((error as PeerProxyError).message).toContain('not an admin')
    expect((error as PeerProxyError).status).toBeUndefined()
  })
})

// ──────────────────────────
// dataRegistrationContains
// ──────────────────────────

describe('dataRegistrationContains', () => {
  test('parses `contains` from the registration read with the storage credentials', async () => {
    const { ctx, requests } = fakeCtx({ [PEER_REGISTRATION]: peerRegistrationDoc })

    await expect(dataRegistrationContains(ctx, PEER_STORAGE, PEER_REGISTRATION)).resolves.toEqual([
      PEER_INSTANCE,
    ])
    expect(requests).toHaveLength(1)
  })

  test('propagates the upstream status', async () => {
    const { ctx } = fakeCtx({}, { status: { [PEER_REGISTRATION]: 403 } })

    await expect(
      dataRegistrationContains(ctx, PEER_STORAGE, PEER_REGISTRATION)
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ──────────────────────────
// peerInstanceIris
// ──────────────────────────

const grantData = (scopeOfGrant: string, extra: Partial<GrantData> = {}): GrantData => {
  const registeredShapeTree = extra.registeredShapeTree ?? 'https://shapetrees.example/Child'
  const hasDataInstance = extra.hasDataInstance ?? []
  return {
    id: 'https://peer.example/grants/1',
    type: [LWS.AccessGrant],
    storage: PEER_STORAGE,
    access: grantAccess({
      scopeOfGrant,
      storage: PEER_STORAGE,
      hasDataRegistration: PEER_REGISTRATION,
      hasDataInstance,
      registeredShapeTree,
      owner: 'https://peer.example/profile/card#me',
      assigner: 'https://peer.example/profile/card#me',
      assignee: YOYO_WEBID,
      actions: [ACCESS_ACTIONS.read],
    }),
    grantedBy: 'https://peer.example/profile/card#me',
    dataOwner: 'https://peer.example/profile/card#me',
    registeredShapeTree,
    hasDataRegistration: PEER_REGISTRATION,
    scopeOfGrant,
    ...(hasDataInstance.length ? { hasDataInstance } : {}),
    ...extra,
  }
}

describe('peerInstanceIris', () => {
  test('AllFromRegistry — `contains` of the peer registration', async () => {
    const { ctx } = fakeCtx({ [PEER_REGISTRATION]: peerRegistrationDoc })
    const iris = await collect(peerInstanceIris(ctx, grantData(INTEROP.AllFromRegistry)))
    expect(iris).toEqual([PEER_INSTANCE])
  })

  test('SelectedFromRegistry — instance list from grant metadata, no fetch', async () => {
    const { ctx, requests } = fakeCtx({})
    const iris = await collect(
      peerInstanceIris(
        ctx,
        grantData(INTEROP.SelectedFromRegistry, {
          hasDataInstance: ['https://peer.example/data/a', 'https://peer.example/data/b'],
        })
      )
    )
    expect(iris).toEqual(
      expect.arrayContaining(['https://peer.example/data/a', 'https://peer.example/data/b'])
    )
    expect(requests).toHaveLength(0)
  })

  test('Inherited — parent grant, parent `contains`, and parent content', async () => {
    const parentGrantIri = 'https://peer.example/grants/parent'
    const parentRegistrationIri = 'https://peer.example/data/registrations/parent/'
    const parentInstanceIri = 'https://peer.example/data/parent/1'
    const childInstanceIri = 'https://peer.example/data/child/1'
    const parentShapeTreeIri = 'https://shapetrees.example/Parent'
    const viaPredicate = 'https://shapetrees.example/via#child'

    const parentGrantDoc = {
      '@id': parentGrantIri,
      '@type': [LWS.AccessGrant],
      [INTEROP.scopeOfGrant]: [{ '@id': INTEROP.AllFromRegistry }],
      [LWS.access]: [
        {
          '@id': `${parentGrantIri}#policy`,
          '@type': [ODRL.Agreement],
          [ODRL.uid]: [{ '@id': `${parentGrantIri}#policy` }],
          [ODRL.profile]: [{ '@id': INTEROP.AccessProfile }],
          [ODRL.permission]: [
            {
              '@id': `${parentGrantIri}#permission`,
              [ODRL.uid]: [{ '@id': `${parentGrantIri}#permission` }],
              [ODRL.assigner]: [{ '@id': 'https://peer.example/profile/card#me' }],
              [ODRL.assignee]: [{ '@id': YOYO_WEBID }],
              [ODRL.action]: [{ '@id': ACCESS_ACTIONS.read }],
              [ODRL.target]: [
                {
                  '@id': `${parentGrantIri}#target`,
                  [ODRL.uid]: [{ '@id': `${parentGrantIri}#target` }],
                  '@type': [ODRL.AssetCollection, INTEROP.DataRegistration],
                  [ODRL.source]: [{ '@id': parentRegistrationIri }],
                  [INTEROP.registeredShapeTree]: [{ '@id': parentShapeTreeIri }],
                  [INTEROP.dataOwner]: [{ '@id': 'https://peer.example/profile/card#me' }],
                  [LWS.storage]: [{ '@id': PEER_STORAGE }],
                },
              ],
            },
          ],
        },
      ],
    }
    const parentRegistrationDoc = {
      '@id': parentRegistrationIri,
      'http://www.w3.org/ns/ldp#contains': [{ '@id': parentInstanceIri }],
    }
    const parentInstanceDoc = {
      '@id': parentInstanceIri,
      [viaPredicate]: [{ '@id': childInstanceIri }],
    }
    // public shape tree — resolved with the (admin) session, not the storage
    const parentShapeTreeDoc = {
      '@id': parentShapeTreeIri,
      'http://www.w3.org/ns/shapetrees#expectsType': {
        '@id': 'http://www.w3.org/ns/shapetrees#RDFResource',
      },
      'http://www.w3.org/ns/shapetrees#describesInstance': {
        '@id': 'https://example/ldt/describesInstance',
      },
      'http://www.w3.org/ns/shapetrees#references': [
        {
          'http://www.w3.org/ns/shapetrees#hasShapeTree': {
            '@id': 'https://shapetrees.example/Child',
          },
          'http://www.w3.org/ns/shapetrees#viaPredicate': { '@id': viaPredicate },
        },
      ],
    }
    const { ctx, requests } = fakeCtx({
      [parentGrantIri]: parentGrantDoc,
      [parentRegistrationIri]: parentRegistrationDoc,
      [parentInstanceIri]: parentInstanceDoc,
      [parentShapeTreeIri]: parentShapeTreeDoc,
    })

    const iris = await collect(
      peerInstanceIris(ctx, grantData(INTEROP.Inherited, { inheritsFromGrant: parentGrantIri }))
    )
    expect(iris).toEqual([childInstanceIri])
    // every peer document went through the grant's storage
    expect(requests.map((request) => request.url)).toEqual([
      parentGrantIri,
      parentRegistrationIri,
      parentInstanceIri,
    ])
    expect(new Set(requests.map((request) => request.storage))).toEqual(new Set([PEER_STORAGE]))
  })
})
// ──────────────────────────
// agentsWithAccessMatching
// ──────────────────────────

const resource: DataInstanceData = {
  id: PEER_INSTANCE,
  shapeTreeIri: 'https://shapetrees.example/Child',
  isBlob: false,
  children: [],
  dataRegistration: {
    id: PEER_REGISTRATION,
    registeredShapeTree: 'https://shapetrees.example/Child',
    contains: [],
    type: [],
  },
}

const authorization = (
  scope: string,
  extra: Partial<DataAuthorizationData> = {}
): DataAuthorizationData => ({
  id: 'https://yoyo.example/authorizations/1',
  type: [INTEROP.DataAuthorization],
  grantee: 'https://peer2.example/profile/card#me',
  grantedBy: YOYO_WEBID,
  registeredShapeTree: resource.shapeTreeIri!,
  scopeOfAuthorization: scope,
  accessMode: [],
  ...extra,
})

describe('agentsWithAccessMatching', () => {
  test('scope All — every matching-shape-tree grantee', () => {
    const agents = agentsWithAccessMatching(
      [
        authorization(INTEROP.All),
        authorization(INTEROP.All, { grantee: 'https://app.example/1' }),
      ],
      resource,
      YOYO_WEBID
    )
    expect(agents).toHaveLength(2)
    expect(agents).toEqual(
      expect.arrayContaining(['https://peer2.example/profile/card#me', 'https://app.example/1'])
    )
  })

  test('AllFromAgent — only when the org is the data owner', () => {
    expect(
      agentsWithAccessMatching(
        [authorization(INTEROP.AllFromAgent, { dataOwner: YOYO_WEBID })],
        resource,
        YOYO_WEBID
      )
    ).toEqual(['https://peer2.example/profile/card#me'])
    expect(
      agentsWithAccessMatching(
        [
          authorization(INTEROP.AllFromAgent, {
            dataOwner: 'https://peer.example/profile/card#me',
          }),
        ],
        resource,
        YOYO_WEBID
      )
    ).toEqual([])
  })

  test('AllFromRegistry / SelectedFromRegistry — match the registration (and the instance)', () => {
    expect(
      agentsWithAccessMatching(
        [authorization(INTEROP.AllFromRegistry, { hasDataRegistration: PEER_REGISTRATION })],
        resource,
        YOYO_WEBID
      )
    ).toEqual(['https://peer2.example/profile/card#me'])
    expect(
      agentsWithAccessMatching(
        [
          authorization(INTEROP.AllFromRegistry, {
            hasDataRegistration: 'https://other.example/reg/',
          }),
        ],
        resource,
        YOYO_WEBID
      )
    ).toEqual([])
    expect(
      agentsWithAccessMatching(
        [
          authorization(INTEROP.SelectedFromRegistry, {
            hasDataRegistration: PEER_REGISTRATION,
            hasDataInstance: [PEER_INSTANCE],
          }),
        ],
        resource,
        YOYO_WEBID
      )
    ).toEqual(['https://peer2.example/profile/card#me'])
    expect(
      agentsWithAccessMatching(
        [
          authorization(INTEROP.SelectedFromRegistry, {
            hasDataRegistration: PEER_REGISTRATION,
            hasDataInstance: ['https://other.example/instance'],
          }),
        ],
        resource,
        YOYO_WEBID
      )
    ).toEqual([])
  })

  test('shape-tree mismatch skips the authorization; unknown scope throws', () => {
    expect(
      agentsWithAccessMatching(
        [authorization(INTEROP.All, { registeredShapeTree: 'https://shapetrees.example/Other' })],
        resource,
        YOYO_WEBID
      )
    ).toEqual([])
    expect(() =>
      agentsWithAccessMatching(
        [authorization('http://www.w3.org/ns/solid/interop#Nope')],
        resource,
        YOYO_WEBID
      )
    ).toThrow()
  })
})
describe('whoHasAccessMatching (roles)', () => {
  const WHIZ: RoleData = {
    id: 'https://yoyo.example/roles/whiz',
    type: [INTEROP.Role],
    label: { '@none': 'Whiz' },
    members: [DAN_WEBID],
  }

  test('a role-granted authorization is reported as a role, members expanded', () => {
    const access = whoHasAccessMatching(
      [
        authorization(INTEROP.AllFromRegistry, {
          grantee: WHIZ.id,
          hasDataRegistration: PEER_REGISTRATION,
        }),
      ],
      resource,
      YOYO_WEBID,
      [WHIZ]
    )
    expect(access.agents).toEqual([])
    expect(access.roles).toEqual([
      {
        role: WHIZ.id,
        label: WHIZ.label,
        members: [DAN_WEBID],
        dataAuthorization: 'https://yoyo.example/authorizations/1',
        accessMode: [],
      },
    ])
  })

  test('AllFromRole covers the org data only when the org is a role member', () => {
    const notMember = whoHasAccessMatching(
      [
        authorization(INTEROP.AllFromRole, {
          grantee: WHIZ.id,
          dataOwner: 'https://yoyo.example/roles/biz',
        }),
      ],
      resource,
      YOYO_WEBID,
      [
        WHIZ,
        {
          id: 'https://yoyo.example/roles/biz',
          type: [INTEROP.Role],
          label: { '@none': 'Biz' },
          members: [DAN_WEBID],
        },
      ]
    )
    expect(notMember.roles).toEqual([])

    const member = whoHasAccessMatching(
      [
        authorization(INTEROP.AllFromRole, {
          grantee: WHIZ.id,
          dataOwner: 'https://yoyo.example/roles/biz',
        }),
      ],
      resource,
      YOYO_WEBID,
      [
        WHIZ,
        {
          id: 'https://yoyo.example/roles/biz',
          type: [INTEROP.Role],
          label: { '@none': 'Biz' },
          members: [YOYO_WEBID],
        },
      ]
    )
    expect(member.roles.map(({ role }) => role)).toEqual([WHIZ.id])
  })
})
// ──────────────────────────
// /sparql-admin transport (org-context registry plane)
// ──────────────────────────

const SPARQL_ADMIN_URL = `${new URL(YOYO_AA).origin}/.sai/sparql-admin/${Buffer.from(YOYO_WEBID).toString('base64url')}`

/** Mock org server answering the admin-session fetch: profile + sparql-admin QUERY. */
function sparqlAdminSession(respond: (req: { url: string; init?: RequestInit }) => Response): {
  session: AuthorizationAgent
  requests: Array<{ url: string; init?: RequestInit }>
} {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const session = fakeSession(async (url, init) => {
    requests.push({ url, init })
    if (url === YOYO_WEBID) {
      return jsonResponse(yoyoProfileDoc)
    }
    return respond({ url, init })
  })
  return { session, requests }
}

describe('sparqlTransportFor — org context routes via /sparql-admin', () => {
  test('SELECT bindings: HTTP QUERY + application/sparql-query body, W3C results parsed', async () => {
    const { session, requests } = sparqlAdminSession(() =>
      jsonResponse(
        {
          head: { vars: ['child'] },
          results: {
            bindings: [
              { child: { type: 'uri', value: 'https://yoyo.example/registrations/1' } },
              { child: { type: 'uri', value: 'https://yoyo.example/registrations/2' } },
            ],
          },
        },
        200,
        'application/sparql-results+json'
      )
    )
    const ctx = fakeSessionCtx(session, YOYO_WEBID, DAN_WEBID)

    const children = await listContained(
      sparqlTransportFor(ctx),
      'https://yoyo.example/agent-registry/'
    )

    expect(children).toEqual([
      'https://yoyo.example/registrations/1',
      'https://yoyo.example/registrations/2',
    ])
    const sparqlRequest = requests.find((request) => request.url === SPARQL_ADMIN_URL)
    // QUERY: the safe, read-only method — DPoP-verifiable since the
    // access-token verifier added it to its REQUEST_METHOD whitelist (2.1.2).
    expect(sparqlRequest?.init?.method).toBe('QUERY')
    expect(
      (sparqlRequest?.init?.headers as Record<string, string> | undefined)?.['Content-Type'] ?? ''
    ).toContain('application/sparql-query')
    expect(typeof sparqlRequest?.init?.body).toBe('string')
  })

  test('literal/language terms are converted', async () => {
    const { session } = sparqlAdminSession(() =>
      jsonResponse(
        {
          head: { vars: ['label'] },
          results: {
            bindings: [
              {
                label: { type: 'literal', value: 'Peer', 'xml:lang': 'en' },
              },
            ],
          },
        },
        200,
        'application/sparql-results+json'
      )
    )
    const ctx = fakeSessionCtx(session, YOYO_WEBID, DAN_WEBID)
    const bindings = await sparqlTransportFor(ctx).fetchBindings('SELECT ?label WHERE {}')
    expect(bindings[0].label).toMatchObject({ termType: 'Literal', value: 'Peer', language: 'en' })
  })

  test('CONSTRUCT triples: JSON-LD parsed into a store, framed registration built', async () => {
    const { session } = sparqlAdminSession(() =>
      jsonResponse(
        [
          {
            '@id': 'https://yoyo.example/registrations/peer',
            '@type': ['http://www.w3.org/ns/solid/interop#SocialAgentRegistration'],
            'http://www.w3.org/ns/solid/interop#registeredAgent': [
              { '@id': 'https://peer.example/profile/card#me' },
            ],
            'http://www.w3.org/2004/02/skos/core#prefLabel': [{ '@value': 'Peer' }],
          },
        ],
        200,
        'application/ld+json'
      )
    )
    const ctx = fakeSessionCtx(session, YOYO_WEBID, DAN_WEBID)

    const registration = await getSocialAgentRegistration(
      sparqlTransportFor(ctx),
      'https://yoyo.example/registrations/peer'
    )
    expect(registration.registeredAgent).toBe('https://peer.example/profile/card#me')
    expect(registration.label).toEqual({ '@none': 'Peer' })
  })

  test('non-ok sparql-admin response surfaces as an error with the status', async () => {
    const { session } = sparqlAdminSession(() => jsonResponse({ error: 'no' }, 403, 'text/plain'))
    const ctx = fakeSessionCtx(session, YOYO_WEBID, DAN_WEBID)
    await expect(sparqlTransportFor(ctx).fetchBindings('SELECT ?s WHERE {}')).rejects.toThrow(
      'sparql-admin 403'
    )
  })
})
