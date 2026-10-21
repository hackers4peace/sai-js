import { INTEROP } from '@janeirodigital/interop-utils'
import { DataFactory, type Quad } from 'n3'
import { describe, expect, test } from 'vitest'

import { type SparqlTransport, getLinkedGrantOwners, getRegistrationLinks } from '../src/sparql.js'

const { namedNode, quad } = DataFactory

const RECIPROCAL = 'https://registry/acme/social-agent/r-alice'
const ADMIN_GRANT = 'https://registry/acme/grant/admin'
const PROJECT_GRANT = 'https://registry/acme/grant/g-project'
const TASK_GRANT = 'https://registry/acme/grant/g-task'
const ALICE = 'https://id/alice'
const CAROL = 'https://id/carol'

/**
 * A transport that serves named graphs and answers the two target queries, so
 * the "one query, no framing" contract is observable.
 */
function graphTransport(graphs: Map<string, Quad[]>): SparqlTransport & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    async fetchBindings(query: string) {
      queries.push(query)
      if (query.includes(INTEROP.dataOwner)) {
        // link set joined with each grant's dataOwner — emulate it directly
        const owners = new Set<string>()
        for (const name of [RECIPROCAL, `meta:${RECIPROCAL}`]) {
          const grantIris = (graphs.get(name) ?? [])
            .filter((q) => q.predicate.value === INTEROP.hasDataGrant)
            .map((q) => q.object.value)
          for (const grant of grantIris) {
            for (const q of graphs.get(grant) ?? []) {
              if (q.predicate.value === INTEROP.dataOwner) owners.add(q.object.value)
            }
          }
        }
        return [...owners].map((owner) => ({ owner: { termType: 'NamedNode', value: owner } }))
      }
      if (query.includes(INTEROP.hasAdminGrant)) {
        const values = new Set<string>()
        for (const name of [RECIPROCAL, `meta:${RECIPROCAL}`]) {
          for (const q of graphs.get(name) ?? []) {
            if (q.predicate.value === INTEROP.hasAdminGrant) values.add(q.object.value)
          }
        }
        return [...values].map((value) => ({ value: { termType: 'NamedNode', value } }))
      }
      throw new Error(`unexpected query:\n${query}`)
    },
    async fetchTriples() {
      queries.push('CONSTRUCT')
      throw new Error('fetchTriples must not be used by the link queries')
    },
  } as unknown as SparqlTransport & { queries: string[] }
}

const link = (predicate: string, target: string): Quad =>
  quad(namedNode(RECIPROCAL), namedNode(predicate), namedNode(target))

const grant = (id: string, owner: string): Quad[] => [
  quad(namedNode(id), namedNode(INTEROP.dataOwner), namedNode(owner)),
]

describe('getRegistrationLinks — link presence without framing', () => {
  test('reads hasAdminGrant from the resource graph and its meta twin', async () => {
    const transport = graphTransport(
      new Map([
        [RECIPROCAL, [link(INTEROP.hasAdminGrant, ADMIN_GRANT)]],
        [`meta:${RECIPROCAL}`, [link(INTEROP.hasAdminGrant, ADMIN_GRANT)]],
      ])
    )

    expect(await getRegistrationLinks(transport, RECIPROCAL, INTEROP.hasAdminGrant)).toEqual([
      ADMIN_GRANT,
    ])
    expect(transport.queries).toHaveLength(1)
  })

  test('a registration without the link yields an empty list (no framing attempt)', async () => {
    const transport = graphTransport(new Map([[RECIPROCAL, []]]))
    expect(await getRegistrationLinks(transport, RECIPROCAL, INTEROP.hasAdminGrant)).toEqual([])
    expect(transport.queries).toHaveLength(1)
  })
})

describe('getLinkedGrantOwners — whose data is reachable (T4)', () => {
  test('returns the distinct data owners behind the linked grants', async () => {
    const transport = graphTransport(
      new Map<string, Quad[]>([
        // link set only in the meta twin (the CSS convention)
        [
          `meta:${RECIPROCAL}`,
          [link(INTEROP.hasDataGrant, PROJECT_GRANT), link(INTEROP.hasDataGrant, TASK_GRANT)],
        ],
        [PROJECT_GRANT, grant(PROJECT_GRANT, ALICE)],
        [TASK_GRANT, grant(TASK_GRANT, CAROL)],
      ])
    )

    expect(await getLinkedGrantOwners(transport, RECIPROCAL)).toEqual([ALICE, CAROL])
    expect(transport.queries).toHaveLength(1)
  })

  test('linked grants without a mirrored body contribute nothing', async () => {
    const transport = graphTransport(
      new Map<string, Quad[]>([
        [
          RECIPROCAL,
          [link(INTEROP.hasDataGrant, PROJECT_GRANT), link(INTEROP.hasDataGrant, TASK_GRANT)],
        ],
        [PROJECT_GRANT, grant(PROJECT_GRANT, ALICE)],
      ])
    )

    expect(await getLinkedGrantOwners(transport, RECIPROCAL)).toEqual([ALICE])
  })

  test('no links means no owners', async () => {
    const transport = graphTransport(new Map([[RECIPROCAL, []]]))
    expect(await getLinkedGrantOwners(transport, RECIPROCAL)).toEqual([])
  })
})
