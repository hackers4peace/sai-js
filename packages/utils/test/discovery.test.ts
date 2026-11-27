import { describe, expect, test, vi } from 'vitest'

import {
  AUXILIARY_DISCOVERY_ACCEPT,
  discoverAccessGrantService,
  discoverAccessRequestService,
  discoverAccessResource,
  discoverAuthorizationAgent,
  discoverAuthorizationRedirectEndpoint,
  discoverDescriptionResource,
  descriptionHasStorageType,
  descriptionStorageTypes,
  discoverWebPushService,
  lwsStorageRoot,
  requireLwsStorageRoot,
  upContainer,
} from '../src'
import type { WhatwgFetch } from '../src'

const aliceId = 'https://id/alice'
const aliceAgentId = 'https://auth/.sai/agents/aHR0cHM6Ly9pZC9hbGljZQ'
const INTEROP = 'http://www.w3.org/ns/solid/interop#'
const NOTIFY = 'http://www.w3.org/ns/solid/notifications#'
const LWS = 'https://www.w3.org/ns/lws#'
const accessRequests = `https://auth/.sai/access-requests/${Buffer.from(aliceId).toString('base64url')}`
const accessGrants = `https://auth/.sai/grants/${Buffer.from(aliceId).toString('base64url')}`

const webIdDoc = [
  {
    '@id': aliceId,
    [`${INTEROP}hasAuthorizationAgent`]: [{ '@id': aliceAgentId }],
  },
]

const uasDoc = [
  {
    '@id': aliceAgentId,
    [`${INTEROP}hasAuthorizationRedirectEndpoint`]: [{ '@id': 'https://ui.auth/authorize' }],
    [`${INTEROP}pushService`]: [{ '@id': 'https://auth/.sai/webpush' }],
    [`${NOTIFY}vapidPublicKey`]: [
      {
        '@value':
          'BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY',
      },
    ],
  },
]

/** Mock WhatwgFetch serving JSON-LD docs by URL (vi.fn so call counts are assertable). */
function jsonldFetch(docs: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.url
    return {
      ok: true,
      url,
      json: async () => docs[url],
    } as unknown as Response
  })
}

describe('discoverAuthorizationAgent', () => {
  test('discovers the Authorization Agent from the WebID document', async () => {
    const mock = jsonldFetch({ [aliceId]: webIdDoc })
    const iri = await discoverAuthorizationAgent(aliceId, mock)
    expect(iri).toBe(aliceAgentId)
  })

  test('returns undefined when the WebID document has no Authorization Agent', async () => {
    const mock = jsonldFetch({ [aliceId]: [{ '@id': aliceId }] })
    const iri = await discoverAuthorizationAgent(aliceId, mock)
    expect(iri).toBeUndefined()
  })
})

const cidDoc = {
  '@context': 'https://www.w3.org/ns/cid/v1',
  id: aliceId,
  service: [
    {
      type: `${INTEROP}AuthorizationAgent`,
      serviceEndpoint: aliceAgentId,
    },
    {
      type: `${LWS}AccessRequestService`,
      serviceEndpoint: accessRequests,
    },
    {
      type: `${LWS}AccessGrantService`,
      serviceEndpoint: accessGrants,
    },
  ],
}

function cidFetch(doc: unknown = cidDoc) {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.url
    return { ok: true, url, json: async () => doc } as unknown as Response
  })
}

describe('discoverAccessRequestService / discoverAccessGrantService', () => {
  test('discovers both owner services from the WebID CID document', async () => {
    const mock = cidFetch()
    expect(await discoverAccessRequestService(aliceId, mock)).toBe(accessRequests)
    expect(await discoverAccessGrantService(aliceId, mock)).toBe(accessGrants)
  })

  test('returns undefined when the service is absent', async () => {
    const mock = cidFetch({ '@context': 'https://www.w3.org/ns/cid/v1', id: aliceId, service: [] })
    expect(await discoverAccessRequestService(aliceId, mock)).toBeUndefined()
    expect(await discoverAccessGrantService(aliceId, mock)).toBeUndefined()
  })
})

describe('discoverAuthorizationRedirectEndpoint', () => {
  test('discovers the authorization uri from the Authorization Agent document', async () => {
    const mock = jsonldFetch({ [aliceAgentId]: uasDoc })
    const iri = await discoverAuthorizationRedirectEndpoint(aliceAgentId, mock)
    expect(iri).toBe('https://ui.auth/authorize')
  })
})

describe('discoverWebPushService', () => {
  test('discovers the web push service from the Authorization Agent document', async () => {
    const mock = jsonldFetch({ [aliceAgentId]: uasDoc })
    const service = await discoverWebPushService(aliceAgentId, mock)
    expect(service).toEqual({
      id: 'https://auth/.sai/webpush',
      vapidPublicKey:
        'BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY',
    })
  })

  test('returns undefined when the service is not found', async () => {
    const mock = jsonldFetch({ [aliceAgentId]: [{ '@id': aliceAgentId }] })
    const service = await discoverWebPushService(aliceAgentId, mock)
    expect(service).toBeUndefined()
  })
})

