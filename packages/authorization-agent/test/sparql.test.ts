import { describe, expect, test } from 'vitest'

import { listContained } from '../src/sparql'
import type { SparqlTransport } from '../src/sparql'

const container = 'https://registry.example/alice/grant/'

function transportReturning(children: Array<string>): SparqlTransport {
  return {
    async fetchBindings(query: string) {
      expect(query).toContain(`GRAPH <meta:${container}>`)
      return children.map((child) => ({ child: { termType: 'NamedNode', value: child } }))
    },
    async fetchTriples() {
      throw new Error('not used')
    },
  } as SparqlTransport
}

describe('listContained', () => {
  test('drops auxiliary members from the flat lws:contains listing', async () => {
    const children = await listContained(
      transportReturning([
        `${container}one`,
        `${container}one.acr`,
        `${container}two`,
        `${container}two.meta`,
      ]),
      container
    )
    expect(children).toEqual([`${container}one`, `${container}two`])
  })
})
