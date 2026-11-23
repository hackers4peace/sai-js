import { describe, expect, test } from 'vitest'

import {
  OBJECT_ENDPOINT_STORAGE_TYPE,
  PodEndpointStore,
  SPARQL_ENDPOINT_STORAGE_TYPE,
} from '../src/PodEndpointStore.js'

/** Minimal in-memory stand-in for the CSS AccountLoginStorage (per type). */
function fakeStorage() {
  const byType = new Map<string, any[]>()
  const calls: any[] = []
  const recordsOf = (type: string): any[] => {
    let records = byType.get(type)
    if (!records) {
      records = []
      byType.set(type, records)
    }
    return records
  }
  return {
    recordsOf,
    calls,
    defineType: async (...args: any[]) => {
      calls.push(['defineType', ...args])
    },
    createIndex: async (...args: any[]) => {
      calls.push(['createIndex', ...args])
    },
    create: async (type: string, value: any) => {
      const record = { ...value, id: value.id ?? `id-${recordsOf(type).length}` }
      recordsOf(type).push(record)
      return record
    },
    find: async (type: string, query: any) =>
      recordsOf(type).filter((record) =>
        Object.entries(query).every(([key, value]) => record[key] === value)
      ),
    // `findByIri` scans all records of a type rather than querying an index
    entries: async function* (type: string) {
      for (const record of recordsOf(type)) {
        yield record
      }
    },
    delete: async (type: string, id: string) => {
      const records = recordsOf(type)
      const index = records.findIndex((record) => record.id === id)
      if (index >= 0) {
        records.splice(index, 1)
      }
    },
  }
}

const registrySparql = {
  accountId: 'acc',
  podUrl: 'https://registry/alice/',
  endpoint: 'http://fuseki:3030/reg-alice/sparql',
}
const dataSparql = {
  accountId: 'acc',
  podUrl: 'https://data/alice-home/',
  endpoint: 'http://fuseki:3030/data-alice-home/sparql',
}
const dataObject = {
  accountId: 'acc',
  podUrl: 'https://data/alice-home/',
  endpoint: 'http://garage:3900',
  bucket: 'data-alice-home',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
}

/** Resolves the fixture WebID to its account. */
const webIdStore = {
  findAccount: async (webId: string) => (webId === 'https://id/alice' ? 'acc' : undefined),
}

