import { describe, expect, test, vi } from 'vitest'

import {
  type WhatwgFetch,
  HttpStatusError,
  documentValues,
  fetchJsonLd,
  findNodeIdByType,
  linkedIrisJsonLd,
} from '../src'

function mockFetch(response: Partial<Response> & { ok: boolean }): WhatwgFetch {
  return vi.fn(async () => response) as unknown as WhatwgFetch
}

describe('fetchJsonLd', () => {
  test('requests application/ld+json and returns the parsed document', async () => {
    const doc = { '@id': 'https://example.example/resource' }
    const fetch = vi.fn(async () => ({ ok: true, json: async () => doc })) as unknown as WhatwgFetch
    const result = await fetchJsonLd('https://example.example/resource', fetch)
    expect(result).toEqual(doc)
    expect(fetch).toHaveBeenCalledWith('https://example.example/resource', {
      headers: { Accept: 'application/ld+json' },
    })
  })

  test('throws when the request fails', async () => {
    const fetch = mockFetch({ ok: false, status: 404 })
    await expect(fetchJsonLd('https://example.example/missing', fetch)).rejects.toThrow(
      'failed to fetch https://example.example/missing: 404'
    )
  })

  test('carries the status so callers can classify the failure', async () => {
    const fetch = mockFetch({ ok: false, status: 410 })
    const error = await fetchJsonLd('https://example.example/gone', fetch).catch((err) => err)
    expect(error).toBeInstanceOf(HttpStatusError)
    expect(error).toMatchObject({ iri: 'https://example.example/gone', status: 410 })
  })
})

describe('documentValues', () => {
  const predicate = 'https://example.example/vocab#knows'
  const doc = [
    {
      '@id': 'https://example.example/alice',
      [predicate]: [{ '@id': 'https://example.example/bob' }],
    },
    {
      '@id': 'https://example.example/other',
      [predicate]: [{ '@value': 'literal value' }],
    },
  ]

  test('collects node references and literals across all nodes', async () => {
    const values = await documentValues(doc, 'https://example.example/alice', predicate)
    expect(values).toEqual(['https://example.example/bob', 'literal value'])
  })

  test('returns an empty array when the predicate is absent', async () => {
    const values = await documentValues(
      doc,
      'https://example.example/alice',
      'https://absent.example/pred'
    )
    expect(values).toEqual([])
  })
})

describe('findNodeIdByType', () => {
  const typeIri = 'http://www.w3.org/ns/pim/space#Storage'
  const doc = [
    {
      '@id': 'https://example.example/storage',
      '@type': [typeIri],
    },
  ]

  test('returns the @id of the node with the given type', async () => {
    const id = await findNodeIdByType(doc, typeIri, 'https://example.example/description')
    expect(id).toBe('https://example.example/storage')
  })

  test('throws when no node has the given type', async () => {
    await expect(findNodeIdByType(doc, 'https://absent.example/type')).rejects.toThrow(
      'no node of type https://absent.example/type in document'
    )
  })
})

describe('linkedIrisJsonLd', () => {
  const property = 'http://www.w3.org/ns/ldp#contains'
  const container = 'https://example.example/container/'
  const doc = [
    {
      '@id': container,
      [property]: [
        { '@id': 'https://example.example/container/a' },
        { '@id': 'https://example.example/container/b' },
      ],
    },
  ]

  test('collects the IRI values of the given property', async () => {
    const fetch = mockFetch({ ok: true, json: async () => doc })
    const iris = await linkedIrisJsonLd(container, fetch, property)
    expect(iris).toEqual([
      'https://example.example/container/a',
      'https://example.example/container/b',
    ])
  })

  test('yields [] when the property is absent', async () => {
    const fetch = mockFetch({ ok: true, json: async () => doc })
    const iris = await linkedIrisJsonLd(container, fetch, 'https://example.example/vocab#missing')
    expect(iris).toEqual([])
  })
})
