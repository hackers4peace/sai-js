import { INTEROP, LDP, RDF } from '@janeirodigital/interop-utils'
import { DataFactory, type Quad, Store } from 'n3'
import { describe, expect, test } from 'vitest'

import { type SparqlTransport, getReciprocalGrants } from '../src/sparql.js'

const { namedNode, quad } = DataFactory

const RECIPROCAL = 'https://registry/alice/social-agent/r-acme'
const G1 = 'https://registry/alice/grant/g1'
const G2 = 'https://registry/alice/grant/g2'
const CHILD = 'https://registry/alice/grant/g-child'
const TREE = 'https://data/shapetrees/trees/Project'

const registrationGraph = (links: string[]): Quad[] =>
  links.map((grant) =>
    quad(namedNode(RECIPROCAL), namedNode(INTEROP.hasDataGrant), namedNode(grant))
  )

const grantGraph = (id: string, over: { tree?: string; owner?: string } = {}): Quad[] => [
  quad(namedNode(id), namedNode(RDF.type), namedNode(INTEROP.DataGrant)),
  quad(namedNode(id), namedNode(INTEROP.registeredShapeTree), namedNode(over.tree ?? TREE)),
  quad(namedNode(id), namedNode(INTEROP.dataOwner), namedNode(over.owner ?? 'https://id/alice')),
  quad(namedNode(id), namedNode(INTEROP.grantee), namedNode('https://id/acme')),
  quad(namedNode(id), namedNode(INTEROP.grantedBy), namedNode('https://id/alice')),
  quad(
    namedNode(id),
    namedNode(INTEROP.hasDataRegistration),
    namedNode('https://data/alice/registrations/p')
  ),
  quad(namedNode(id), namedNode(INTEROP.hasStorage), namedNode('https://data/alice/')),
  quad(namedNode(id), namedNode(INTEROP.scopeOfGrant), namedNode(INTEROP.AllFromRegistry)),
  quad(namedNode(id), namedNode(INTEROP.accessMode), namedNode(INTEROP.Read)),
]

/**
 * A transport that serves named graphs from a map and records the queries, so
 * the batching contract (two queries per registration, regardless of the link
 * count) is observable.
 */
function graphTransport(graphs: Map<string, Quad[]>): SparqlTransport & { queries: string[] } {
  const queries: string[] = []
  const clone = (source: Quad): Quad =>
    quad(
      namedNode(source.subject.value),
      namedNode(source.predicate.value),
      namedNode(source.object.value)
    )
  return {
    queries,
    async fetchBindings(query: string) {
      queries.push(query)
      // the link-set query: `graphDoc`'s union, resource graph + meta twin
      const names = [...query.matchAll(/GRAPH <([^>]+)>/g)].map((match) => match[1])
      const seen = new Set<string>()
      for (const name of names) {
        for (const source of graphs.get(name) ?? []) {
          if (source.predicate.value === INTEROP.hasDataGrant) seen.add(source.object.value)
        }
      }
      return [...seen].map((grant) => ({ grant: { termType: 'NamedNode', value: grant } })) as never
    },
    async fetchTriples(query: string) {
      queries.push(query)
      const store = new Store()
      for (const match of query.matchAll(/VALUES \?g \{([^}]*)\}/g)) {
        for (const iri of [...match[1].matchAll(/<([^>]+)>/g)].map((m) => m[1])) {
          for (const source of graphs.get(iri) ?? []) store.addQuad(clone(source))
        }
      }
      return store
    },
  } as unknown as SparqlTransport & { queries: string[] }
}

describe('getReciprocalGrants — batched grantee-side read', () => {
  test('reads the link set and every linked body in two queries', async () => {
    const graphs = new Map<string, Quad[]>([
      // registration body only in the meta twin (the CSS convention)
      [`meta:${RECIPROCAL}`, registrationGraph([G1, G2])],
      [G1, grantGraph(G1)],
      [G2, grantGraph(G2, { tree: 'https://data/shapetrees/trees/Task' })],
    ])
    const transport = graphTransport(graphs)

    const grants = await getReciprocalGrants(transport, RECIPROCAL)

    expect(grants.map((grant) => grant.id)).toEqual([G1, G2])
    expect(grants[1].registeredShapeTree).toBe('https://data/shapetrees/trees/Task')
    expect(transport.queries).toHaveLength(2)
    expect(transport.queries[0]).toContain(`GRAPH <meta:${RECIPROCAL}>`)
  })

  test('a linked grant without a mirrored body is skipped, not thrown', async () => {
    const graphs = new Map<string, Quad[]>([
      [RECIPROCAL, registrationGraph([G1, G2])],
      [G1, grantGraph(G1)],
    ])
    const transport = graphTransport(graphs)

    const grants = await getReciprocalGrants(transport, RECIPROCAL)

    expect(grants.map((grant) => grant.id)).toEqual([G1])
  })

  test('framing sees the reverse inheriting edge the grantor wrote on the parent', async () => {
    const graphs = new Map<string, Quad[]>([
      [RECIPROCAL, registrationGraph([G1, CHILD])],
      [
        G1,
        [
          ...grantGraph(G1),
          // `hasInheritingGrant` is the @reverse of this triple
          quad(namedNode(CHILD), namedNode(INTEROP.inheritsFromGrant), namedNode(G1)),
        ],
      ],
      [CHILD, grantGraph(CHILD, { tree: 'https://data/shapetrees/trees/Task' })],
    ])
    const transport = graphTransport(graphs)

    const grants = await getReciprocalGrants(transport, RECIPROCAL)

    const parent = grants.find((grant) => grant.id === G1)
    expect(parent?.hasInheritingGrant).toEqual([CHILD])
  })

  test('no linked grants means no body query', async () => {
    const transport = graphTransport(new Map())
    expect(await getReciprocalGrants(transport, RECIPROCAL)).toEqual([])
    expect(transport.queries).toHaveLength(1)
  })

  test('is unaffected by unrelated graphs (LDP containers)', async () => {
    const graphs = new Map<string, Quad[]>([
      [RECIPROCAL, registrationGraph([G1])],
      [G1, grantGraph(G1)],
      [
        'https://registry/alice/social-agent/',
        [
          quad(
            namedNode('https://registry/alice/social-agent/'),
            namedNode(LDP.contains),
            namedNode('x')
          ),
        ],
      ],
    ])
    const transport = graphTransport(graphs)
    const grants = await getReciprocalGrants(transport, RECIPROCAL)
    expect(grants).toHaveLength(1)
  })
})
