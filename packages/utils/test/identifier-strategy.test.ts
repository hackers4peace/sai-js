import { describe, expect, test, vi } from 'vitest'

import {
  CachingIdentifierStrategyResolver,
  FlatIdentifierStrategy,
  executeCreationPlan,
} from '../src'
import type { WhatwgFetch } from '../src'

const root = 'https://data.example/alice/'
const uuid = '6f1e6c1e-0000-4000-8000-000000000000'
const id = `${root}${uuid}`

describe('FlatIdentifierStrategy', () => {
  const strategy = new FlatIdentifierStrategy(root, () => uuid)

  test('mints at the storage root and ignores parent/kind', () => {
    expect(strategy.mint({ parent: 'https://data.example/alice/reg', isContainer: false })).toBe(id)
    expect(strategy.mint({ parent: 'https://data.example/alice/reg', isContainer: true })).toBe(id)
  })

  test('plans a document POST with the UUID Slug and body', () => {
    const body = { '@id': id, name: 'Project' }
    expect(
      strategy.create({
        parent: 'https://data.example/alice/reg',
        identifier: id,
        isContainer: false,
        body,
      })
    ).toEqual({
      identifier: id,
      steps: [
        {
          type: 'post',
          url: 'https://data.example/alice/reg',
          headers: { slug: uuid, 'content-type': 'application/ld+json' },
          body,
        },
      ],
    })
  })

  test('plans an empty container POST followed by a description patch', () => {
    const body = { '@id': id, registeredShapeTree: 'https://trees.example/Project' }
    expect(
      strategy.create({
        parent: 'https://data.example/alice/',
        identifier: id,
        isContainer: true,
        body,
      })
    ).toEqual({
      identifier: id,
      steps: [
        {
          type: 'post',
          url: 'https://data.example/alice/',
          headers: {
            slug: uuid,
            'content-type': 'application/ld+json',
            link: '<https://www.w3.org/ns/lws#Container>; rel="type"',
          },
        },
        { type: 'patch-description', body },
      ],
    })
  })
})

describe('executeCreationPlan', () => {
  test('verifies the planned identifier', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: (name: string) => (name === 'Location' ? id : null) },
    })) as unknown as WhatwgFetch

    await expect(
      executeCreationPlan(
        {
          identifier: id,
          steps: [
            {
              type: 'post',
              url: 'https://data.example/alice/reg',
              headers: { slug: uuid },
              body: [],
            },
          ],
        },
        fetch
      )
    ).resolves.toBe(id)
    expect(fetch).toHaveBeenCalledWith('https://data.example/alice/reg', {
      method: 'POST',
      headers: { slug: uuid },
      body: '[]',
    })
  })

  test('rejects a server-allocated identifier that differs from the plan', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'https://data.example/alice/other' },
    })) as unknown as WhatwgFetch

    await expect(
      executeCreationPlan(
        {
          identifier: id,
          steps: [
            {
              type: 'post',
              url: 'https://data.example/alice/reg',
              headers: { slug: uuid },
            },
          ],
        },
        fetch
      )
    ).rejects.toThrow(/allocated .* expected/)
  })
})

describe('CachingIdentifierStrategyResolver', () => {
  function storageFetch(serviceEndpoint = 'https://storage.example/root') {
    return vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'Link'
                ? '<https://storage.example/description>; rel="https://www.w3.org/ns/lws#storage"'
                : null,
          },
        } as unknown as Response
      }
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === 'Content-Type' ? 'application/lws+cid' : null),
        },
        json: async () => ({
          id: 'https://storage.example/description',
          type: 'Storage',
          service: [{ type: 'StorageRoot', serviceEndpoint }],
        }),
      } as unknown as Response
    }) as unknown as WhatwgFetch
  }

  test('uses the discovered root and service endpoint verbatim', async () => {
    const endpoint = 'https://storage.example/root-no-slash'
    const fetch = storageFetch(endpoint)
    const resolver = new CachingIdentifierStrategyResolver(fetch, () => uuid)

    const resolved = await resolver.resolve('https://resource.example/some/container')
    expect(resolved.storageRoot).toBe(endpoint)
    expect(resolved.strategy.mint({ parent: 'x', isContainer: false })).toBe(`${endpoint}${uuid}`)
    expect(resolver.forStorage(endpoint)).toBe(resolved.strategy)
  })

  test('populates the cache on a miss and reuses it by root', async () => {
    const endpoint = 'https://storage.example/root'
    const fetch = storageFetch(endpoint)
    const resolver = new CachingIdentifierStrategyResolver(fetch, () => uuid)

    await resolver.resolve('https://resource.example/some/container')
    const calls = vi.mocked(fetch).mock.calls.length
    await resolver.resolve(endpoint)
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
  })

  test('throws when no strategy has been resolved for the root', () => {
    const resolver = new CachingIdentifierStrategyResolver(storageFetch(), () => uuid)
    expect(() => resolver.forStorage('https://unknown.example/')).toThrow(/no identifier strategy/)
  })
})
