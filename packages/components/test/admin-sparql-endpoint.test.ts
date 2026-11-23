import { ForbiddenHttpError } from '@solid/community-server'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

// The admin gate needs real sessions; this test only pins WHICH query source
// the handler targets, so the gate is stubbed out.
vi.mock('../src/services/adminGate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AdminGate>()
  return { ...actual, requireOrgAdmin: vi.fn(async () => ({})) }
})

import { AdminSparqlHandler, podFromRequestUrl } from '../src/AdminSparqlHandler.js'
import type { SparqlEndpointRecord } from '../src/PodEndpointStore.js'
import type * as AdminGate from '../src/services/adminGate.js'

// registryId() derives the registry pod URL from the environment origins
const originalOrigins = { id: process.env.CSS_ID_ORIGIN, reg: process.env.CSS_REG_ORIGIN }
beforeAll(() => {
  process.env.CSS_ID_ORIGIN = 'id'
  process.env.CSS_REG_ORIGIN = 'registry'
})
afterAll(() => {
  process.env.CSS_ID_ORIGIN = originalOrigins.id
  process.env.CSS_REG_ORIGIN = originalOrigins.reg
})

const records: Array<SparqlEndpointRecord> = [
  {
    id: 'acme-reg',
    accountId: 'acme',
    podUrl: 'https://registry/acme/',
    endpoint: 'http://fuseki:3030/reg-acme/sparql',
  },
  {
    id: 'acme-data',
    accountId: 'acme',
    podUrl: 'https://data/acme-rnd/',
    endpoint: 'http://fuseki:3030/data-acme-rnd/sparql',
  },
  {
    id: 'yoyo-data',
    accountId: 'yoyo',
    podUrl: 'https://data/yoyo-eu/',
    endpoint: 'http://fuseki:3030/data-yoyo-eu/sparql',
  },
]

const store = {
  findSparqlByPodUrl: async (podUrl: string) => records.find((record) => record.podUrl === podUrl),
} as never

const accounts: Record<string, string> = {
  'https://id/acme': 'acme',
  'https://id/yoyo': 'yoyo',
}
const webIdStore = {
  findAccount: async (webId: string) => accounts[webId],
} as never

/** `resolveEndpoint` is private — the ownership rule is exercised directly. */
function resolve(orgWebId: string, podUrl?: string): Promise<string> {
  const handler = new AdminSparqlHandler(
    {} as never,
    {} as never,
    store,
    webIdStore
  ) as unknown as {
    resolveEndpoint(org: string, pod?: string): Promise<string>
  }
  return handler.resolveEndpoint(orgWebId, podUrl)
}

describe('AdminSparqlHandler endpoint resolution', () => {
  test('defaults to the org registry pod', async () => {
    await expect(resolve('https://id/acme')).resolves.toBe('http://fuseki:3030/reg-acme/sparql')
  })

  test('resolves another pod owned by the same org', async () => {
    await expect(resolve('https://id/acme', 'https://data/acme-rnd/')).resolves.toBe(
      'http://fuseki:3030/data-acme-rnd/sparql'
    )
  })

  test('rejects a pod owned by another account (403)', async () => {
    await expect(resolve('https://id/acme', 'https://data/yoyo-eu/')).rejects.toBeInstanceOf(
      ForbiddenHttpError
    )
  })

  test('rejects an unknown pod (403)', async () => {
    await expect(resolve('https://id/acme', 'https://data/does-not-exist/')).rejects.toBeInstanceOf(
      ForbiddenHttpError
    )
  })

  test('fails closed when the org has no registry record', async () => {
    await expect(resolve('https://id/nobody')).rejects.toThrow(
      'no registry-pod SPARQL endpoint for https://id/nobody'
    )
  })
})

describe('AdminSparqlHandler data-pod targeting', () => {
  test('`?pod=` is read from the raw request URL (the target path carries no query)', () => {
    const orgSegment = Buffer.from('https://id/yoyo').toString('base64url')
    const requestUrl = `/.sai/sparql-admin/${orgSegment}?pod=${encodeURIComponent('https://data/yoyo-na/')}`
    expect(podFromRequestUrl(requestUrl)).toBe('https://data/yoyo-na/')
    // the deployment's TargetExtractor strips query strings — the path alone
    // must not be mistaken for a data-pod target
    expect(podFromRequestUrl(`https://auth/.sai/sparql-admin/${orgSegment}`)).toBeUndefined()
    expect(podFromRequestUrl(undefined)).toBeUndefined()
  })

  test('handle targets the `?pod=` dataset, not the org registry pod', async () => {
    const handler = new AdminSparqlHandler({} as never, {} as never, store, webIdStore)
    // stop after endpoint resolution: the assertion is the resolution argument
    const resolveEndpoint = vi
      .spyOn(
        handler as unknown as { resolveEndpoint: (org: string, pod?: string) => Promise<string> },
        'resolveEndpoint'
      )
      .mockRejectedValue(new Error('sentinel: stop before the SPARQL fetch'))
    const orgSegment = Buffer.from('https://id/yoyo').toString('base64url')

    const operation = {
      method: 'QUERY',
      // the deployment strips the query from the target identifier
      target: { path: `https://auth/.sai/sparql-admin/${orgSegment}` },
    }
    const request = {
      url: `/.sai/sparql-admin/${orgSegment}?pod=${encodeURIComponent('https://data/yoyo-na/')}`,
      headers: {},
    }

    await expect(
      handler.handle({ operation, request } as unknown as Parameters<typeof handler.handle>[0])
    ).rejects.toThrow('sentinel')
    expect(resolveEndpoint).toHaveBeenCalledWith('https://id/yoyo', 'https://data/yoyo-na/')
  })
})
