import { describe, expect, test } from 'vitest'

import {
  type SparqlBindingTerm,
  type SparqlTransport,
  getAccessGrantsForGrantee,
  getOpenAccessRequestsOnRegistry,
  getOpenSentAccessRequests,
} from '../src/sparql.js'

const term = (value: string): SparqlBindingTerm => ({ termType: 'NamedNode', value })

/** A fake transport capturing the emitted query while returning fixture bindings. */
function capturingTransport(
  bindings: Array<Record<string, SparqlBindingTerm>>,
  queries: string[]
): SparqlTransport {
  return {
    fetchBindings: async (query: string) => {
      queries.push(query)
      return bindings
    },
    fetchTriples: async () => [],
  } as unknown as SparqlTransport
}

describe('getOpenSentAccessRequests', () => {
  test('groups the per-need shape trees under each open request', async () => {
    const queries: string[] = []
    const transport = capturingTransport(
      [
        // request r1 — Project + inherited Task (two rows, one request)
        {
          sent: term('https://registry/bob/sent1'),
          request: term('urn:uuid:r1'),
          grantee: term('https://id/bob'),
          grantedBy: term('https://id/bob'),
          dataOwner: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Project'),
        },
        {
          sent: term('https://registry/bob/sent1'),
          request: term('urn:uuid:r1'),
          grantee: term('https://id/bob'),
          grantedBy: term('https://id/bob'),
          dataOwner: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Task'),
        },
        // request r2 — a single tree
        {
          sent: term('https://registry/bob/sent2'),
          request: term('urn:uuid:r2'),
          grantee: term('https://id/bob'),
          grantedBy: term('https://id/bob'),
          dataOwner: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Image'),
        },
      ],
      queries
    )
    const result = await getOpenSentAccessRequests(transport)
    expect(result).toEqual([
      expect.objectContaining({
        sent: 'https://registry/bob/sent1',
        request: 'urn:uuid:r1',
        grantee: 'https://id/bob',
        grantedBy: 'https://id/bob',
        dataOwner: 'https://id/alice',
        shapeTrees: ['https://data/shapetrees/trees/Project', 'https://data/shapetrees/trees/Task'],
      }),
      expect.objectContaining({
        request: 'urn:uuid:r2',
        shapeTrees: ['https://data/shapetrees/trees/Image'],
      }),
    ])
  })

  test('groups requested instances under their shape tree', async () => {
    const queries: string[] = []
    const transport = capturingTransport(
      [
        {
          sent: term('https://registry/bob/sent1'),
          request: term('urn:uuid:r1'),
          grantee: term('https://id/bob'),
          grantedBy: term('https://id/bob'),
          dataOwner: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Project'),
          instance: term('https://data/alice/n1'),
        },
        {
          sent: term('https://registry/bob/sent1'),
          request: term('urn:uuid:r1'),
          grantee: term('https://id/bob'),
          grantedBy: term('https://id/bob'),
          dataOwner: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Project'),
          instance: term('https://data/alice/n2'),
        },
      ],
      queries
    )
    const result = await getOpenSentAccessRequests(transport)
    expect(result).toEqual([
      expect.objectContaining({
        request: 'urn:uuid:r1',
        shapeTrees: ['https://data/shapetrees/trees/Project'],
        instancesByShapeTree: {
          'https://data/shapetrees/trees/Project': [
            'https://data/alice/n1',
            'https://data/alice/n2',
          ],
        },
      }),
    ])
    expect(queries[0]).toContain('interop#hasDataInstance')
  })

  test('carries the open guard — FILTER NOT EXISTS over BOTH resolution classes referencing the same snapshot id', async () => {
    // contract test: a regression dropping the guard would list resolved
    // requests forever (the "never clears" cause); the SPARQL engine does the
    // actual exclusion (covered end-to-end in steps 7/9)
    const queries: string[] = []
    await getOpenSentAccessRequests(capturingTransport([], queries))
    const query = queries[0]
    expect(query).toContain('interop#AccessRequestGranted')
    expect(query).toContain('interop#AccessRequestArchived')
    expect(query).toContain('FILTER NOT EXISTS')
    // the join anchor — the resolution object is the Sent activity's SNAPSHOT
    // id (`outcome.object.id → sent.object.id`)
    expect(query).toContain('https://www.w3.org/ns/activitystreams#object')
  })
})

