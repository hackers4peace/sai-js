import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { SocialAgentRegistrationData } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// The mirror writer talks to Fuseki through `SparqlEndpointFetcher` (its own
// instance and — via `presentGraphs`/`localSparqlTransport` — the authorization
// agent's). Both resolve to the mocked module, so one scripted store lets us
// assert exactly which peer documents get re-fetched and what the single UPDATE
// drops/inserts.
// ──────────────────────────

const sparql = vi.hoisted(() => {
  const state: {
    /** grant IRIs linked in the mirror's reciprocal graph (the oracle's input) */
    mirroredLinks: string[]
    /** graph names that actually have a body (resource and/or `meta:` twin) */
    present: Set<string>
    updates: string[]
    bindingQueries: string[]
  } = { mirroredLinks: [], present: new Set(), updates: [], bindingQueries: [] }
  return state
})

vi.mock('fetch-sparql-endpoint', async () => {
  // `arrayifyStream` (CSS) and the authorization agent's own collector both
  // expect a readable stream of bindings
  const { Readable } = await import('node:stream')
  return {
    SparqlEndpointFetcher: class {
      async fetchBindings(_endpoint: string, query: string) {
        sparql.bindingQueries.push(query)
        if (query.includes('VALUES ?g')) {
          // presentGraphs — resource VALUES list + `meta:` VALUES list
          const names = [...query.matchAll(/VALUES \?g \{([^}]*)\}/g)].flatMap((match) =>
            [...match[1].matchAll(/<([^>]+)>/g)].map((iri) => iri[1])
          )
          const found = new Set<string>()
          for (const name of names) {
            if (sparql.present.has(name)) {
              found.add(name.startsWith('meta:') ? name.slice('meta:'.length) : name)
            }
          }
          return Readable.from(
            [...found].map((graph) => ({ g: { termType: 'NamedNode', value: graph } }))
          )
        }
        if (query.includes(INTEROP.hasDataGrant)) {
          return Readable.from(
            sparql.mirroredLinks.map((grant) => ({
              grant: { termType: 'NamedNode', value: grant },
            }))
          )
        }
        throw new Error(`mock: unexpected query\n${query}`)
      }
      async fetchTriples() {
        throw new Error('mock: unexpected fetchTriples')
      }
      async fetchUpdate(_endpoint: string, update: string) {
        sparql.updates.push(update)
      }
    },
  }
})

import { deleteReciprocalMirror, updateReciprocalMirror } from '../src/services/ReciprocalMirror.js'

const RECIPROCAL = 'https://registry/alice/social-agent/r-acme'
const G1 = 'https://registry/alice/grant/g1'
const G2 = 'https://registry/alice/grant/g2'
const G3 = 'https://registry/alice/grant/g3'
const STALE = 'https://registry/alice/grant/g-stale'
const TREE = 'https://data/shapetrees/trees/Project'

const registration = {
  id: 'https://registry/acme/social-agent/r-alice',
  reciprocalRegistration: RECIPROCAL,
} as SocialAgentRegistrationData

/** Expanded JSON-LD — what `fetchJsonLd` returns for an `application/ld+json` GET. */
const reciprocalDoc = {
  '@id': RECIPROCAL,
  [INTEROP.hasDataGrant]: [G1, G2, G3].map((grant) => ({ '@id': grant })),
}
const grantDoc = (id: string) => ({
  '@id': id,
  [INTEROP.registeredShapeTree]: [{ '@id': TREE }],
  [INTEROP.dataOwner]: [{ '@id': 'https://id/alice' }],
})

let fetched: string[]

function session() {
  return {
    fetch: async (input: string | URL | Request) => {
      const iri = String(input)
      fetched.push(iri)
      const doc = iri === RECIPROCAL ? reciprocalDoc : iri === STALE ? undefined : grantDoc(iri)
      if (!doc) return new Response('gone', { status: 404 })
      return new Response(JSON.stringify(doc), {
        headers: { 'content-type': 'application/ld+json' },
      })
    },
  } as unknown as AuthorizationAgent
}

beforeEach(() => {
  fetched = []
  sparql.updates = []
  sparql.bindingQueries = []
  sparql.mirroredLinks = []
  sparql.present = new Set()
})

describe('updateReciprocalMirror — oracle (improve-grant-replication.md S7)', () => {
  test('re-fetches a linked grant whose body is missing, skips present ones', async () => {
    // the mirror lists G1, G2 and a no-longer-linked STALE; G1 has a body, G2
    // does not (non-atomic writer / restore), STALE only survives as a meta twin
    sparql.mirroredLinks = [G1, G2, STALE]
    sparql.present = new Set([G1, `meta:${STALE}`])

    await updateReciprocalMirror(session(), registration, 'https://registry/acme/sparql')

    // G3 is newly linked, G2 is linked-but-absent → fetched; G1 and STALE are not
    expect(fetched).toEqual([RECIPROCAL, G2, G3])

    const [update] = sparql.updates
    // the reciprocal and the stale grant are dropped with their meta twins
    expect(update).toContain(`DROP SILENT GRAPH <${RECIPROCAL}>;`)
    expect(update).toContain(`DROP SILENT GRAPH <meta:${RECIPROCAL}>;`)
    expect(update).toContain(`DROP SILENT GRAPH <${STALE}>;`)
    expect(update).toContain(`DROP SILENT GRAPH <meta:${STALE}>;`)
    expect(update).not.toContain(`DROP SILENT GRAPH <${G1}>;`)
    // the re-fetched and the new grant are inserted
    expect(update).toContain(`<${G2}>`)
    expect(update).toContain(`<${G3}>`)

    // the oracle reads the resource graph AND its meta twin
    expect(
      sparql.bindingQueries.some(
        (query) =>
          query.includes(`GRAPH <${RECIPROCAL}>`) && query.includes(`GRAPH <meta:${RECIPROCAL}>`)
      )
    ).toBe(true)
  })

  test('fetches nothing but the reciprocal when every linked grant body is present', async () => {
    sparql.mirroredLinks = [G1, G2]
    sparql.present = new Set([G1, G2])

    await updateReciprocalMirror(session(), registration, 'https://registry/acme/sparql')

    // G3 is the only new link
    expect(fetched).toEqual([RECIPROCAL, G3])
    const [update] = sparql.updates
    expect(update).not.toContain(`DROP SILENT GRAPH <${G1}>;`)
    expect(update).not.toContain(`DROP SILENT GRAPH <${G2}>;`)
  })
})

describe('deleteReciprocalMirror', () => {
  test('drops the reciprocal and every linked grant with their meta twins', async () => {
    sparql.mirroredLinks = [G1, G2]

    await deleteReciprocalMirror(registration, 'https://registry/acme/sparql')

    const [update] = sparql.updates
    for (const iri of [RECIPROCAL, G1, G2]) {
      expect(update).toContain(`DROP SILENT GRAPH <${iri}>;`)
      expect(update).toContain(`DROP SILENT GRAPH <meta:${iri}>;`)
    }
  })
})
