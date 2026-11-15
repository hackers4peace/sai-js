import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type {
  DataAuthorizationData,
  DataInstanceData,
  GrantData,
  RoleData,
} from '@janeirodigital/interop-data-model'
import { grantAccess } from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP, LWS, ODRL } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import type { ResolvedContext } from '../src/services/Context.js'
import { PeerFetchError, fetchPeerResource } from '../src/services/peerFetch.js'
import {
  PeerProxyError,
  dataRegistrationContains,
  fetchPeerDocument,
  peerInstanceIris,
} from '../src/services/peerProxy.js'
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
const PEER_REGISTRATION = 'https://peer.example/data/registrations/abc/'
const PEER_INSTANCE = 'https://peer.example/data/abc/123'

/** Static JSON-LD doc for the peer data registration (absolute-IRI keys, no context). */
const peerRegistrationDoc = {
  '@id': PEER_REGISTRATION,
  'http://www.w3.org/ns/solid/interop#registeredShapeTree': {
    '@id': 'https://shapetrees.example/Project',
  },
  'http://www.w3.org/ns/ldp#contains': [{ '@id': PEER_INSTANCE }],
}

/** WebID profile doc with `interop:hasAuthorizationAgent` as a full-IRI key. */
const yoyoProfileDoc = {
  '@id': YOYO_WEBID,
  'http://www.w3.org/ns/solid/interop#hasAuthorizationAgent': { '@id': YOYO_AA },
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

/** Fake session: a WhatwgFetch that records requests and answers by URL. */
function fakeSession(
  onRequest: (url: string, init?: RequestInit) => Promise<Response>
): AuthorizationAgent {
  return { fetch: onRequest as AuthorizationAgent['fetch'] } as unknown as AuthorizationAgent
}

/** Minimal ResolvedContext for the data-plane helpers. */
function fakeCtx(session: AuthorizationAgent, webId: string, userWebId: string): ResolvedContext {
  return { session, webId, userWebId } as unknown as ResolvedContext
}

const proxyAdminUrl = (orgWebId: string, targetIri: string): string =>
  `${new URL(YOYO_AA).origin}/.sai/proxy-admin/${Buffer.from(orgWebId).toString('base64url')}` +
  `?iri=${encodeURIComponent(targetIri)}`

/** Session answering: WebID profile → YOYO_AA; proxy-admin request → peer doc (or dispatch). */
function happySession(overrides?: {
  proxyAdmin?: (url: string, init?: RequestInit) => Promise<Response>
}): { session: AuthorizationAgent; requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = []
  const session = fakeSession(async (url, init) => {
    requests.push({ url, init })
    if (url === YOYO_WEBID) return jsonResponse(yoyoProfileDoc)
    return (overrides?.proxyAdmin ?? (() => jsonResponse(peerRegistrationDoc)))(url, init)
  })
  return { session, requests }
}

// ──────────────────────────
// fetchPeerResource (YoYo-side upstream)
// ──────────────────────────

describe('fetchPeerResource', () => {
  test('fetches the target with the org session and returns the JSON-LD document', async () => {
    let seenInit: RequestInit | undefined
    const session = fakeSession(async (_url, init) => {
      seenInit = init
      return jsonResponse(peerRegistrationDoc)
    })
    const doc = await fetchPeerResource(session, PEER_REGISTRATION)
    // the LWS profile is the preferred Accept; `fetchJsonLd` falls back for
    // servers that do not support it, and re-reads an LWS page listing as RDF
    expect(String((seenInit?.headers as Record<string, string>)?.Accept)).toContain(
      'application/ld+json'
    )
    expect(doc).toEqual(peerRegistrationDoc)
  })

  test('surfaces the upstream status as HttpStatusError', async () => {
    const session = fakeSession(async () => jsonResponse({}, 403))
    await expect(fetchPeerResource(session, PEER_REGISTRATION)).rejects.toMatchObject({
      name: 'HttpStatusError',
      status: 403,
    })
  })

  test('rejects non-http(s) and relative targets before any fetch', async () => {
    let fetched = false
    const session = fakeSession(async () => {
      fetched = true
      return jsonResponse(peerRegistrationDoc)
    })
    for (const target of ['relative/path', 'file:///tmp/x.ldjson', 'ftp://peer.example/x', '']) {
      await expect(fetchPeerResource(session, target)).rejects.toBeInstanceOf(PeerFetchError)
    }
    expect(fetched).toBe(false)
  })
})

// ──────────────────────────
// fetchPeerDocument (Dan-side client)
// ──────────────────────────

describe('fetchPeerDocument', () => {
  test('discovers the org AA, builds the proxy-admin URL and returns the parsed JSON-LD', async () => {
    const { session, requests } = happySession()
    const doc = await fetchPeerDocument(session, YOYO_WEBID, PEER_REGISTRATION)

    expect(doc).toEqual(peerRegistrationDoc)

    const [profileRequest, proxyRequest] = requests
    expect(profileRequest.url).toBe(YOYO_WEBID)
    expect(proxyRequest.url).toBe(proxyAdminUrl(YOYO_WEBID, PEER_REGISTRATION))
    expect((proxyRequest.init?.headers as Record<string, string> | undefined)?.Accept).toBe(
      'application/ld+json'
    )
  })

  test('URL-encodes the target IRI (ampersands, existing queries)', async () => {
    const quirky = 'https://peer.example/data/abc?a=1&b=two#frag'
    const { session, requests } = happySession()
    await fetchPeerDocument(session, YOYO_WEBID, quirky)
    expect(requests[1].url).toBe(proxyAdminUrl(YOYO_WEBID, quirky))
    // the href passed to fetchPeerResource must survive the round-trip
    const encoded = new URL(proxyAdminUrl(YOYO_WEBID, quirky)).searchParams.get('iri')
    expect(encoded).toBe(quirky)
  })

  test('surfaces the upstream status as PeerProxyError', async () => {
    const { session } = happySession({
      proxyAdmin: () => jsonResponse({ error: 'forbidden' }, 403, 'text/plain'),
    })
    await expect(fetchPeerDocument(session, YOYO_WEBID, PEER_REGISTRATION)).rejects.toMatchObject({
      message: expect.stringContaining(`upstream 403 for ${PEER_REGISTRATION}`),
      status: 403,
    })
    await expect(fetchPeerDocument(session, YOYO_WEBID, PEER_REGISTRATION)).rejects.toBeInstanceOf(
      PeerProxyError
    )
  })

  test('indistinguishable failure when the org AA cannot be discovered', async () => {
    const session = fakeSession(async () => {
      throw new Error('network failure')
    })
    await expect(fetchPeerDocument(session, YOYO_WEBID, PEER_REGISTRATION)).rejects.toThrow(
      `cannot discover authorization agent for ${YOYO_WEBID}`
    )
    await expect(fetchPeerDocument(session, YOYO_WEBID, PEER_REGISTRATION)).rejects.toBeInstanceOf(
      PeerProxyError
    )
  })
})

// ──────────────────────────
// dataRegistrationContains
// ──────────────────────────

describe('dataRegistrationContains', () => {
  test('org context — fetches the peer registration through /proxy-admin and parses `contains`', async () => {
    const { session, requests } = happySession()
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)

    const contains = await dataRegistrationContains(ctx, PEER_REGISTRATION)
    expect(contains).toEqual([PEER_INSTANCE])
    expect(requests[1].url).toBe(proxyAdminUrl(YOYO_WEBID, PEER_REGISTRATION))
  })

  test('personal context — derefs directly with the session fetch, no proxy call', async () => {
    // only a `fetch` on the session (no proxy dispatch): if the personal
    // branch tried to proxy, this would fail on the unexpected URL
    const session = {
      fetch: async () => jsonResponse(peerRegistrationDoc),
    } as unknown as AuthorizationAgent
    const ctx = fakeCtx(session, DAN_WEBID, DAN_WEBID)

    await expect(dataRegistrationContains(ctx, PEER_REGISTRATION)).resolves.toEqual([PEER_INSTANCE])
  })

  test('org context — propagates the upstream status', async () => {
    const { session } = happySession({
      proxyAdmin: () => jsonResponse({ error: 'forbidden' }, 403, 'text/plain'),
    })
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)
    await expect(dataRegistrationContains(ctx, PEER_REGISTRATION)).rejects.toMatchObject({
      status: 403,
    })
  })
})

