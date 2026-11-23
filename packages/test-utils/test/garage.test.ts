import { afterEach, describe, expect, test, vi } from 'vitest'

import { seedObjectEndpoints } from '../src/garage.js'

interface State {
  buckets: Array<{ id: string; globalAliases: Array<string>; localAliases: Array<unknown> }>
  keys: Array<{ accessKeyId: string; name: string; expired: boolean }>
  secrets: Record<string, string>
  calls: Array<string>
}

function json(body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Scripted Garage v2 admin API. */
function garageFetch(state: State): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString())
    state.calls.push(url.pathname)
    const body = init?.body ? JSON.parse(init.body as string) : undefined

    switch (url.pathname) {
      case '/v2/ListBuckets':
        return json(state.buckets)
      case '/v2/ListKeys':
        return json(state.keys)
      case '/v2/GetKeyInfo': {
        const id = url.searchParams.get('id') ?? ''
        return json({
          accessKeyId: id,
          name: 'key',
          secretAccessKey:
            url.searchParams.get('showSecretKey') === 'true' ? state.secrets[id] : null,
        })
      }
      case '/v2/CreateBucket': {
        const bucket = {
          id: `b${state.buckets.length + 1}`,
          globalAliases: [body.globalAlias],
          localAliases: [],
        }
        state.buckets.push(bucket)
        return json(bucket)
      }
      case '/v2/CreateKey': {
        const key = {
          accessKeyId: `GK${state.keys.length + 1}`,
          name: body.name,
          secretAccessKey: `secret-${body.name}`,
          expired: false,
        }
        state.keys.push({ ...key })
        state.secrets[key.accessKeyId] = key.secretAccessKey
        return json({ ...key, permissions: {}, buckets: [] })
      }
      case '/v2/AllowBucketKey':
        return json({ id: body.bucketId })
      default:
        throw new Error(`unexpected request ${url.pathname}`)
    }
  }) as unknown as typeof fetch
}

function freshState(): State {
  return { buckets: [], keys: [], secrets: {}, calls: [] }
}

function makeKv() {
  return {
    'accounts/data/acc-1': {
      id: 'acc-1',
      '**pod**': {
        p1: { baseUrl: 'https://data/alice-home/', accountId: 'acc-1' },
        p2: { baseUrl: 'https://data/test-client/', accountId: 'acc-1' },
      },
    },
  } as Record<string, any>
}

const options = {
  adminBaseUrl: 'http://garage:3903',
  adminToken: 'token',
  s3Endpoint: 'http://garage:3900',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('seedObjectEndpoints', () => {
  test('provisions a bucket + key per data pod and merges the records and indexes', async () => {
    const state = freshState()
    vi.stubGlobal('fetch', garageFetch(state))

    const kv = makeKv()
    const byPodUrl = await seedObjectEndpoints(kv, options)

    // one bucket + key per pod, named after the pod's dataset
    expect(state.calls).toContain('/v2/CreateBucket')
    expect(state.buckets.map((b) => b.globalAliases[0])).toEqual([
      'data-alice-home',
      'data-test-client',
    ])

    const alice = byPodUrl.get('https://data/alice-home/')!
    expect(alice).toMatchObject({
      podUrl: 'https://data/alice-home/',
      endpoint: 'http://garage:3900',
      bucket: 'data-alice-home',
      accessKeyId: 'GK1',
      secretAccessKey: 'secret-data-alice-home',
    })

    // records land on the account, keyed by podUrl
    const records = Object.values(kv['accounts/data/acc-1']['**objectEndpoint**']) as Array<any>
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.podUrl === 'https://data/test-client/')).toMatchObject({
      accountId: 'acc-1',
      bucket: 'data-test-client',
      accessKeyId: 'GK2',
      secretAccessKey: 'secret-data-test-client',
    })

    // …and their indexes are written encodeURIComponent-encoded
    for (const podUrl of ['https://data/alice-home/', 'https://data/test-client/']) {
      expect(kv[`accounts/index/objectEndpoint/podUrl/${encodeURIComponent(podUrl)}`]).toEqual([
        'acc-1',
      ])
    }
    expect(kv['accounts/index/objectEndpoint/accountId/acc-1']).toEqual(['acc-1'])
  })

  test('is find-first: an existing bucket/key is reused and its secret recovered', async () => {
    const state = freshState()
    state.buckets.push({ id: 'b1', globalAliases: ['data-alice-home'], localAliases: [] })
    state.keys.push({ accessKeyId: 'GKexisting', name: 'data-alice-home', expired: false })
    state.secrets['GKexisting'] = 'secret-existing'
    vi.stubGlobal('fetch', garageFetch(state))

    const kv = {
      'accounts/data/acc-1': {
        id: 'acc-1',
        '**pod**': { p1: { baseUrl: 'https://data/alice-home/', accountId: 'acc-1' } },
      },
    }
    const byPodUrl = await seedObjectEndpoints(kv, options)

    expect(state.calls).not.toContain('/v2/CreateBucket')
    expect(state.calls).not.toContain('/v2/CreateKey')
    expect(byPodUrl.get('https://data/alice-home/')).toMatchObject({
      accessKeyId: 'GKexisting',
      secretAccessKey: 'secret-existing',
    })
  })

  test("names the bucket after the pod's sparqlEndpoint dataset when the URLs differ", async () => {
    const state = freshState()
    vi.stubGlobal('fetch', garageFetch(state))

    const kv = {
      'accounts/data/acc-1': {
        id: 'acc-1',
        '**pod**': { p1: { baseUrl: 'https://vuejectron.data.docker/', accountId: 'acc-1' } },
        '**sparqlEndpoint**': {
          e1: {
            accountId: 'acc-1',
            podUrl: 'https://vuejectron.data.docker/',
            endpoint: 'http://fuseki:3030/data-test-client/sparql',
            id: 'e1',
          },
        },
      },
    }

    const byPodUrl = await seedObjectEndpoints(kv, options)

    expect(byPodUrl.get('https://vuejectron.data.docker/')?.bucket).toBe('data-test-client')
  })
})
