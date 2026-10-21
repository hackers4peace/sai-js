import { INTEROP } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// T7: the delegation request is batched per data owner — one endpoint discovery
// and one POST for the whole group, because the issuance endpoint already
// requires a single dataOwner and materializes the batch.
//
// Step 4: the endpoint echoes the FINALISED grants (not bare ids), and the
// grantor stores them as the issuer-side replica that `checkEquivalence` reads.
// ──────────────────────────

const h = vi.hoisted(() => {
  const state = { fetch: vi.fn() }
  return state
})

/** The replica writer talks to Fuseki through its own SparqlEndpointFetcher. */
const sparql = vi.hoisted(() => {
  const updates: { endpoint: string; update: string }[] = []
  const fetchUpdate = vi.fn(async (endpoint: string, update: string) => {
    updates.push({ endpoint, update })
  })
  return { updates, fetchUpdate }
})

vi.mock('fetch-sparql-endpoint', () => ({
  SparqlEndpointFetcher: class {
    fetchUpdate = sparql.fetchUpdate
  },
}))

const session = {
  fetch: h.fetch,
  sparqlEndpoint: 'https://registry/acme/sparql',
} as unknown

vi.mock('../src/builders/sessionManager.js', () => ({
  buildSessionManager: () => ({ getSession: async () => session }),
}))

vi.mock('@janeirodigital/interop-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janeirodigital/interop-utils')>()),
  discoverDelegationIssuanceEndpoint: async () => 'https://data/alice.example/.sai/delegation',
}))

import { requestDelegations } from '../src/temporal/activities/grants.js'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const ENDPOINT = 'https://registry/acme/sparql'
const webId = { id: 'https://id/acme', type: [SOCIAL_AGENT_TYPE] }

const grant = (dataOwner = 'https://id/alice') => ({
  type: [INTEROP.DataGrant],
  grantee: 'https://id/kim',
  grantedBy: 'https://id/acme',
  dataOwner,
  registeredShapeTree: 'https://data/shapetrees/trees/Project',
  hasDataRegistration: 'https://data/alice/registrations/p',
  hasStorage: 'https://data/alice/',
  scopeOfGrant: INTEROP.AllFromRegistry,
  accessMode: [INTEROP.Read],
})

/** One echoed finalised grant (the issuance response is now the grant bodies). */
const issuedGrant = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  ...grant(),
  ...overrides,
})

const issuedResponse = (grants: unknown[]) =>
  new Response(JSON.stringify(grants), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  h.fetch.mockReset()
  sparql.updates.length = 0
  sparql.fetchUpdate.mockReset()
  sparql.fetchUpdate.mockImplementation(async (endpoint: string, update: string) => {
    sparql.updates.push({ endpoint, update })
  })
})

describe('requestDelegations — one request per data owner (T7)', () => {
  test('sends the whole group in one AccessRequest, returns the ids and stores the replica', async () => {
    const issued = [
      issuedGrant('https://data/alice/grant/d1', {
        hasInheritingGrant: ['https://data/alice/grant/d2'],
      }),
      issuedGrant('https://data/alice/grant/d2', {
        inheritsFromGrant: 'https://data/alice/grant/d1',
        scopeOfGrant: INTEROP.Inherited,
      }),
    ]
    h.fetch.mockResolvedValue(issuedResponse(issued))

    const ids = await requestDelegations({
      webId,
      grants: [grant(), grant()],
    })

    expect(ids).toEqual([
      { id: 'https://data/alice/grant/d1', type: [INTEROP.DataGrant] },
      { id: 'https://data/alice/grant/d2', type: [INTEROP.DataGrant] },
    ])
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [endpoint, init] = h.fetch.mock.calls[0] as [string, { body: string; method: string }]
    expect(endpoint).toBe('https://data/alice.example/.sai/delegation')
    expect(init.method).toBe('POST')
    const message = JSON.parse(init.body)
    expect(message.type).toEqual([INTEROP.AccessRequest])
    expect(message.grants).toHaveLength(2)

    // one replica write for the whole response, one named graph per grant and
    // the parent's reverse child edge (so `graphDoc(parent)` frames children)
    expect(sparql.fetchUpdate).toHaveBeenCalledTimes(1)
    const [sparqlEndpoint, update] = sparql.fetchUpdate.mock.calls[0] as [string, string]
    expect(sparqlEndpoint).toBe(ENDPOINT)
    expect(update).toContain('GRAPH <https://data/alice/grant/d1>')
    expect(update).toContain('GRAPH <https://data/alice/grant/d2>')
    expect(update).toContain('inheritsFromGrant')
  })

  test('still returns the ids when the replica write fails (best effort)', async () => {
    h.fetch.mockResolvedValue(issuedResponse([issuedGrant('https://data/alice/grant/d1')]))
    sparql.fetchUpdate.mockRejectedValueOnce(new Error('fuseki down'))

    const ids = await requestDelegations({ webId, grants: [grant()] })

    expect(ids).toEqual([{ id: 'https://data/alice/grant/d1', type: [INTEROP.DataGrant] }])
  })

  test('does nothing for an empty group', async () => {
    expect(await requestDelegations({ webId, grants: [] })).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
    expect(sparql.fetchUpdate).not.toHaveBeenCalled()
  })

  test('refuses a mixed data owner batch', async () => {
    await expect(
      requestDelegations({
        webId,
        grants: [grant(), grant('https://id/bob')],
      })
    ).rejects.toThrow('single data owner')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(sparql.fetchUpdate).not.toHaveBeenCalled()
  })

  test('surfaces a rejected request', async () => {
    h.fetch.mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(requestDelegations({ webId, grants: [grant()] })).rejects.toThrow(
      'delegation request failed: 403'
    )
    expect(sparql.fetchUpdate).not.toHaveBeenCalled()
  })

  test('rejects a malformed issuance response instead of writing a partial replica', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify(['https://data/alice/grant/d1']), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    await expect(requestDelegations({ webId, grants: [grant()] })).rejects.toThrow(
      'invalid delegation response'
    )
    expect(sparql.fetchUpdate).not.toHaveBeenCalled()
  })
})
