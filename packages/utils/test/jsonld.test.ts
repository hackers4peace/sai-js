import { describe, expect, test, vi } from 'vitest'

import {
  HttpStatusError,
  accessClaimTerms,
  buildFrame,
  containedIrisJsonLd,
  documentValues,
  expandedJsonLd,
  fetchJsonLd,
  findNodeIdByType,
  frameDoc,
  frameFor,
  frameNode,
  lwsV1Context,
} from '../src'
import type { WhatwgFetch } from '../src'

/**
 * Fetch double. `url` models the response's final URL, which `fetchJsonLd`
 * uses as the base IRI — a double without it is exactly what the no-url guard
 * rejects.
 */
function mockFetch(response: Partial<Response> & { ok: boolean }, url = ''): WhatwgFetch {
  return vi.fn(async () => ({ url, ...response })) as unknown as WhatwgFetch
}

const RESOURCE = 'https://example.example/resource'
const TYPE = 'https://example.example/Thing'
const NAME = 'https://example.example/name'

describe('fetchJsonLd', () => {
  test('requests the LWS JSON-LD profile and returns the expanded document', async () => {
    const doc = { '@id': RESOURCE, '@type': [TYPE] }
    const fetch = vi.fn(async () => ({
      ok: true,
      url: RESOURCE,
      json: async () => doc,
    })) as unknown as WhatwgFetch
    const result = await fetchJsonLd(RESOURCE, fetch)
    expect(result).toEqual([{ '@id': RESOURCE, '@type': [TYPE] }])
    expect(fetch).toHaveBeenCalledWith(RESOURCE, {
      headers: { Accept: 'application/ld+json; profile="https://www.w3.org/ns/lws/v1"' },
    })
  })

  test('resolves document-relative IRIs against the final response url', async () => {
    const final = 'https://example.example/documents/1'
    const doc = {
      '@context': {
        id: '@id',
        knows: { '@id': 'https://example.example/vocab#knows', '@type': '@id' },
      },
      id: '#me',
      knows: 'bob',
    }
    const fetch = mockFetch({ ok: true, json: async () => doc }, final)
    const result = await fetchJsonLd('https://example.example/requested', fetch)
    expect(result).toEqual([
      {
        '@id': `${final}#me`,
        'https://example.example/vocab#knows': [{ '@id': 'https://example.example/documents/bob' }],
      },
    ])
  })

  test('throws when the response carries no url', async () => {
    const fetch = mockFetch({ ok: true, json: async () => ({ '@id': RESOURCE }) })
    await expect(fetchJsonLd(RESOURCE, fetch)).rejects.toThrow(
      `fetch response for ${RESOURCE} has no url`
    )
  })

  test('throws when a relative IRI survives expansion', async () => {
    // `@base: null` suppresses resolution even though fetchJsonLd passes one
    const doc = {
      '@context': { '@base': null, id: '@id', name: 'https://example.example/name' },
      id: '#me',
      name: 'Alice',
    }
    const fetch = mockFetch({ ok: true, json: async () => doc }, RESOURCE)
    await expect(fetchJsonLd(RESOURCE, fetch)).rejects.toThrow(`relative IRI #me in ${RESOURCE}`)
  })

  test('falls back to plain application/ld+json when the profile is not supported', async () => {
    const doc = { '@id': RESOURCE, '@type': [TYPE] }
    const fetch = vi.fn(async (_iri: string, init?: RequestInit) =>
      init?.headers && (init.headers as Record<string, string>).Accept.includes('profile')
        ? { ok: false, status: 406 }
        : { ok: true, url: RESOURCE, json: async () => doc }
    ) as unknown as WhatwgFetch
    const result = await fetchJsonLd(RESOURCE, fetch)
    expect(result).toEqual([{ '@id': RESOURCE, '@type': [TYPE] }])
    expect(fetch).toHaveBeenLastCalledWith(RESOURCE, {
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
    const error = await fetchJsonLd('https://example.example/gone', fetch).catch(
      (error_: unknown) => error_
    )
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

describe('containedIrisJsonLd', () => {
  const container = 'https://example.example/registry/grant/'
  const doc = [
    {
      '@id': container,
      'http://www.w3.org/ns/ldp#contains': [{ '@id': `${container}hierarchical` }],
      'https://www.w3.org/ns/lws#contains': [
        { '@id': `${container}flat` },
        { '@id': `${container}flat.acr` },
        { '@id': `${container}flat.meta` },
      ],
    },
  ]

  test('unions ldp:contains with lws:contains and drops auxiliary members', async () => {
    const fetch = mockFetch({ ok: true, json: async () => doc }, container)
    const iris = await containedIrisJsonLd(container, fetch)
    expect(iris).toEqual([`${container}hierarchical`, `${container}flat`])
  })
})

describe('buildFrame', () => {
  const context = {
    '@version': 1.1,
    id: '@id',
    type: { '@id': '@type', '@container': '@set' },
    forward: { '@id': 'https://example.example/forward', '@type': '@id', '@container': '@set' },
    reverse: {
      '@reverse': 'https://example.example/child',
      '@type': '@id',
      '@container': '@set',
    },
    vocab: {
      '@id': 'https://example.example/vocab',
      '@type': '@vocab',
      '@container': '@set',
    },
    single: { '@id': 'https://example.example/single', '@type': '@id' },
    label: { '@id': 'https://example.example/label', '@container': '@language' },
  }

  test('set containers rely on the container, everything else omits the default', () => {
    const frame = buildFrame(context, 'https://example.example/a')
    expect(frame.forward).toEqual({ '@embed': '@never' })
    expect(frame.reverse).toEqual({ '@embed': '@never', '@omitDefault': true })
    expect(frame.vocab).toEqual({ '@embed': '@never', '@omitDefault': true })
    expect(frame.single).toEqual({ '@embed': '@never', '@omitDefault': true })
    // aliases, keywords and language maps carry no frame entry
    expect(frame).not.toHaveProperty('id')
    expect(frame).not.toHaveProperty('type')
    expect(frame).not.toHaveProperty('label')
    expect(frame).not.toHaveProperty('@version')
  })

  test('overrides merge over the computed entry', () => {
    const frame = buildFrame(context, 'https://example.example/a', {
      single: { '@embed': '@always' },
      forward: { '@embed': '@always' },
    })
    expect(frame.single).toEqual({ '@embed': '@always', '@omitDefault': true })
    expect(frame.forward).toEqual({ '@embed': '@always' })
  })

  test('absent set terms frame as [], an overridden single term stays omitted', async () => {
    const doc = [
      {
        '@id': 'https://example.example/a',
        'https://example.example/forward': [{ '@id': 'https://example.example/b' }],
      },
    ]
    const framed = await frameDoc(doc, context, 'https://example.example/a', {
      single: { '@embed': '@always' },
    })
    expect(framed.forward).toEqual(['https://example.example/b'])
    // @reverse and @vocab terms get no container default — they stay omitted
    expect('reverse' in framed).toBe(false)
    expect('vocab' in framed).toBe(false)
    expect('single' in framed).toBe(false)
    expect(Object.values(framed)).not.toContain(null)
  })
})

describe('expandedJsonLd', () => {
  test('throws on a relative IRI in a write payload', async () => {
    await expect(
      expandedJsonLd({ '@context': { id: '@id', name: NAME }, id: '#fragment', name: 'Alice' })
    ).rejects.toThrow('relative IRI #fragment in write payload')
  })

  test('keeps blank node identifiers', async () => {
    await expect(
      expandedJsonLd({ '@context': { id: '@id', name: NAME }, id: '_:a', name: 'Alice' })
    ).resolves.toEqual([{ '@id': '_:a', [NAME]: [{ '@value': 'Alice' }] }])
  })
})

describe('bundled LWS context', () => {
  const scopedContext = (term: string) =>
    (
      lwsV1Context['@context'] as unknown as Record<string, { '@context': Record<string, unknown> }>
    )[term]['@context']

  test('AccessGrant/AccessRequest scoped contexts keep the composed containers', () => {
    for (const term of ['AccessGrant', 'AccessRequest']) {
      expect(scopedContext(term).type).toEqual(accessClaimTerms.type)
      expect(scopedContext(term).access).toEqual(accessClaimTerms.access)
    }
  })
})

describe('frameFor / frameNode with a term list', () => {
  const context = {
    '@version': 1.1,
    id: '@id',
    type: { '@id': '@type', '@container': '@set' },
    label: { '@id': 'https://example.example/label', '@container': '@language' },
    name: { '@id': 'https://example.example/name' },
    forward: { '@id': 'https://example.example/forward', '@type': '@id', '@container': '@set' },
    reverse: {
      '@reverse': 'https://example.example/child',
      '@type': '@id',
      '@container': '@set',
    },
    single: { '@id': 'https://example.example/single', '@type': '@id' },
    unused: { '@id': 'https://example.example/unused', '@type': '@id', '@container': '@set' },
  }
  const iri = 'https://example.example/a'
  const foreign = 'https://example.example/foreign'

  test('frames only the listed terms, with @explicit', () => {
    const frame = frameFor(context, iri, ['name', 'forward', 'single', 'type'])
    expect(frame['@explicit']).toBe(true)
    expect(Object.keys(frame)).toEqual([
      '@context',
      '@id',
      '@explicit',
      'name',
      'forward',
      'single',
    ])
    expect(frame.forward).toEqual({ '@embed': '@never' })
    expect(frame.single).toEqual({ '@embed': '@never', '@omitDefault': true })
  })

  test('throws for an undefined term and for a language-map term', () => {
    expect(() => frameFor(context, iri, ['nope'])).toThrow(
      'frame term nope is not defined in the context'
    )
    expect(() => frameFor(context, iri, ['label'])).toThrow(
      '@explicit cannot frame the language-map term label'
    )
  })

  test('drops foreign and non-listed properties, keeps id/type and the set defaults', async () => {
    const doc = [
      {
        '@id': iri,
        '@type': ['https://example.example/Thing'],
        'https://example.example/name': [{ '@value': 'A' }],
        'https://example.example/forward': [{ '@id': 'https://example.example/b' }],
        [foreign]: [{ '@value': 'leaks without @explicit' }],
      },
    ]
    const node = await frameNode(doc, context, iri, {
      terms: ['name', 'forward', 'reverse', 'single'],
    })
    expect(node).toEqual({
      id: iri,
      type: ['https://example.example/Thing'],
      name: 'A',
      forward: ['https://example.example/b'],
      // absent set terms are still filled — @explicit omits the reverse shape
      reverse: [],
    })
    expect(Object.keys(node).some((key) => key.includes('http'))).toBe(false)
    expect(node).not.toHaveProperty(foreign)
    expect(node).not.toHaveProperty('unused')
  })

  test('an override keeps the omit-default rule for an absent single term', async () => {
    const node = await frameNode(
      [{ '@id': iri, '@type': ['https://example.example/Thing'] }],
      context,
      iri,
      {
        terms: ['single'],
        overrides: { single: { '@embed': '@always' } },
      }
    )
    expect(node).not.toHaveProperty('single')
    expect(node).not.toHaveProperty('single', null)
  })
})
