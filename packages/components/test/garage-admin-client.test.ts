import { describe, expect, test, vi } from 'vitest'

import { GarageAdminClient } from '../src/GarageAdminClient.js'

// ──────────────────────────
// Helpers
// ──────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

/** A scripted `fetch` that records every request. */
function recordingFetch(handler: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Array<Call>
} {
  const calls: Array<Call> = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[key.toLowerCase()] = value
    }
    const call: Call = {
      method: init?.method ?? 'GET',
      url: input.toString(),
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

function makeClient(fetchImpl: typeof fetch): GarageAdminClient {
  return new GarageAdminClient({
    baseUrl: 'http://garage:3903',
    adminToken: 'admin-token',
    fetch: fetchImpl,
  })
}

// ──────────────────────────
// Tests
// ──────────────────────────

describe('GarageAdminClient', () => {
  test('ensureBucket creates a missing bucket via the global alias', async () => {
    const { fetch, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/v2/ListBuckets')) {
        return jsonResponse([])
      }
      return jsonResponse({ id: 'b1', globalAliases: ['data-alice'] })
    })

    const bucket = await makeClient(fetch).ensureBucket('data-alice')

    expect(bucket).toEqual({ id: 'b1', globalAliases: ['data-alice'] })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET http://garage:3903/v2/ListBuckets',
      'POST http://garage:3903/v2/CreateBucket',
    ])
    expect(calls[1].body).toEqual({ globalAlias: 'data-alice' })
    expect(calls[0].headers.authorization).toBe('Bearer admin-token')
    expect(calls[1].headers['content-type']).toBe('application/json')
  })

  test('ensureBucket is idempotent — an existing alias is reused, not recreated', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse([{ id: 'b1', globalAliases: ['data-alice'], localAliases: [] }])
    )

    const bucket = await makeClient(fetch).ensureBucket('data-alice')

    expect(bucket.id).toBe('b1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://garage:3903/v2/ListBuckets')
  })

  test('createKey sends the name and returns the generated secret', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({
        accessKeyId: 'GK123',
        secretAccessKey: 'secret',
        name: 'data-alice',
        expired: false,
        permissions: {},
        buckets: [],
      })
    )

    const key = await makeClient(fetch).createKey('data-alice')

    expect(key.accessKeyId).toBe('GK123')
    expect(key.secretAccessKey).toBe('secret')
    expect(calls[0].body).toEqual({ name: 'data-alice' })
  })

  test('findKeyByName normalises the ListKeys `id` to `accessKeyId`', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse([{ id: 'GK123', name: 'data-alice', expired: false }])
    )

    const key = await makeClient(fetch).findKeyByName('data-alice')

    expect(key?.accessKeyId).toBe('GK123')
  })

  test('allowBucketKey scopes the key to the bucket with all flags active', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ id: 'b1', globalAliases: ['data-alice'] })
    )

    await makeClient(fetch).allowBucketKey('b1', 'GK123', {
      read: true,
      write: true,
      owner: true,
    })

    expect(calls[0].url).toBe('http://garage:3903/v2/AllowBucketKey')
    expect(calls[0].body).toEqual({
      bucketId: 'b1',
      accessKeyId: 'GK123',
      permissions: { read: true, write: true, owner: true },
    })
  })

  test('deleteBucket / deleteKey issue the id query and tolerate a missing resource', async () => {
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 404 }))

    await makeClient(fetch).deleteBucket('b1')
    await makeClient(fetch).deleteKey('GK123')

    expect(calls.map((call) => call.url)).toEqual([
      'http://garage:3903/v2/DeleteBucket?id=b1',
      'http://garage:3903/v2/DeleteKey?id=GK123',
    ])
  })

  test('surfaces the status and body of a failed request', async () => {
    const { fetch } = recordingFetch(
      () => new Response('bucket alias already exists', { status: 500 })
    )

    await expect(makeClient(fetch).createBucket('data-alice')).rejects.toThrow(
      'Garage admin POST /v2/CreateBucket failed (500): bucket alias already exists'
    )
  })
})