// ──────────────────────────
// peerInstanceIris
// ──────────────────────────

const grantData = (scopeOfGrant: string, extra: Partial<GrantData> = {}): GrantData => {
  const storage = 'https://peer.example/data/'
  const registeredShapeTree = extra.registeredShapeTree ?? 'https://shapetrees.example/Child'
  const hasDataInstance = extra.hasDataInstance ?? []
  return {
    id: 'https://peer.example/grants/1',
    type: [LWS.AccessGrant],
    storage,
    access: grantAccess({
      scopeOfGrant,
      storage,
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

/** Fetch dispatcher keyed on the *decoded proxy target* (plus the profile). */
function proxyDispatcher(byIri: Record<string, unknown>) {
  return fakeSession(async (url) => {
    if (url === YOYO_WEBID) return jsonResponse(yoyoProfileDoc)
    const target = new URL(url).searchParams.get('iri')
    const doc = target && byIri[target]
    if (!doc) throw new Error(`unexpected proxy fetch for ${target ?? url}`)
    return jsonResponse(doc)
  })
}

const collect = async (iter: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const iri of iter) out.push(iri)
  return out
}

describe('peerInstanceIris', () => {
  test('AllFromRegistry — `contains` of the peer registration via /proxy-admin', async () => {
    const session = proxyDispatcher({ [PEER_REGISTRATION]: peerRegistrationDoc })
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)
    const iris = await collect(peerInstanceIris(ctx, grantData(INTEROP.AllFromRegistry)))
    expect(iris).toEqual([PEER_INSTANCE])
  })

  test('SelectedFromRegistry — instance list from grant metadata, no fetch', async () => {
    const session = fakeSession(async () => {
      throw new Error('no fetch expected for SelectedFromRegistry')
    })
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)
    const iris = await collect(
      peerInstanceIris(
        ctx,
        grantData(INTEROP.SelectedFromRegistry, {
          hasDataInstance: ['https://peer.example/data/a', 'https://peer.example/data/b'],
        })
      )
    )
    expect(iris).toHaveLength(2)
    expect(iris).toEqual(
      expect.arrayContaining(['https://peer.example/data/a', 'https://peer.example/data/b'])
    )
  })

  test('Inherited — parent grant, parent `contains`, and parent content via /proxy-admin', async () => {
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
          [INTEROP.registeredShapeTree]: [{ '@id': parentShapeTreeIri }],
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
                  [INTEROP.dataOwner]: [{ '@id': 'https://peer.example/profile/card#me' }],
                  [LWS.storage]: [{ '@id': 'https://peer.example/data/' }],
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
    // public shape tree — resolved with the (admin) session over the proxy
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
    const byIri: Record<string, unknown> = {
      [parentGrantIri]: parentGrantDoc,
      [parentRegistrationIri]: parentRegistrationDoc,
      [parentInstanceIri]: parentInstanceDoc,
      [parentShapeTreeIri]: parentShapeTreeDoc,
    }
    const { fetch: proxyFetch } = proxyDispatcher(byIri)
    const session = {
      // shape trees are public and fetched directly (no proxy); everything
      // else (peer grants/registrations/instances) goes via /proxy-admin
      fetch: async (url: string, init?: RequestInit) => {
        if (url === YOYO_WEBID) return jsonResponse(yoyoProfileDoc)
        const target = new URL(url).searchParams.get('iri')
        if (target) return proxyFetch(url, init)
        if (byIri[url]) return jsonResponse(byIri[url])
        throw new Error(`unexpected direct request: ${url}`)
      },
    } as unknown as AuthorizationAgent
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)

    const iris = await collect(
      peerInstanceIris(ctx, grantData(INTEROP.Inherited, { inheritsFromGrant: parentGrantIri }))
    )
    expect(iris).toEqual([childInstanceIri])
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
  requests: { url: string; init?: RequestInit }[]
} {
  const requests: { url: string; init?: RequestInit }[] = []
  const session = fakeSession(async (url, init) => {
    requests.push({ url, init })
    if (url === YOYO_WEBID) return jsonResponse(yoyoProfileDoc)
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
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)

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
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)
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
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)

    const registration = await getSocialAgentRegistration(
      sparqlTransportFor(ctx),
      'https://yoyo.example/registrations/peer'
    )
    expect(registration.registeredAgent).toBe('https://peer.example/profile/card#me')
    expect(registration.label).toEqual({ '@none': 'Peer' })
  })

  test('non-ok sparql-admin response surfaces as an error with the status', async () => {
    const { session } = sparqlAdminSession(() => jsonResponse({ error: 'no' }, 403, 'text/plain'))
    const ctx = fakeCtx(session, YOYO_WEBID, DAN_WEBID)
    await expect(sparqlTransportFor(ctx).fetchBindings('SELECT ?s WHERE {}')).rejects.toThrow(
      'sparql-admin 403'
    )
  })
})
