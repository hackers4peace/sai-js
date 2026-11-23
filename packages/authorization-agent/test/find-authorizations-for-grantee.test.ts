import { ACCESS_ACTIONS, INTEROP, LDP, LWS } from '@janeirodigital/interop-utils'
import type { SparqlTransport } from '@janeirodigital/interop-utils'
import { DataFactory, Store } from 'n3'
import type { Quad } from 'n3'
import { describe, expect, test } from 'vitest'

import { findAuthorizationsForGrantee } from '../src/sparql.js'

const { namedNode, quad } = DataFactory

const AUTHORIZATION_REGISTRY = 'https://registry/yoyo/authorization/'
const ROLE_REGISTRY = 'https://registry/yoyo/role/'
const GRANTEE = 'https://id/bob'
const GRANTED_BY = 'https://id/yoyo'
const PRESENT = 'https://registry/yoyo/present'
const VANISHED = 'https://registry/yoyo/vanished'

const registrySet = {
  hasAuthorizationRegistry: { id: AUTHORIZATION_REGISTRY },
  hasRoleRegistry: { id: ROLE_REGISTRY },
} as never

function dataAuthorizationGraph(id: string): Array<Quad> {
  return [
    quad(
      namedNode(id),
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode(INTEROP.DataAuthorization)
    ),
    quad(namedNode(id), namedNode(INTEROP.grantee), namedNode(GRANTEE)),
    quad(namedNode(id), namedNode(INTEROP.grantedBy), namedNode(GRANTED_BY)),
    quad(
      namedNode(id),
      namedNode(INTEROP.registeredShapeTree),
      namedNode('https://shapetrees.example/Project')
    ),
    quad(namedNode(id), namedNode(INTEROP.scopeOfAuthorization), namedNode(INTEROP.AllFromAgent)),
    quad(namedNode(id), namedNode(INTEROP.accessMode), namedNode(ACCESS_ACTIONS.read)),
  ]
}

/**
 * The registry read is two queries: `listContained` (container membership) and
 * one `graphDoc` per listed IRI. A concurrent revoke deletes the DA between
 * them, so the listing still names an IRI whose graph CONSTRUCTs empty.
 * `findAuthorizationsForGrantee` must skip that row, not fail the whole read
 * (a UI ListAuthorizations right after a revoke raced exactly this).
 */
function racingTransport(): SparqlTransport {
  const graphs = new Map<string, Array<Quad>>([
    [
      AUTHORIZATION_REGISTRY,
      [
        quad(namedNode(AUTHORIZATION_REGISTRY), namedNode(LDP.contains), namedNode(PRESENT)),
        quad(namedNode(AUTHORIZATION_REGISTRY), namedNode(LDP.contains), namedNode(VANISHED)),
      ],
    ],
    [PRESENT, dataAuthorizationGraph(PRESENT)],
    // VANISHED was deleted after `listContained` returned its IRI
  ])

  return {
    async fetchBindings(query: string) {
      if (query.includes('FILTER(?g = ?role)')) {
        return []
      }
      if (query.includes(LWS.contains)) {
        const container =
          /GRAPH <meta:([^>]+)>/.exec(query)?.[1] ?? /GRAPH <([^>]+)>/.exec(query)![1]
        return (graphs.get(container) ?? [])
          .filter((entry) => entry.predicate.value === LDP.contains)
          .map((entry) => ({ child: { value: entry.object.value } })) as never
      }
      throw new Error(`unhandled bindings query\n${query}`)
    },
    async fetchTriples(query: string) {
      const store = new Store()
      for (const match of query.matchAll(/GRAPH <([^>]+)>/g)) {
        for (const entry of graphs.get(match[1]) ?? []) {
          store.addQuad(entry)
        }
      }
      return store
    },
  } as unknown as SparqlTransport
}

describe('findAuthorizationsForGrantee', () => {
  test('skips an authorization deleted between container listing and graph read', async () => {
    const result = await findAuthorizationsForGrantee(racingTransport(), registrySet, GRANTEE)
    expect(result.map((authorization) => authorization.id)).toEqual([PRESENT])
  })
})
