import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// Mocks
// ──────────────────────────

/**
 * Replaces CSS's `SparqlDataAccessor` with a spy that records which endpoint
 * each delegate was constructed with, so the routing decisions of
 * `RoutedSparqlDataAccessor` are observable without a live SPARQL store.
 */
const cssMock = vi.hoisted(() => {
  interface Call {
    method: string
    path: string
  }
  const instances: Array<{ endpoint: string; calls: Array<Call> }> = []
  class SparqlDataAccessor {
    endpoint: string
    calls: Array<Call> = []
    public constructor(endpoint: string) {
      this.endpoint = endpoint
      instances.push(this)
    }
    public async canHandle(): Promise<void> {}
    public async getData(id: { path: string }): Promise<unknown> {
      this.calls.push({ method: 'getData', path: id.path })
      return 'data-stream'
    }
    public async getMetadata(id: { path: string }): Promise<unknown> {
      this.calls.push({ method: 'getMetadata', path: id.path })
      return { path: id.path }
    }
    public async *getChildren(id: { path: string }): AsyncIterableIterator<unknown> {
      this.calls.push({ method: 'getChildren', path: id.path })
      yield { path: id.path }
    }
    public async writeDocument(id: { path: string }): Promise<void> {
      this.calls.push({ method: 'writeDocument', path: id.path })
    }
    public async writeContainer(id: { path: string }): Promise<void> {
      this.calls.push({ method: 'writeContainer', path: id.path })
    }
    public async writeMetadata(id: { path: string }): Promise<void> {
      this.calls.push({ method: 'writeMetadata', path: id.path })
    }
    public async deleteResource(id: { path: string }): Promise<void> {
      this.calls.push({ method: 'deleteResource', path: id.path })
    }
  }
  return { instances, SparqlDataAccessor }
})

vi.mock('@solid/community-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solid/community-server')>()
  return { ...actual, SparqlDataAccessor: cssMock.SparqlDataAccessor }
})

import { NotFoundHttpError } from '@solid/community-server'

import type { SparqlEndpointRecord } from '../src/PodEndpointStore.js'
import { RoutedSparqlDataAccessor } from '../src/RoutedSparqlDataAccessor.js'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const DATA_ENDPOINT = 'http://fuseki:3030/data-alice-home/sparql'
const REGISTRY_ENDPOINT = 'http://fuseki:3030/reg-alice/sparql'

const records: Array<SparqlEndpointRecord> = [
  {
    id: 'reg',
    accountId: 'acc',
    podUrl: 'https://registry/alice/',
    endpoint: REGISTRY_ENDPOINT,
  },
  {
    id: 'data',
    accountId: 'acc',
    podUrl: 'https://data/alice-home/',
    endpoint: DATA_ENDPOINT,
  },
]

/** `identifier.path -> pod base URL`; anything absent has no storage. */
const storageByPath: Record<string, string> = {
  'https://alice-home.data.docker/notes/1': 'https://data/alice-home/',
  'https://data.docker/unknown-pod/notes/1': 'https://data/unknown-pod/',
  'https://registry.docker/alice/authorization/x': 'https://registry/alice/',
}

interface StoreOptions {
  /** pod URL whose lookup rejects (a storage outage) */
  throwOn?: string
}

function fakeStore(opts: StoreOptions = {}): unknown {
  return {
    findSparqlByPodUrl: async (podUrl: string) => {
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

function makeAccessor(opts: StoreOptions = {}): RoutedSparqlDataAccessor {
  return new RoutedSparqlDataAccessor(
    {} as never,
    fakeStorageStrategy() as never,
    fakeStore(opts) as never
  )
}

function accessorFor(endpoint: string): {
  endpoint: string
  calls: Array<{ method: string; path: string }>
} {
  const instance = cssMock.instances.find((candidate) => candidate.endpoint === endpoint)
  if (!instance) {
    throw new Error(`no delegate was constructed for ${endpoint}`)
  }
  return instance
}

beforeEach(() => {
  cssMock.instances.length = 0
})

// ──────────────────────────
// Tests
// ──────────────────────────

describe('RoutedSparqlDataAccessor', () => {
  test('routes a data-pod identifier to that pod dataset', async () => {
    const identifier = { path: 'https://alice-home.data.docker/notes/1' }

    const result = await makeAccessor().getData(identifier)

    expect(result).toBe('data-stream')
    expect(accessorFor(DATA_ENDPOINT).calls).toEqual([{ method: 'getData', path: identifier.path }])
  })

  test('routes a registry-pod identifier to its registry dataset', async () => {
    const identifier = { path: 'https://registry.docker/alice/authorization/x' }

    await makeAccessor().getData(identifier)

    expect(accessorFor(REGISTRY_ENDPOINT).calls).toEqual([
      { method: 'getData', path: identifier.path },
    ])
  })

  test('returns 404 when the identifier has no storage (server root)', async () => {
    const identifier = { path: 'https://data.docker/' }

    await expect(makeAccessor().getData(identifier)).rejects.toBeInstanceOf(NotFoundHttpError)
  })

  test('fails closed when the pod has no endpoint record', async () => {
    const identifier = { path: 'https://data.docker/unknown-pod/notes/1' }

    await expect(makeAccessor().getData(identifier)).rejects.toThrow('no SPARQL endpoint for pod')
  })

  test('routes writes through the same per-pod delegate', async () => {
    const identifier = { path: 'https://alice-home.data.docker/notes/1' }

    await makeAccessor().writeDocument(identifier, 'stream' as never, {} as never)

    expect(accessorFor(DATA_ENDPOINT).calls).toEqual([
      { method: 'writeDocument', path: identifier.path },
    ])
  })

  test('propagates an endpoint-store failure instead of silently using a default endpoint', async () => {
    const identifier = { path: 'https://alice-home.data.docker/notes/1' }

    await expect(
      makeAccessor({ throwOn: 'https://data/alice-home/' }).getData(identifier)
    ).rejects.toThrow('endpoint store unavailable')
  })
})
