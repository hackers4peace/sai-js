import { grantAccess } from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP, LWS } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// T7: the delegation request is batched per data owner — one POST for the whole
// group, because the owner-scoped access request endpoint already requires a
// single dataOwner and materializes the batch.
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

import { requestDelegations, requestRevocations } from '../src/temporal/activities/grants.js'
import { accessRequestsUrl } from '../src/util/uriTemplates.js'

process.env.CSS_BASE_URL = 'https://auth/'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const ENDPOINT = 'https://registry/acme/sparql'
const webId = { id: 'https://id/acme', type: [SOCIAL_AGENT_TYPE] }

const grant = (dataOwner = 'https://id/alice') => {
  const storage = 'https://data/alice/'
  const hasDataRegistration = 'https://data/alice/registrations/p'
  return {
    type: [LWS.AccessGrant],
    storage,
    access: grantAccess({
      scopeOfGrant: INTEROP.AllFromRegistry,
      owner: dataOwner,
      storage,
      hasDataRegistration,
      registeredShapeTree: 'https://data/shapetrees/trees/Project',
      assigner: 'https://id/acme',
      assignee: 'https://id/kim',
      actions: [ACCESS_ACTIONS.read],
    }),
    grantedBy: 'https://id/acme',
    dataOwner,
    registeredShapeTree: 'https://data/shapetrees/trees/Project',
    hasDataRegistration,
    scopeOfGrant: INTEROP.AllFromRegistry,
  }
}

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
      { id: 'https://data/alice/grant/d1', type: [LWS.AccessGrant] },
      { id: 'https://data/alice/grant/d2', type: [LWS.AccessGrant] },
    ])
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [endpoint, init] = h.fetch.mock.calls[0] as [string, { body: string; method: string }]
    expect(endpoint).toBe(accessRequestsUrl('https://id/alice'))
    expect(init.method).toBe('POST')
    const message = JSON.parse(init.body)
    expect(message).toHaveLength(2)
    expect(message[0].type).toEqual(['AccessRequest', 'DelegationRequest'])
    expect(message[0].access).toHaveLength(1)

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

    expect(ids).toEqual([{ id: 'https://data/alice/grant/d1', type: [LWS.AccessGrant] }])
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

describe('requestRevocations — owner access request endpoint', () => {
  const grants = [{ id: 'https://registry/alice/g1', type: [LWS.AccessGrant] }]

  test('posts the grant IRIs to the owner-scoped access request endpoint', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify(['https://registry/alice/g1']), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const removed = await requestRevocations({
      webId,
      dataOwner: 'https://id/alice',
      grants,
    })

    expect(removed).toEqual(['https://registry/alice/g1'])
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [endpoint, init] = h.fetch.mock.calls[0] as [string, { body: string; method: string }]
    expect(endpoint).toBe(accessRequestsUrl('https://id/alice'))
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({
      type: ['AccessRequest', 'AccessRevocationRequest'],
      grants: ['https://registry/alice/g1'],
    })
  })

  test('does nothing for an empty revocation set', async () => {
    expect(await requestRevocations({ webId, dataOwner: 'https://id/alice', grants: [] })).toEqual(
      []
    )
    expect(h.fetch).not.toHaveBeenCalled()
  })

  test('surfaces a rejected revocation request', async () => {
    h.fetch.mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(
      requestRevocations({ webId, dataOwner: 'https://id/alice', grants })
    ).rejects.toThrow('revocation request failed: 403')
  })
})