describe('getOpenAccessRequestsOnRegistry', () => {
  test('scopes to the container membership and excludes resolved requests via satisfiesAccessRequest', async () => {
    const queries: string[] = []
    const transport = capturingTransport(
      [
        {
          request: term('https://registry/alice/r1'),
          grantee: term('https://id/bob'),
        },
      ],
      queries
    )
    const result = await getOpenAccessRequestsOnRegistry(
      transport,
      'https://registry/alice/access-request/'
    )
    expect(result).toEqual([{ id: 'https://registry/alice/r1', grantee: 'https://id/bob' }])
    const query = queries[0]
    // container membership in the REGULAR graph (ldp:contains — no meta: read)
    expect(query).toContain('<https://registry/alice/access-request/>')
    expect(query).toContain('ldp#contains')
    // the open guard — a resolution back-link excludes the request
    expect(query).toContain('interop#satisfiesAccessRequest')
    expect(query).toContain('interop#AuthorizationGranted')
    expect(query).toContain('interop#AuthorizationDenied')
    expect(query).toContain('FILTER NOT EXISTS')
  })
})

describe('getAccessGrantsForGrantee', () => {
  test('binds the requester as grantee and returns grantedBy + shapeTree per grant', async () => {
    const queries: string[] = []
    const transport = capturingTransport(
      [
        {
          grant: term('https://registry/alice/g1'),
          grantedBy: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Project'),
        },
        {
          grant: term('https://registry/alice/g1-child'),
          grantedBy: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Task'),
        },
      ],
      queries
    )
    const result = await getAccessGrantsForGrantee(transport, 'https://id/bob')
    expect(result).toEqual([
      {
        grant: 'https://registry/alice/g1',
        grantedBy: 'https://id/alice',
        shapeTree: 'https://data/shapetrees/trees/Project',
      },
      {
        grant: 'https://registry/alice/g1-child',
        grantedBy: 'https://id/alice',
        shapeTree: 'https://data/shapetrees/trees/Task',
      },
    ])
    // the requester is INJECTED as the grantee anchor (§3.2 — the match is
    // grant.grantee ↔ request.grantedBy, never grant.grantedBy)
    expect(queries[0]).toContain('<https://id/bob>')
  })

  test('returns the grant scope and selected instances for SelectedFromRegistry', async () => {
    const queries: string[] = []
    const transport = capturingTransport(
      [
        {
          grant: term('https://registry/alice/g1'),
          grantedBy: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Project'),
          scope: term('http://www.w3.org/ns/solid/interop#SelectedFromRegistry'),
          source: term('https://data/alice/n1'),
        },
        {
          grant: term('https://registry/alice/g1'),
          grantedBy: term('https://id/alice'),
          shapeTree: term('https://data/shapetrees/trees/Project'),
          scope: term('http://www.w3.org/ns/solid/interop#SelectedFromRegistry'),
          source: term('https://data/alice/n2'),
        },
      ],
      queries
    )
    const result = await getAccessGrantsForGrantee(transport, 'https://id/bob')
    expect(result).toEqual([
      {
        grant: 'https://registry/alice/g1',
        grantedBy: 'https://id/alice',
        shapeTree: 'https://data/shapetrees/trees/Project',
        scope: 'http://www.w3.org/ns/solid/interop#SelectedFromRegistry',
        instances: ['https://data/alice/n1', 'https://data/alice/n2'],
      },
    ])
    expect(queries[0]).toContain('interop#scopeOfGrant')
    expect(queries[0]).toContain('odrl/2/source')
  })
})