describe('PodEndpointStore', () => {
  test('defines both endpoint types and their indexes once', async () => {
    const storage = fakeStorage()
    const store = new PodEndpointStore(storage as any, webIdStore as any)

    await store.handle()
    await store.handle() // idempotent

    const defined = storage.calls.filter((call) => call[0] === 'defineType')
    expect(defined.map((call) => call[1])).toEqual([
      SPARQL_ENDPOINT_STORAGE_TYPE,
      OBJECT_ENDPOINT_STORAGE_TYPE,
    ])
    expect(defined.every((call) => call[3] === false)).toBe(true)

    const indexed = storage.calls
      .filter((call) => call[0] === 'createIndex')
      .map((call) => `${call[1]}:${call[2]}`)
    expect(indexed).toEqual([
      `${SPARQL_ENDPOINT_STORAGE_TYPE}:podUrl`,
      `${SPARQL_ENDPOINT_STORAGE_TYPE}:accountId`,
      `${OBJECT_ENDPOINT_STORAGE_TYPE}:podUrl`,
      `${OBJECT_ENDPOINT_STORAGE_TYPE}:accountId`,
    ])
  })

  test('creates SPARQL records and resolves pods, accounts and WebIDs', async () => {
    const storage = fakeStorage()
    const store = new PodEndpointStore(storage as any, webIdStore as any)
    await store.handle()

    await store.createSparql(registrySparql)
    await store.createSparql(dataSparql)

    expect((await store.findSparqlByPodUrl('https://registry/alice/'))?.endpoint).toBe(
      'http://fuseki:3030/reg-alice/sparql'
    )
    expect(await store.findSparqlByPodUrl('https://data/alice-work/')).toBeUndefined()
    expect(await store.findSparqlByAccountId('acc')).toHaveLength(2)
    expect(await store.findSparqlByAccountId('other')).toHaveLength(0)
    expect(await store.findSparqlByWebId('https://id/alice')).toHaveLength(2)
    expect(await store.findSparqlByWebId('https://id/bob')).toHaveLength(0)
  })

  test('stores the object (S3) endpoint of data pods only', async () => {
    const storage = fakeStorage()
    const store = new PodEndpointStore(storage as any, webIdStore as any)
    await store.handle()

    await store.createObject(dataObject)

    const record = await store.findObjectByPodUrl('https://data/alice-home/')
    expect(record).toMatchObject({
      bucket: 'data-alice-home',
      endpoint: 'http://garage:3900',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    })
    expect(await store.findObjectByAccountId('acc')).toHaveLength(1)
    // the registry pod has no object endpoint
    expect(await store.findObjectByPodUrl('https://registry/alice/')).toBeUndefined()
  })

  test('deleteSparql and deleteObject remove their records', async () => {
    const storage = fakeStorage()
    const store = new PodEndpointStore(storage as any, webIdStore as any)
    await store.handle()
    await store.createSparql(registrySparql)
    await store.createObject(dataObject)

    const [sparql] = await store.findSparqlByAccountId('acc')
    await store.deleteSparql(sparql.id)
    const [object] = await store.findObjectByAccountId('acc')
    await store.deleteObject(object.id)

    expect(await store.findSparqlByPodUrl('https://registry/alice/')).toBeUndefined()
    expect(await store.findObjectByPodUrl('https://data/alice-home/')).toBeUndefined()
  })

  test('resolving by WebID requires the WebID store', async () => {
    const storage = fakeStorage()
    const store = new PodEndpointStore(storage as any)
    await store.handle()

    await expect(store.findSparqlByWebId('https://id/alice')).rejects.toThrow('WebID store')
  })
})

describe('PodEndpointStore.findSparqlByIri', () => {
  // two data pods where one pod URL is a prefix of the other — longest prefix wins
  const dataRoot = {
    accountId: 'acc',
    podUrl: 'https://data/alice/',
    endpoint: 'http://fuseki:3030/data-alice/sparql',
  }
  const dataWork = {
    accountId: 'acc',
    podUrl: 'https://data/alice/work/',
    endpoint: 'http://fuseki:3030/data-alice-work/sparql',
  }

  async function storeWithRecords() {
    const storage = fakeStorage()
    const store = new PodEndpointStore(storage as any, webIdStore as any)
    await store.handle()
    await store.createSparql(registrySparql)
    await store.createSparql(dataRoot)
    await store.createSparql(dataWork)
    return store
  }

  test('resolves a registry resource to its registry pod', async () => {
    const store = await storeWithRecords()
    expect((await store.findSparqlByIri('https://registry/alice/x'))?.podUrl).toBe(
      'https://registry/alice/'
    )
  })

  test('matches the exact pod URL', async () => {
    const store = await storeWithRecords()
    expect((await store.findSparqlByIri('https://registry/alice/'))?.endpoint).toBe(
      'http://fuseki:3030/reg-alice/sparql'
    )
  })

  test('prefers the longest matching pod URL', async () => {
    const store = await storeWithRecords()
    expect((await store.findSparqlByIri('https://data/alice/work/note/1'))?.podUrl).toBe(
      'https://data/alice/work/'
    )
    expect((await store.findSparqlByIri('https://data/alice/other/1'))?.podUrl).toBe(
      'https://data/alice/'
    )
  })

  test('returns undefined for an unknown IRI or an empty string', async () => {
    const store = await storeWithRecords()
    expect(await store.findSparqlByIri('https://elsewhere.example/')).toBeUndefined()
    expect(await store.findSparqlByIri('')).toBeUndefined()
  })
})
