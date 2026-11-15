import { ACCESS_ACTIONS, INTEROP, LDP, ODRL, LWS, RDF } from '@janeirodigital/interop-utils'
import { DataFactory, type Quad, Store } from 'n3'
import { describe, expect, test } from 'vitest'

import { type SparqlTransport, getReciprocalGrants } from '../src/sparql.js'

const { namedNode, quad } = DataFactory

const RECIPROCAL = 'https://registry/alice/r-acme'
const G1 = 'https://registry/alice/g1'
const G2 = 'https://registry/alice/g2'
const CHILD = 'https://registry/alice/g-child'
const TREE = 'https://data/shapetrees/trees/Project'

const registrationGraph = (links: string[]): Quad[] =>
  links.map((grant) =>
    quad(namedNode(RECIPROCAL), namedNode(INTEROP.hasDataGrant), namedNode(grant))
  )

const grantGraph = (id: string, over: { tree?: string; owner?: string } = {}): Quad[] => {
  const policy = namedNode(`urn:uuid:${id}-policy`)
  const permission = namedNode(`urn:uuid:${id}-permission`)
  const target = namedNode(`urn:uuid:${id}-target`)
  return [
    quad(namedNode(id), namedNode(RDF.type), namedNode(LWS.AccessGrant)),
    quad(namedNode(id), namedNode(INTEROP.scopeOfGrant), namedNode(INTEROP.AllFromRegistry)),
    quad(namedNode(id), namedNode(LWS.access), policy),
    quad(policy, namedNode(RDF.type), namedNode(ODRL.Agreement)),
    quad(policy, namedNode(ODRL.uid), policy),
    quad(policy, namedNode(ODRL.profile), namedNode(INTEROP.AccessProfile)),
    quad(policy, namedNode(INTEROP.registeredShapeTree), namedNode(over.tree ?? TREE)),
    quad(policy, namedNode(INTEROP.scopeOfGrant), namedNode(INTEROP.AllFromRegistry)),
    quad(policy, namedNode(ODRL.permission), permission),
    quad(permission, namedNode(ODRL.uid), permission),
    quad(permission, namedNode(ODRL.assigner), namedNode('https://id/alice')),
    quad(permission, namedNode(ODRL.assignee), namedNode('https://id/acme')),
    quad(permission, namedNode(ODRL.action), namedNode(ACCESS_ACTIONS.read)),
    quad(permission, namedNode(ODRL.target), target),
    quad(target, namedNode(ODRL.uid), target),
    quad(target, namedNode(RDF.type), namedNode(ODRL.AssetCollection)),
    quad(target, namedNode(RDF.type), namedNode(INTEROP.DataRegistration)),
    quad(target, namedNode(ODRL.source), namedNode('https://data/alice/registrations/p')),
    quad(target, namedNode(INTEROP.dataOwner), namedNode(over.owner ?? 'https://id/alice')),
    quad(target, namedNode(LWS.storage), namedNode('https://data/alice/')),
  ]
}

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
    expect(grants[0].type).toEqual([LWS.AccessGrant])
    expect(grants[0].storage).toBe('https://data/alice/')
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
