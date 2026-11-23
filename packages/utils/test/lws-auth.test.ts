import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createLwsFetch,
  discoverLwsAuthorizationServerMetadata,
  exchangeLwsAccessToken,
  parseLwsChallenge,
  requestLwsAccessToken,
} from '../src'

const STORAGE = 'https://bob.data.docker/'
const AS = 'https://data.docker/'
const TOKEN_ENDPOINT = 'https://data.docker/.well-known/lws/token'
const AS_METADATA = {
  issuer: AS,
  token_endpoint: TOKEN_ENDPOINT,
  jwks_uri: 'https://data.docker/.well-known/lws/jwks',
}
/** The normalized form of {@link AS_METADATA}. */
const AS_SERVER = {
  issuer: AS,
  tokenEndpoint: TOKEN_ENDPOINT,
  jwksUri: AS_METADATA.jwks_uri,
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return new Response(JSON.stringify(body), { status: 200, ...init, headers })
}

function unauthorized(challenge: string): Response {
  return new Response('{}', {
    status: 401,
    headers: { 'www-authenticate': challenge },
  })
}

const LWS_CHALLENGE =
  `Bearer resource_metadata="${AS}.well-known/oauth-protected-resource/bob.data.docker/", ` +
  `as_uri="${AS}", realm="${STORAGE}"`

describe('parseLwsChallenge', () => {
  test('parses the LWS Bearer challenge parameters', () => {
    expect(parseLwsChallenge(LWS_CHALLENGE)).toEqual({
      resourceMetadata: `${AS}.well-known/oauth-protected-resource/bob.data.docker/`,
      asUri: AS,
      realm: STORAGE,
    })
  })

  test('parses an earlier-draft challenge with only as_uri and realm', () => {
    expect(parseLwsChallenge(`Bearer as_uri="${AS}", realm="${STORAGE}"`)).toEqual({
      asUri: AS,
      realm: STORAGE,
    })
  })

  test('parses the error parameter', () => {
    expect(parseLwsChallenge(`Bearer realm="${STORAGE}", error="invalid_token"`)).toEqual({
      realm: STORAGE,
      error: 'invalid_token',
    })
  })

  test('ignores non-Bearer (Solid DPoP) challenges', () => {
    expect(parseLwsChallenge('DPoP realm="https://auth.example/"')).toBeUndefined()
  })

  test('returns undefined without a header', () => {
    expect(parseLwsChallenge(null)).toBeUndefined()
  })
})

describe('discoverLwsAuthorizationServerMetadata', () => {
  test('follows resource_metadata to the authorization server', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('.well-known/oauth-protected-resource/bob.data.docker/')) {
        return json({ resource: STORAGE, authorization_servers: [AS] })
      }
      if (url === `${AS}.well-known/lws-configuration`) {
        return json(AS_METADATA)
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const metadata = await discoverLwsAuthorizationServerMetadata(STORAGE, fetch, {
      resourceMetadata: `${AS}.well-known/oauth-protected-resource/bob.data.docker/`,
      realm: STORAGE,
    })
    expect(metadata).toEqual(AS_SERVER)
  })

  test('falls back to as_uri when there is no resource metadata', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${AS}.well-known/lws-configuration`) {
        return json(AS_METADATA)
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const metadata = await discoverLwsAuthorizationServerMetadata(STORAGE, fetch, { asUri: AS })
    expect(metadata.tokenEndpoint).toBe(TOKEN_ENDPOINT)
  })

  test('probes the storage origin when it is its own authorization server', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${STORAGE}.well-known/lws-configuration`) {
        return json({ ...AS_METADATA, issuer: STORAGE })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const metadata = await discoverLwsAuthorizationServerMetadata(STORAGE, fetch)
    expect(metadata.issuer).toBe(STORAGE)
  })

  test('fails when no authorization server can be discovered', async () => {
    const fetch = vi.fn(
      async () => new Response('', { status: 404 })
    ) as unknown as typeof globalThis.fetch
    await expect(discoverLwsAuthorizationServerMetadata(STORAGE, fetch)).rejects.toThrow(
      'cannot discover the LWS authorization server'
    )
  })
})

