import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { beforeAll, describe, expect, test } from 'vitest'

import type { LwsCredential } from '../src/credential.ts'
import { createIdJagFetch, createLwsAuthFetch } from '../src/fetch.ts'
import { ACCESS_TOKEN_TYPE, ID_JAG_TOKEN_TYPE } from '../src/tokens.ts'
import { createFakeFetch, formBody, json, makeJwt } from './helpers.ts'

const UAS = 'https://auth/'
const UAS_TOKEN = 'https://auth/.well-known/lws/token'
const DATA = 'https://data/'
const DATA_STORAGE = 'https://data/alice-work/'
const DATA_STORAGE_2 = 'https://data/yoyo-eu/'
const REGISTRY = 'https://registry/'
const REGISTRY_STORAGE = 'https://registry/alice/'
const CLIENT = 'https://data/test-client/public/id'
const WEBID = 'https://id/alice'
const STORAGES = [DATA_STORAGE, DATA_STORAGE_2, REGISTRY_STORAGE]

let keyPair: CryptoKeyPair

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
})

interface World {
  fetch: WhatwgFetch
  requests: ReturnType<typeof createFakeFetch>['requests']
  /** The ID-JAGs the UAS minted, in order. */
  grants: string[]
  clock(): number
}

/**
 * A tiny LWS world: one UAS that mints ID-JAGs, and two storages that are their
 * own authorization servers (plus their protected resources).
 */
function createWorld(options: { grantLifetime?: number } = {}): World {
  const grantLifetime = options.grantLifetime ?? 300
  let clock = Date.UTC(2026, 10, 14, 12, 0, 0)
  const grants: string[] = []

  const server = (url: URL): string => `https://${url.host}/`
  const storageOf = (href: string): string | undefined =>
    STORAGES.find((storage) => href.startsWith(storage))

  const { fetch, requests } = createFakeFetch((url, request): Response | undefined => {
    const href = url.href

    // UAS token endpoint (the UAS deliberately advertises no LWS metadata)
    if (href === UAS_TOKEN && request.method === 'POST') {
      const grant = makeJwt({
        iss: UAS,
        aud: formBody(request).get('audience') ?? '',
        sub: WEBID,
        client_id: CLIENT,
        exp: Math.floor(clock / 1000) + grantLifetime,
      })
      grants.push(grant)
      return json({
        issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        access_token: grant,
        token_type: 'N_A',
        expires_in: grantLifetime,
      })
    }

    // protected resource metadata (RFC 9728) — served under the pod path
    if (url.pathname.includes('/.well-known/oauth-protected-resource/')) {
      return json({ resource: href, authorization_servers: [server(url)] })
    }

    // authorization server metadata
    if (url.pathname === '/.well-known/lws-configuration') {
      if (server(url) === UAS) {
        return undefined
      }
      return json({
        issuer: server(url),
        token_endpoint: `${server(url)}.well-known/lws/token`,
        jwks_uri: `${server(url)}.well-known/lws/jwks`,
      })
    }

    // storage token endpoints
    if (url.pathname === '/.well-known/lws/token' && request.method === 'POST') {
      const resource = formBody(request).get('resource') ?? ''
      return json({ access_token: `access-${resource}`, token_type: 'Bearer', expires_in: 300 })
    }

    // the protected resources: anything outside `.well-known`
    if (!url.pathname.includes('/.well-known/')) {
      const authorization = request.headers.get('authorization') ?? ''
      if (!authorization.startsWith('Bearer access-')) {
        const storage = storageOf(href)
        if (!storage) {
          return undefined
        }
        return new Response(undefined, {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${storage}.well-known/oauth-protected-resource/x", as_uri="${storage}", realm="${storage}"`,
          },
        })
      }
      return new Response('<urn:foo:bar> <urn:foo:baz> "Beep Boop".', {
        status: 200,
        headers: { 'content-type': 'text/turtle' },
      })
    }
  })

  return { fetch, requests, grants, clock: () => clock }
}

function createCredential(): LwsCredential {
  return {
    issuer: UAS,
    clientId: CLIENT,
    dpopKeyPair: keyPair,
    getSubjectToken: async () =>
      makeJwt({ iss: UAS, aud: 'solid', sub: WEBID, exp: Math.floor(Date.now() / 1000) + 60 }),
  }
}

