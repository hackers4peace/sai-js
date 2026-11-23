import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// Mocks
// ──────────────────────────

/**
 * Replaces `S3DataAccessor` with a spy that records the args each delegate was
 * constructed with, so `RoutedS3DataAccessor`'s routing (which pod → which
 * bucket/key) is observable without a live object store.
 */
const s3Mock = vi.hoisted(() => {
  interface Call {
    method: string
    path: string
  }
  const instances: Array<{ args: Record<string, string>; calls: Array<Call> }> = []
  class S3DataAccessor {
    args: Record<string, string>
    calls: Array<Call> = []
    public constructor(args: Record<string, string>) {
      this.args = args
      instances.push(this)
    }
    public async canHandle(): Promise<void> {}
    public async getData(id: { path: string }): Promise<unknown> {
      this.calls.push({ method: 'getData', path: id.path })
      return 'data-stream'
    }
    public async writeDocument(id: { path: string }): Promise<void> {
      this.calls.push({ method: 'writeDocument', path: id.path })
    }
    public async deleteResource(id: { path: string }): Promise<void> {
      this.calls.push({ method: 'deleteResource', path: id.path })
    }
  }
  return { instances, S3DataAccessor }
})

vi.mock('../src/S3DataAccessor.js', () => ({ S3DataAccessor: s3Mock.S3DataAccessor }))

import {
  NotFoundHttpError,
  NotImplementedHttpError,
  UnsupportedMediaTypeHttpError,
} from '@solid/community-server'

import type { ObjectEndpointRecord } from '../src/PodEndpointStore.js'
import { RoutedS3DataAccessor } from '../src/RoutedS3DataAccessor.js'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const S3_ENDPOINT = 'http://garage:3900'

const records: Array<ObjectEndpointRecord> = [
  {
    id: 'o-alice',
    accountId: 'acc',
    podUrl: 'https://data/alice-home/',
    endpoint: S3_ENDPOINT,
    bucket: 'data-alice-home',
    accessKeyId: 'GK-alice',
    secretAccessKey: 'sk-alice',
  },
  {
    id: 'o-bob',
    accountId: 'acc',
    podUrl: 'https://data/bob-home/',
    endpoint: S3_ENDPOINT,
    bucket: 'data-bob-home',
    accessKeyId: 'GK-bob',
    secretAccessKey: 'sk-bob',
  },
]

/** `identifier.path -> pod base URL`; anything absent has no storage. */
const storageByPath: Record<string, string> = {
  'https://alice-home.data.docker/notes/1': 'https://data/alice-home/',
  'https://alice-home.data.docker/notes/2': 'https://data/alice-home/',
  'https://bob-home.data.docker/notes/1': 'https://data/bob-home/',
  'https://data.docker/unknown-pod/notes/1': 'https://data/unknown-pod/',
}

interface StoreOptions {
  /** pod URL whose lookup rejects (a storage outage) */
  throwOn?: string
}

function fakeStore(opts: StoreOptions = {}): unknown {
  return {
    findObjectByPodUrl: async (podUrl: string) => {
      if (opts.throwOn === podUrl) {
        throw new Error('endpoint store unavailable')
      }
      return records.find((record) => record.podUrl === podUrl)
    },
  }
}

function fakeStorageStrategy(): unknown {
  return {
    getStorageIdentifier: async (identifier: { path: string }) => {
      const pod = storageByPath[identifier.path]
      if (!pod) {
        throw new Error(`no storage for ${identifier.path}`)
      }
      return { path: pod }
    },
  }
}

function makeAccessor(opts: StoreOptions = {}): RoutedS3DataAccessor {
  return new RoutedS3DataAccessor(
    fakeStorageStrategy() as never,
    fakeStore(opts) as never,
    'garage'
  )
}

function accessorFor(bucket: string): {
  args: Record<string, string>
  calls: Array<{ method: string; path: string }>
} {
  const instance = s3Mock.instances.find((candidate) => candidate.args.bucket === bucket)
  if (!instance) {
    throw new Error(`no delegate was constructed for ${bucket}`)
  }
  return instance
}