describe('exchangeLwsAccessToken', () => {
  test('posts the token exchange request and returns the access token', async () => {
    const fetch = vi.fn(async () =>
      json({ access_token: 'lws-token', expires_in: 300, token_type: 'Bearer' })
    ) as unknown as typeof globalThis.fetch
    const token = await exchangeLwsAccessToken({
      authorizationServer: AS_SERVER,
      resource: STORAGE,
      subjectToken: 'id-jag',
      fetch,
    })
    expect(token).toEqual({ accessToken: 'lws-token', expiresIn: 300 })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TOKEN_ENDPOINT)
    expect(init.method).toBe('POST')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id-jag')
    expect(body.get('subject_token')).toBe('id-jag')
    expect(body.get('resource')).toBe(STORAGE)
  })

  test('uses a bearer grant exchange without a DPoP proof', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'lws-token', expires_in: 300 }))
    await exchangeLwsAccessToken({
      authorizationServer: AS_SERVER,
      resource: STORAGE,
      subjectToken: 'id-jag',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })
  })

  test('throws with the OAuth error when the exchange is rejected', async () => {
    const fetch = vi.fn(async () =>
      json({ error: 'invalid_target' }, { status: 400 })
    ) as unknown as typeof globalThis.fetch
    await expect(
      exchangeLwsAccessToken({
        authorizationServer: AS_SERVER,
        resource: STORAGE,
        subjectToken: 'id-jag',
        fetch,
      })
    ).rejects.toThrow('invalid_target')
  })
})

/**
 * A storage server mock: the authorization server metadata on the AS origin,
 * the token endpoint issuing `lws-N`, and resource requests that accept only
 * `acceptToken`.
 */
function storageServer(options: { acceptToken?: string; expiresIn?: number } = {}) {
  let exchanges = 0
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.url
    const request = input as Request
    if (url === `${AS}.well-known/lws-configuration`) {
      return json(AS_METADATA)
    }
    if (url === TOKEN_ENDPOINT) {
      exchanges += 1
      return json({ access_token: `lws-${exchanges}`, expires_in: options.expiresIn ?? 300 })
    }
    if (
      options.acceptToken &&
      request.headers.get('authorization') === `Bearer ${options.acceptToken}`
    ) {
      return json({ id: url })
    }
    return unauthorized(LWS_CHALLENGE)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, exchanges: () => exchanges }
}

describe('requestLwsAccessToken', () => {
  test('probes the storage challenge, discovers the AS and exchanges the token', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === STORAGE && init?.method === 'HEAD') {
        return new Response(null, {
          status: 401,
          headers: { 'www-authenticate': `Bearer as_uri="${AS}", realm="${STORAGE}"` },
        })
      }
      if (url === `${AS}.well-known/lws-configuration`) {
        return json(AS_METADATA)
      }
      if (url === TOKEN_ENDPOINT) {
        return json({ access_token: 'lws-token', expires_in: 300 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const token = await requestLwsAccessToken({
      resource: STORAGE,
      subjectToken: async () => 'id-token',
      fetch,
    })
    expect(token).toEqual({ accessToken: 'lws-token', expiresIn: 300 })
  })
})

describe('createLwsFetch — service paths vs peer storages', () => {
  const REGISTRY = 'https://registry/'
  const BOB_REGISTRY = 'https://registry/bob/'
  const ACME_REGISTRY = 'https://registry/acme/'
  const REGISTRY_METADATA = {
    issuer: REGISTRY,
    token_endpoint: `${REGISTRY}.well-known/lws/token`,
    jwks_uri: `${REGISTRY}.well-known/lws/jwks`,
  }

  function registryServer() {
    const resources: Array<string> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const request = input as Request
      if (url === `${REGISTRY}.well-known/lws-configuration`) {
        return json(REGISTRY_METADATA)
      }
      if (url === `${REGISTRY}.well-known/lws/token`) {
        const resource = new URLSearchParams(init?.body as string).get('resource')!
        resources.push(resource)
        return json({ access_token: `lws-${resource}`, expires_in: 300 })
      }
      const authorization = request.headers.get('authorization')
      if (authorization === `Bearer lws-${BOB_REGISTRY}`) {
        return json({ id: url })
      }
      if (authorization === `Bearer lws-${ACME_REGISTRY}`) {
        return json({ id: url })
      }
      return unauthorized(`Bearer as_uri="${REGISTRY}", realm="${ACME_REGISTRY}"`)
    })
    return { fetch: fetch as unknown as typeof globalThis.fetch, resources }
  }

  test('a peer registration uses the challenge storage, not the session storage', async () => {
    const { fetch, resources } = registryServer()
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [BOB_REGISTRY],
      fetch,
    })
    const response = await lwsFetch(`${ACME_REGISTRY}m4k9wp`)
    expect(response.status).toBe(200)
    expect(resources).toEqual([ACME_REGISTRY])
  })

  test('a notification service path uses a same-origin storage token', async () => {
    const { fetch, resources } = registryServer()
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [BOB_REGISTRY],
      fetch,
    })
    const topic = encodeURIComponent(`${BOB_REGISTRY}jc5gt6`)
    const response = await lwsFetch(`${REGISTRY}.notifications/StreamingHTTPChannel2023/${topic}`)
    expect(response.status).toBe(200)
    expect(resources).toEqual([BOB_REGISTRY])
  })
})