const isGrantRequest = (request: { url: string }): boolean => request.url === UAS_TOKEN

const isStorageTokenRequest = (request: { url: string }): boolean =>
  request.url.endsWith('/.well-known/lws/token') && request.url !== UAS_TOKEN

const isStorageRequest = (request: { url: string; method: string }): boolean =>
  request.method === 'GET' && !request.url.includes('/.well-known/')

describe('createLwsAuthFetch', () => {
  test('asks the UAS for a storage-specific grant for each storage', async () => {
    const world = createWorld()
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
    })

    const first = await fetch(`${DATA_STORAGE}k3pqsb`, { headers: { accept: 'text/turtle' } })
    const second = await fetch(`${DATA_STORAGE_2}x8v2lm`, { headers: { accept: 'text/turtle' } })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const grantRequests = world.requests.filter(isGrantRequest)
    expect(grantRequests).toHaveLength(2)
    expect(grantRequests.map((request) => formBody(request).get('audience'))).toEqual([DATA, DATA])
    expect(grantRequests.map((request) => formBody(request).get('resource'))).toEqual([
      DATA_STORAGE,
      DATA_STORAGE_2,
    ])

    const resources = world.requests
      .filter(isStorageTokenRequest)
      .map((request) => formBody(request).get('resource'))
    expect(resources).toEqual([DATA_STORAGE, DATA_STORAGE_2])
  })

  test('keys access-claim grants by authorization server and storage', async () => {
    const world = createWorld()
    const claims: unknown[] = []
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
      accessClaim: (storage) => {
        const claim = [{ id: `urn:claim:${storage}`, target: { storage } }]
        claims.push(claim)
        return claim
      },
    })

    expect((await fetch(`${DATA_STORAGE}k3pqsb`)).status).toBe(200)
    expect((await fetch(`${DATA_STORAGE_2}x8v2lm`)).status).toBe(200)

    const grantRequests = world.requests.filter(isGrantRequest)
    expect(grantRequests).toHaveLength(2)
    expect(grantRequests.map((request) => formBody(request).get('audience'))).toEqual([DATA, DATA])
    expect(grantRequests.map((request) => JSON.parse(formBody(request).get('access')!))).toEqual(
      claims
    )
  })

  test('walks the C2 impersonation hop before the storage exchange', async () => {
    const world = createWorld()
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
      impersonation: { uas: UAS },
      accessClaim: (storage) => [{ id: `urn:claim:${storage}`, target: { storage } }],
    })

    expect((await fetch(`${DATA_STORAGE}k3pqsb`)).status).toBe(200)

    const grantRequests = world.requests.filter(isGrantRequest)
    expect(grantRequests).toHaveLength(2)
    const [first, second] = grantRequests.map(formBody)
    expect(first.get('audience')).toBe(UAS)
    expect(first.get('resource')).toBe(DATA_STORAGE)
    expect(first.get('subject_token_type')).toBe(ACCESS_TOKEN_TYPE)
    expect(second.get('audience')).toBe(DATA)
    expect(second.get('resource')).toBe(DATA_STORAGE)
    expect(second.get('subject_token_type')).toBe(ID_JAG_TOKEN_TYPE)
    expect(second.get('subject_token')).toBe(world.grants[0])
    expect(second.get('access')).toBeNull()
  })

  test('mints a separate grant per storage authorization server', async () => {
    const world = createWorld()
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
    })

    expect((await fetch(`${DATA_STORAGE}k3pqsb`)).status).toBe(200)
    expect((await fetch(REGISTRY_STORAGE)).status).toBe(200)

    const audiences = world.requests
      .filter(isGrantRequest)
      .map((request) => formBody(request).get('audience'))
    expect(audiences).toEqual([DATA, REGISTRY])
  })

  test('caches the access token per storage', async () => {
    const world = createWorld()
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
    })

    await fetch(`${DATA_STORAGE}k3pqsb`)
    const seen = world.requests.length
    await fetch(`${DATA_STORAGE}k3pqsb`)

    // only the resource request itself: no new grant, no new token exchange
    expect(world.requests.slice(seen).filter(isStorageRequest)).toHaveLength(1)
    expect(world.requests.slice(seen).filter((request) => !isStorageRequest(request))).toHaveLength(
      0
    )
    expect(world.requests.filter(isStorageTokenRequest)).toHaveLength(1)
  })

  test('re-mints an ID-JAG that is about to expire', async () => {
    const world = createWorld({ grantLifetime: 10 })
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
    })

    await fetch(`${DATA_STORAGE}k3pqsb`)
    await fetch(`${DATA_STORAGE_2}x8v2lm`)

    expect(world.requests.filter(isGrantRequest)).toHaveLength(2)
  })

  test('treats a storage invalid_grant as no token and retries without Authorization', async () => {
    let resourceRequests = 0
    const { fetch, requests } = createFakeFetch((url, request): Response | undefined => {
      const href = url.href
      if (href === UAS_TOKEN && request.method === 'POST') {
        return json({
          issued_token_type: ID_JAG_TOKEN_TYPE,
          access_token: makeJwt({ iss: UAS, aud: DATA, sub: WEBID, client_id: CLIENT }),
          token_type: 'N_A',
          expires_in: 300,
        })
      }
      if (url.pathname === '/.well-known/lws-configuration') {
        if (href === `${UAS}.well-known/lws-configuration`) {
          return undefined
        }
        return json({
          issuer: `https://${url.host}/`,
          token_endpoint: `https://${url.host}/.well-known/lws/token`,
          jwks_uri: `https://${url.host}/.well-known/lws/jwks`,
        })
      }
      if (url.pathname === '/.well-known/lws/token' && request.method === 'POST') {
        return json({ error: 'invalid_grant', error_description: 'no token' }, 400)
      }
      if (href.startsWith(DATA_STORAGE)) {
        resourceRequests += 1
        if (resourceRequests === 1) {
          return new Response(undefined, {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${DATA_STORAGE}.well-known/oauth-protected-resource/x", as_uri="${DATA}", realm="${DATA_STORAGE}"`,
            },
          })
        }
        return new Response('<urn:public> <urn:ok> "yes".', {
          status: 200,
          headers: { 'content-type': 'text/turtle' },
        })
      }
    })
    const lwsFetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch,
      now: () => Date.now(),
    })

    const response = await lwsFetch(`${DATA_STORAGE}k3pqsb`)
    expect(response.status).toBe(200)
    const storageRequests = requests.filter((request) => request.url === `${DATA_STORAGE}k3pqsb`)
    expect(storageRequests).toHaveLength(2)
    expect(storageRequests[0].headers.get('authorization')).toBeNull()
    // the denied exchange is not retried; the fallback goes out tokenless
    expect(storageRequests[1].headers.get('authorization')).toBeNull()
  })

  test('never sends the ID-JAG to a storage', async () => {
    const world = createWorld()
    const fetch = createLwsAuthFetch({
      credential: createCredential(),
      fetch: world.fetch,
      now: () => world.clock(),
    })
    await fetch(`${DATA_STORAGE}k3pqsb`)

    expect(world.grants).toHaveLength(1)
    const storageRequests = world.requests.filter(isStorageRequest)
    expect(storageRequests.length).toBeGreaterThan(0)
    for (const request of storageRequests) {
      const headers = [...request.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
      expect(headers).not.toContain(world.grants[0])
      expect(request.body ?? '').not.toContain(world.grants[0])
      // the unauthenticated probe is allowed; the retry carries the access token
      const authorization = request.headers.get('authorization')
      if (authorization) {
        expect(authorization).toMatch(/^Bearer access-/u)
      }
    }
  })
})