beforeEach(() => {
  s3Mock.instances.length = 0
})

// ──────────────────────────
// Tests
// ──────────────────────────

describe('RoutedS3DataAccessor', () => {
  test('routes a data-pod identifier to that pod bucket and key', async () => {
    const identifier = { path: 'https://alice-home.data.docker/notes/1' }

    const result = await makeAccessor().getData(identifier)

    expect(result).toBe('data-stream')
    const delegate = accessorFor('data-alice-home')
    expect(delegate.args).toEqual({
      endpoint: S3_ENDPOINT,
      bucket: 'data-alice-home',
      accessKeyId: 'GK-alice',
      secretAccessKey: 'sk-alice',
      region: 'garage',
    })
    expect(delegate.calls).toEqual([{ method: 'getData', path: identifier.path }])
  })

  test('two pods route to distinct buckets', async () => {
    const accessor = makeAccessor()

    await accessor.getData({ path: 'https://alice-home.data.docker/notes/1' })
    await accessor.getData({ path: 'https://bob-home.data.docker/notes/1' })

    expect(accessorFor('data-alice-home').args.accessKeyId).toBe('GK-alice')
    expect(accessorFor('data-bob-home').args.accessKeyId).toBe('GK-bob')
  })

  test('caches one delegate per (endpoint, bucket)', async () => {
    const accessor = makeAccessor()

    await accessor.getData({ path: 'https://alice-home.data.docker/notes/1' })
    await accessor.getData({ path: 'https://alice-home.data.docker/notes/2' })

    expect(s3Mock.instances).toHaveLength(1)
    expect(accessorFor('data-alice-home').calls).toEqual([
      { method: 'getData', path: 'https://alice-home.data.docker/notes/1' },
      { method: 'getData', path: 'https://alice-home.data.docker/notes/2' },
    ])
  })

  test('returns 404 when the identifier has no storage (server root)', async () => {
    await expect(makeAccessor().getData({ path: 'https://data.docker/' })).rejects.toBeInstanceOf(
      NotFoundHttpError
    )
  })

  test('fails closed when the pod has no object endpoint record', async () => {
    await expect(
      makeAccessor().getData({ path: 'https://data.docker/unknown-pod/notes/1' })
    ).rejects.toThrow('no object endpoint for pod')
  })

  test('routes writes and deletes through the same per-pod delegate', async () => {
    const identifier = { path: 'https://alice-home.data.docker/notes/1' }
    const accessor = makeAccessor()

    await accessor.writeDocument(identifier, 'stream' as never, {} as never)
    await accessor.deleteResource(identifier)

    expect(accessorFor('data-alice-home').calls).toEqual([
      { method: 'writeDocument', path: identifier.path },
      { method: 'deleteResource', path: identifier.path },
    ])
  })

  test('canHandle accepts binary and rejects non-binary representations', async () => {
    await expect(makeAccessor().canHandle({ binary: true } as never)).resolves.toBeUndefined()
    await expect(makeAccessor().canHandle({ binary: false } as never)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeHttpError
    )
  })

  test('metadata and container methods are not implemented', async () => {
    const accessor = makeAccessor()

    await expect(accessor.getMetadata()).rejects.toBeInstanceOf(NotImplementedHttpError)
    expect(() => accessor.getChildren()).toThrow(NotImplementedHttpError)
    await expect(accessor.writeContainer()).rejects.toBeInstanceOf(NotImplementedHttpError)
    await expect(accessor.writeMetadata()).rejects.toBeInstanceOf(NotImplementedHttpError)
  })

  test('propagates an endpoint-store failure instead of silently using a default bucket', async () => {
    await expect(
      makeAccessor({ throwOn: 'https://data/alice-home/' }).getData({
        path: 'https://alice-home.data.docker/notes/1',
      })
    ).rejects.toThrow('endpoint store unavailable')
  })
})