describe('createLwsFetch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('authenticates a known storage whose origin hosts the authorization server', async () => {
    const { fetch } = storageServer({ acceptToken: 'lws-1' })
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: ['https://reg.docker/dan/'],
      fetch,
    })
    const response = await lwsFetch('https://reg.docker/dan/social-agent/')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'https://reg.docker/dan/social-agent/' })
  })

  test('retries with a token after the challenge of a storage with an external AS', async () => {
    const { fetch, exchanges } = storageServer({ acceptToken: 'lws-1' })
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [STORAGE],
      fetch,
    })
    const response = await lwsFetch(`${STORAGE}gl1tch`)
    expect(response.status).toBe(200)
    expect(exchanges()).toBe(1)
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([request]) => (request as Request).url
    )
    expect(urls[0]).toBe(`${STORAGE}gl1tch`)
  })

  test('caches the access token per storage', async () => {
    const { fetch, exchanges } = storageServer({ acceptToken: 'lws-1' })
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [STORAGE],
      fetch,
    })
    await lwsFetch(`${STORAGE}gl1tch`)
    const second = await lwsFetch(`${STORAGE}n3onkx`)
    expect(second.status).toBe(200)
    expect(exchanges()).toBe(1)
  })

  test('re-exchanges when the cached token is rejected', async () => {
    let exchanges = 0
    let firstTokenValid = true
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      const request = input as Request
      if (url === `${AS}.well-known/lws-configuration`) {
        return json(AS_METADATA)
      }
      if (url === TOKEN_ENDPOINT) {
        exchanges += 1
        return json({ access_token: `lws-${exchanges}`, expires_in: 300 })
      }
      const authorization = request.headers.get('authorization')
      if (authorization === 'Bearer lws-1' && firstTokenValid) {
        firstTokenValid = false
        return json({ id: url })
      }
      if (authorization === 'Bearer lws-2') {
        return json({ id: url })
      }
      return unauthorized(`Bearer as_uri="${AS}", realm="${STORAGE}", error="invalid_token"`)
    }) as unknown as typeof globalThis.fetch
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [STORAGE],
      fetch,
    })
    // warm the cache: unauthenticated request -> challenge -> lws-1
    expect((await lwsFetch(`${STORAGE}gl1tch`)).status).toBe(200)
    // the cached lws-1 is now rejected, so the next request re-exchanges
    expect((await lwsFetch(`${STORAGE}n3onkx`)).status).toBe(200)
    expect(exchanges).toBe(2)
  })

  test('renews an expired access token before the request', async () => {
    vi.useFakeTimers()
    const { fetch, exchanges } = storageServer({ acceptToken: 'lws-2', expiresIn: 1 })
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [STORAGE],
      fetch,
      renewalMargin: 0,
    })
    await lwsFetch(`${STORAGE}gl1tch`)
    // the minimum cache lifetime is 30s; after that the token is renewed
    vi.advanceTimersByTime(31_000)
    const response = await lwsFetch(`${STORAGE}gl1tch`)
    expect(response.status).toBe(200)
    expect(exchanges()).toBe(2)
  })

  test('returns a non-LWS 401 unchanged', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request
      if (request.url === `${STORAGE}gl1tch`) {
        return unauthorized('DPoP realm="x"')
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [STORAGE],
      fetch,
    })
    const response = await lwsFetch(`${STORAGE}gl1tch`)
    expect(response.status).toBe(401)
  })

  test('uses a custom token source instead of the local exchange', async () => {
    const tokenSource = vi.fn(async () => ({ accessToken: 'uas-token', expiresIn: 300 }))
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request
      if (request.headers.get('authorization') === 'Bearer uas-token') {
        return json({ id: request.url })
      }
      return unauthorized(LWS_CHALLENGE)
    }) as unknown as typeof globalThis.fetch
    const lwsFetch = createLwsFetch({
      tokenSource,
      storages: [STORAGE],
      fetch,
    })
    const response = await lwsFetch(`${STORAGE}gl1tch`)
    expect(response.status).toBe(200)
    expect(tokenSource).toHaveBeenCalledWith(STORAGE, expect.anything())
  })

  test('does not authenticate requests outside the known storages', async () => {
    const fetch = vi.fn(async () => json({ public: true })) as unknown as typeof globalThis.fetch
    const lwsFetch = createLwsFetch({
      subjectToken: async () => 'id-token',
      storages: [STORAGE],
      fetch,
    })
    const response = await lwsFetch('https://id.docker/bob')
    expect(response.status).toBe(200)
    const request = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request
    expect(request.headers.get('authorization')).toBeNull()
  })
})
