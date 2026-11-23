import { INTEROP } from '@janeirodigital/interop-utils'
import { DataFactory, Store } from 'n3'
import { describe, expect, test } from 'vitest'

import { type SparqlTransport, getRole } from '../src/sparql.js'

const ROLE_IRI = 'https://registry/kim/r1'
// in dev the app's client-id document lives at the application IRI — a
// tax-paying graph that must NOT resolve as a role
const CLIENT_ID_IRI = 'https://vuejectron.docker/id'

/** A fake transport serving the given triples for ANY graphDoc CONSTRUCT. */
function storeTransport(...quads: Array<ReturnType<typeof DataFactory.quad>>): SparqlTransport {
  const store = new Store()
  store.addQuads(quads)
  return {
    fetchBindings: async () => [],
    fetchTriples: async () => store,
  } as unknown as SparqlTransport
}

describe('getRole — type-guarded', () => {
  test('returns the role when the graph is role-typed', async () => {
    const transport = storeTransport(
      DataFactory.quad(
        DataFactory.namedNode(ROLE_IRI),
        DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        DataFactory.namedNode(INTEROP.Role)
      ),
      DataFactory.quad(
        DataFactory.namedNode(ROLE_IRI),
        DataFactory.namedNode('http://www.w3.org/2004/02/skos/core#prefLabel'),
        DataFactory.literal('Managers')
      )
    )
    const role = await getRole(transport, ROLE_IRI)
    // the framed type may be the compact or the expanded form — the guard
    // accepts both; assert either
    expect(role?.type.some((t) => t === 'Role' || t === INTEROP.Role)).toBe(true)
    expect(role?.label).toEqual({ '@none': 'Managers' })
  })

  test('returns undefined for a NON-role graph at the IRI (the app client-id case)', async () => {
    // the dev regression: typeGrantee resolved an APPLICATION as `Role`
    // because the app's client-id document graph is non-empty and the old
    // getRole framed ANY document — the Role branch then won before the
    // auto-registration fallback ever ran
    const transport = storeTransport(
      DataFactory.quad(
        DataFactory.namedNode(CLIENT_ID_IRI),
        DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        DataFactory.namedNode(INTEROP.ApplicationRegistration)
      ),
      DataFactory.quad(
        DataFactory.namedNode(CLIENT_ID_IRI),
        DataFactory.namedNode('http://www.w3.org/ns/solid/oidc#client_name'),
        DataFactory.literal('Test client')
      )
    )
    expect(await getRole(transport, CLIENT_ID_IRI)).toBeUndefined()
  })

  test('returns undefined when no graph exists at the IRI', async () => {
    expect(await getRole(storeTransport(), ROLE_IRI)).toBeUndefined()
  })
})
