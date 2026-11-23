import { beforeEach, describe, expect, test, vi } from 'vitest'

import { applyPatch, deletePatch, insertPatch, jsonld, replaceStatement, withContext } from '../src'
import type { WhatwgFetch } from '../src'

const context = {
  id: '@id',
  thinks: { '@id': 'https://vocab.example/thinks', '@type': '@id' },
}

const iri = 'https://work.alice.example/something/'
const doc = withContext(context, { id: iri, thinks: `${iri}boop` })

/** The triples inside an `INSERT DATA { … }` / `DELETE DATA { … }` block, as expanded JSON-LD. */
const blockExpanded = (patch: string): Promise<Array<any>> =>
  jsonld.fromRDF(patch.replace(/^\w+ DATA \{ /, '').replace(/ \}$/, ''), {
    format: 'application/n-quads',
  })

// Local stub: answers HEAD/PATCH with ok and a describedby Link header —
// keeps utils free of a dependency on interop-test-utils (which depends on
// utils, so a devDep here would create a workspace dependency cycle).
const fetch: WhatwgFetch = async () =>
  ({
    ok: true,
    headers: {
      get: (name: string) =>
        name === 'Link'
          ? '<http://just.en.example/description-resource>; rel="describedby"'
          : undefined,
    },
    text: async () => '',
    status: 200,
  }) as unknown as Response

const mockedFetch = vi.fn(fetch)

beforeEach(() => {
  mockedFetch.mockClear()
})

test('insertPatch wraps the document as an INSERT DATA block', async () => {
  const patch = await insertPatch(doc)

  expect(patch.startsWith('INSERT DATA { ')).toBe(true)
  expect(patch.endsWith(' }')).toBe(true)
  const [node] = await blockExpanded(patch)
  expect(node['@id']).toBe(iri)
  expect(node['https://vocab.example/thinks']).toEqual([{ '@id': `${iri}boop` }])
})

test('deletePatch wraps the document as a DELETE DATA block', async () => {
  const patch = await deletePatch(doc)

  expect(patch.startsWith('DELETE DATA { ')).toBe(true)
  expect(patch.endsWith(' }')).toBe(true)
  const [node] = await blockExpanded(patch)
  expect(node['@id']).toBe(iri)
})

test('empty set serializes to an empty data block', async () => {
  const patch = await deletePatch(withContext(context, { id: iri, thinks: [] }))

  expect(patch).toBe('DELETE DATA {  }')
})

describe('replaceStatement', () => {
  test('calls a single patch with delete followed by insert', async () => {
    const priorDoc = withContext(context, { id: iri, thinks: `${iri}beep` })
    const withDoc = withContext(context, { id: iri, thinks: `${iri}boop` })

    await replaceStatement(iri, mockedFetch as never, priorDoc, withDoc)

    expect(mockedFetch).toBeCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringMatching(/DELETE DATA[\s\S]*INSERT DATA/),
      })
    )
  })
})

describe('applyPatch', () => {
  test('throws if failed to patch', async () => {
    const sparqlUpdate = await insertPatch(doc)
    mockedFetch.mockResolvedValueOnce({ ok: false } as unknown as Response)

    await expect(
      applyPatch(iri, mockedFetch as never, sparqlUpdate, `${iri}.meta`)
    ).rejects.toThrow('failed to patch')
  })
})
