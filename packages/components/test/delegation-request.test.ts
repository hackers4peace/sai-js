import { INTEROP } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// T7: the delegation request is batched per data owner — one endpoint discovery
// and one POST for the whole group, because the issuance endpoint already
// requires a single dataOwner and materializes the batch.
// ──────────────────────────

const h = vi.hoisted(() => {
  const state = { fetch: vi.fn() }
  return state
})

const session = { fetch: h.fetch } as unknown

vi.mock('../src/builders/sessionManager.js', () => ({
  buildSessionManager: () => ({ getSession: async () => session }),
}))

vi.mock('@janeirodigital/interop-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janeirodigital/interop-utils')>()),
  discoverDelegationIssuanceEndpoint: async () => 'https://data/alice.example/.sai/delegation',
}))

import { requestDelegations } from '../src/temporal/activities/grants.js'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const webId = { id: 'https://id/acme', type: [SOCIAL_AGENT_TYPE] }

const grant = (id: string, dataOwner = 'https://id/alice') => ({
  type: [INTEROP.DataGrant],
  grantee: 'https://id/kim',
  grantedBy: 'https://id/acme',
  dataOwner,
  registeredShapeTree: 'https://data/shapetrees/trees/Project',
  hasDataRegistration: 'https://data/alice/registrations/p',
  hasStorage: 'https://data/alice/',
  scopeOfGrant: INTEROP.AllFromRegistry,
  accessMode: [INTEROP.Read],
  delegationOfGrant: id,
})

beforeEach(() => {
  h.fetch.mockReset()
})

describe('requestDelegations — one request per data owner (T7)', () => {
  test('sends the whole group in one AccessRequest and returns the assigned IRIs', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify(['https://data/alice/grant/d1', 'https://data/alice/grant/d2']), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const ids = await requestDelegations({
      webId,
      grants: [grant('https://data/alice/grant/s1'), grant('https://data/alice/grant/s2')],
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
  })

  test('does nothing for an empty group', async () => {
    expect(await requestDelegations({ webId, grants: [] })).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  })

  test('refuses a mixed data owner batch', async () => {
    await expect(
      requestDelegations({
        webId,
        grants: [
          grant('https://data/alice/grant/s1'),
          grant('https://data/bob/grant/s2', 'https://id/bob'),
        ],
      })
    ).rejects.toThrow('single data owner')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  test('surfaces a rejected request', async () => {
    h.fetch.mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(
      requestDelegations({ webId, grants: [grant('https://data/alice/grant/s1')] })
    ).rejects.toThrow('delegation request failed: 403')
  })
})
