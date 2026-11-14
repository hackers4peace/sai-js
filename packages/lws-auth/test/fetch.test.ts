import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { beforeAll, describe, expect, test } from 'vitest'

import type { LwsCredential } from '../src/credential.ts'
import { createLwsAuthFetch } from '../src/fetch.ts'
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
      if (server(url) === UAS) return undefined
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
        if (!storage) return undefined
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
  test('uses one ID-JAG per authorization server for several storages', async () => {
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
    expect(grantRequests).toHaveLength(1)
    expect(formBody(grantRequests[0]).get('audience')).toBe(DATA)

    const resources = world.requests
      .filter(isStorageTokenRequest)
      .map((request) => formBody(request).get('resource'))
    expect(resources).toEqual([DATA_STORAGE, DATA_STORAGE_2])
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
      if (authorization) expect(authorization).toMatch(/^Bearer access-/u)
    }
  })
})
