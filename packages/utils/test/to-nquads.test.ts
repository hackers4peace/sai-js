import { describe, expect, test } from 'vitest'

import { jsonld, toNQuads } from '../src'

/** Parse N-Quads text the way the codebase reads RDF: jsonld.fromRDF → expanded JSON-LD. */
const fromNQuads = (text: string): Promise<Array<any>> =>
  jsonld.fromRDF(text, { format: 'application/n-quads' })

const context = {
  id: '@id',
  knows: { '@id': 'https://example.example/vocab#knows', '@type': '@id' },
  name: 'https://example.example/vocab#name',
  count: 'https://example.example/vocab#count',
  active: 'https://example.example/vocab#active',
}

describe('toNQuads', () => {
  test('default-graph document serializes as N-Triples (no graph label)', async () => {
    const doc = {
      '@context': context,
      id: 'https://example.example/alice',
      knows: 'https://example.example/bob',
      name: 'Alice',
    }

    const nquads = await toNQuads(doc)
    const nodes = await fromNQuads(nquads)

    // a 4th term would come back wrapped as { '@id': graph, '@graph': [...] }
    expect(nodes.some((node) => '@graph' in node)).toBe(false)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]['@id']).toBe('https://example.example/alice')
  })

  test('plain string literal stays plain (no xsd:string datatype)', async () => {
    const doc = { '@context': context, id: 'https://example.example/alice', name: 'Alice' }

    const nquads = await toNQuads(doc)

    expect(nquads).toContain('"Alice"')
    expect(nquads).not.toContain('xsd:string')
    expect(nquads).not.toContain('XMLSchema#string')
  })

  test('JS number and boolean coerce to xsd:integer / xsd:boolean', async () => {
    const doc = {
      '@context': context,
      id: 'https://example.example/alice',
      count: 42,
      active: true,
    }

    const nquads = await toNQuads(doc)

    expect(nquads).toContain('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')
    expect(nquads).toContain('"true"^^<http://www.w3.org/2001/XMLSchema#boolean>')
  })

  test('IRI-valued term needs @type: @id (otherwise it is a literal)', async () => {
    const withCoercion = {
      '@context': context,
      id: 'https://example.example/alice',
      knows: 'https://example.example/bob',
    }
    const withoutCoercion = {
      '@context': { id: '@id', knows: 'https://example.example/vocab#knows' },
      id: 'https://example.example/alice',
      knows: 'https://example.example/bob',
    }

    expect(await toNQuads(withCoercion)).toContain('<https://example.example/bob>')
    expect(await toNQuads(withoutCoercion)).toContain('"https://example.example/bob"')
  })

  test('document without properties serializes to an empty string', async () => {
    expect(await toNQuads({})).toBe('')
    expect(await toNQuads({ '@context': context, id: 'https://example.example/empty' })).toBe('')
  })

  test('resolves relative IRIs against the provided base', async () => {
    const doc = { '@context': context, id: 'alice', name: 'Alice' }

    const nquads = await toNQuads(doc, 'https://base.example/dir/')

    expect(nquads).toContain('<https://base.example/dir/alice>')
  })

  test('named-graph document carries the graph label in the 4th term', async () => {
    const doc = {
      '@id': 'https://example.example/graph',
      '@graph': [
        {
          '@id': 'https://example.example/s',
          'https://example.example/vocab#p': [{ '@id': 'https://example.example/o' }],
        },
      ],
    }

    const nquads = await toNQuads(doc)
    const nodes = await fromNQuads(nquads)

    expect(nodes).toHaveLength(1)
    expect(nodes[0]['@id']).toBe('https://example.example/graph')
    expect(nodes[0]['@graph']).toHaveLength(1)
    expect(nodes[0]['@graph'][0]['@id']).toBe('https://example.example/s')
  })
})