describe('createIdJagFetch', () => {
  const AGENT = 'https://auth/.sai/agents/aHR0cHM6Ly9pZC9hbGljZQ'
  const ACCESS_REQUEST = 'https://auth/.sai/access-requests/aHR0cHM6Ly9pZC9hbGljZQ'

  function createSaiWorld(options: { staleFirst?: string } = {}) {
    let counter = 0
    const grants: string[] = []
    const world = createFakeFetch((url, request): Response | undefined => {
      if (url.href === UAS_TOKEN && request.method === 'POST') {
        const audience = formBody(request).get('audience') ?? ''
        counter += 1
        const grant = `id-jag-${counter}:${audience}`
        grants.push(grant)
        return json({
          issued_token_type: ID_JAG_TOKEN_TYPE,
          access_token: grant,
          token_type: 'N_A',
          expires_in: 300,
        })
      }
      if (url.pathname.startsWith('/.sai/')) {
        const authorization = request.headers.get('authorization') ?? ''
        if (options.staleFirst && authorization.includes(options.staleFirst)) {
          options.staleFirst = undefined
          return new Response(undefined, { status: 401 })
        }
        return new Response('ok', { status: 200 })
      }
    })
    return { ...world, grants }
  }

  test('mints one identity-only ID-JAG per resolved audience', async () => {
    const world = createSaiWorld()
    const fetch = createIdJagFetch({
      credential: createCredential(),
      audience: (url) =>
        new URL(url).pathname.startsWith('/.sai/agents/') ? 'https://auth/' : url,
      fetch: world.fetch,
    })

    expect((await fetch(AGENT)).status).toBe(200)
    expect((await fetch(ACCESS_REQUEST)).status).toBe(200)

    const grantRequests = world.requests.filter(isGrantRequest)
    expect(grantRequests.map((request) => formBody(request).get('audience'))).toEqual([
      'https://auth/',
      ACCESS_REQUEST,
    ])
    for (const request of grantRequests) {
      expect(formBody(request).get('resource')).toBeNull()
      expect(formBody(request).get('access')).toBeNull()
    }

    const saiRequests = world.requests.filter(
      (request) => request.url === AGENT || request.url === ACCESS_REQUEST
    )
    expect(saiRequests.map((request) => request.headers.get('authorization'))).toEqual([
      `Bearer ${world.grants[0]}`,
      `Bearer ${world.grants[1]}`,
    ])
  })

  test('caches the grant per audience until it expires', async () => {
    const world = createSaiWorld()
    const fetch = createIdJagFetch({
      credential: createCredential(),
      audience: (url) => url,
      fetch: world.fetch,
      now: () => Date.now(),
    })

    await fetch(ACCESS_REQUEST)
    await fetch(ACCESS_REQUEST)
    await fetch(AGENT)

    expect(
      world.requests.filter(isGrantRequest).map((request) => formBody(request).get('audience'))
    ).toEqual([ACCESS_REQUEST, AGENT])
  })

  test('mints a fresh grant and retries once on 401', async () => {
    const world = createSaiWorld({ staleFirst: 'id-jag-1:' })
    const fetch = createIdJagFetch({
      credential: createCredential(),
      audience: (url) => url,
      fetch: world.fetch,
    })

    const response = await fetch(ACCESS_REQUEST)
    expect(response.status).toBe(200)
    expect(world.grants).toHaveLength(2)
    expect(world.requests.filter(isGrantRequest)).toHaveLength(2)

    const saiRequests = world.requests.filter((request) => request.url === ACCESS_REQUEST)
    expect(saiRequests).toHaveLength(2)
    expect(saiRequests.map((request) => request.headers.get('authorization'))).toEqual([
      `Bearer ${world.grants[0]}`,
      `Bearer ${world.grants[1]}`,
    ])
  })

  test('uses the token fetch for the exchange and the base fetch for the grant', async () => {
    const world = createSaiWorld()
    const tokenFetch = createFakeFetch((url, request) => {
      if (url.href === UAS_TOKEN && request.method === 'POST') {
        return json({
          issued_token_type: ID_JAG_TOKEN_TYPE,
          access_token: 'id-jag-from-token-fetch',
          token_type: 'N_A',
          expires_in: 300,
        })
      }
    })
    const fetch = createIdJagFetch({
      credential: createCredential(),
      audience: (url) => url,
      fetch: world.fetch,
      tokenFetch: tokenFetch.fetch,
    })

    await fetch(ACCESS_REQUEST)
    expect(tokenFetch.requests.filter(isGrantRequest)).toHaveLength(1)
    expect(world.requests.filter(isGrantRequest)).toHaveLength(0)
    expect(world.grants).toHaveLength(0)
  })
})