describe('lwsStorageRoot / requireLwsStorageRoot', () => {
  const storage = 'https://home.alice.example/'

  function lwsFetch(): WhatwgFetch {
    return vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'Link' ? `<${storage}>; rel="https://www.w3.org/ns/lws#storage"` : undefined,
          },
        } as unknown as Response
      }
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === 'Content-Type' ? 'application/lws+cid' : undefined),
        },
        json: async () => ({
          id: storage,
          type: 'Storage',
          service: [{ type: 'StorageRoot', serviceEndpoint: storage }],
        }),
      } as unknown as Response
    }) as unknown as WhatwgFetch
  }

  test('resolves the storage root through the LWS storage description', async () => {
    expect(await lwsStorageRoot('https://home.alice.example/registry/', lwsFetch())).toBe(storage)
    expect(await requireLwsStorageRoot('https://home.alice.example/registry/', lwsFetch())).toBe(
      storage
    )
  })

  test('a Solid-only server has no storage root any more (the fallback is gone)', async () => {
    const storageDescriptionIri = 'https://fake.example/storage-desription'
    const solidOnly = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'Link'
                ? `<${storageDescriptionIri}>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`
                : undefined,
          },
        } as unknown as Response
      }
      return {
        ok: true,
        json: async () => [
          { '@id': storageDescriptionIri, '@type': ['http://www.w3.org/ns/pim/space#Storage'] },
        ],
      } as unknown as Response
    }) as unknown as WhatwgFetch

    expect(await lwsStorageRoot('https://home.alice.example/registry/', solidOnly)).toBeUndefined()
    await expect(
      requireLwsStorageRoot('https://home.alice.example/registry/', solidOnly)
    ).rejects.toThrow(/cannot discover the LWS storage root/)
  })
})

describe('discoverAccessResource', () => {
  const root = 'https://registry.example/alice/'

  function headFetch(link: string) {
    return vi.fn(
      async () => ({ ok: true, headers: new Headers({ link }) }) as unknown as Response
    ) as unknown as WhatwgFetch
  }

  test('sends an explicit RDF Accept so a storage root is not described', async () => {
    const fetch = headFetch(`<${root}.acr>; rel="acl"`)
    const acr = await discoverAccessResource(root, fetch)
    expect(acr).toBe(`${root}.acr`)
    // a wildcard (or absent) Accept makes a storage root answer with the LWS
    // storage description, which carries no auxiliary links
    expect(fetch).toHaveBeenCalledWith(root, {
      method: 'HEAD',
      headers: { Accept: AUXILIARY_DISCOVERY_ACCEPT },
    })
  })

  test('returns undefined when the response has no acl link', async () => {
    const fetch = headFetch(`<${root}>; rel="https://www.w3.org/ns/lws#storage"`)
    expect(await discoverAccessResource(root, fetch)).toBeUndefined()
  })
})

describe('discoverDescriptionResource', () => {
  test('sends the same explicit Accept', async () => {
    const iri = 'https://registry.example/alice/social-agent/x/'
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          headers: new Headers({ link: `<${iri}.meta>; rel="describedby"` }),
        }) as unknown as Response
    ) as unknown as WhatwgFetch
    expect(await discoverDescriptionResource(iri, fetch)).toBe(`${iri}.meta`)
    expect(fetch).toHaveBeenCalledWith(iri, {
      method: 'HEAD',
      headers: { Accept: AUXILIARY_DISCOVERY_ACCEPT },
    })
  })
})

describe('upContainer', () => {
  test('reads the `up` link relation from a HEAD response (LWS §Containment)', async () => {
    const instance = 'https://data/yoyo-na/q7p2lm'
    const parent = 'https://data/yoyo-na/k9m4wx'
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          headers: new Headers({
            link: `<${parent}>; rel="up", <https://data/yoyo-na/>; rel="https://www.w3.org/ns/lws#storage"`,
          }),
        }) as unknown as Response
    ) as unknown as WhatwgFetch

    expect(await upContainer(instance, fetch)).toBe(parent)
    // a wildcard-capable Accept keeps blob instances discoverable too
    expect(fetch).toHaveBeenCalledWith(instance, {
      method: 'HEAD',
      headers: { Accept: AUXILIARY_DISCOVERY_ACCEPT },
    })
  })

  test('resolves a relative `up` reference against the request IRI', async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          headers: new Headers({ link: '<k9m4wx>; rel="up"' }),
        }) as unknown as Response
    ) as unknown as WhatwgFetch
    expect(await upContainer('https://data/yoyo-na/q7p2lm', fetch)).toBe(
      'https://data/yoyo-na/k9m4wx'
    )
  })

  test('undefined for a storage root (no `up`) or a failed HEAD — never a throw', async () => {
    const root = vi.fn(
      async () =>
        ({
          ok: true,
          headers: new Headers({
            link: '<https://data/yoyo-na/>; rel="https://www.w3.org/ns/lws#storage"',
          }),
        }) as unknown as Response
    ) as unknown as WhatwgFetch
    expect(await upContainer('https://data/yoyo-na/', root)).toBeUndefined()

    const denied = vi.fn(
      async () => ({ ok: false, status: 403, headers: new Headers() }) as unknown as Response
    ) as unknown as WhatwgFetch
    expect(await upContainer('https://data/yoyo-na/q7p2lm', denied)).toBeUndefined()
  })
})

describe('storage description types', () => {
  const registry = 'https://www.w3.org/ns/solid/sai#RegistryStorage'
  const description = {
    '@context': ['https://www.w3.org/ns/lws/v1', 'https://www.w3.org/ns/solid/interop-context/v1'],
    id: 'https://registry/alice/',
    type: ['Storage', 'RegistryStorage'],
  }

  test('reads compact aliases and expanded type IRIs', () => {
    expect(descriptionStorageTypes(description)).toEqual(['Storage', 'RegistryStorage'])
    expect(descriptionHasStorageType(description, registry)).toBe(true)
    expect(descriptionHasStorageType(description, 'DataStorage')).toBe(false)
  })

  test('accepts an expanded description type', () => {
    expect(
      descriptionHasStorageType({ ...description, type: ['Storage', registry] }, registry)
    ).toBe(true)
  })
})
