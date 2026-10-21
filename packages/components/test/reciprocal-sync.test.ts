import { HttpStatusError } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// Terminal-error classification for the mirror sync. The activity is the only
// place that decides whether a peer failure is terminal (`404`/`410` → the peer
// deleted its registration of us) or retryable (everything else).
// ──────────────────────────

const h = vi.hoisted(() => {
  const state = {
    registration: undefined as { id: string; reciprocalRegistration?: string } | undefined,
    update: vi.fn(),
    drop: vi.fn(),
  }
  return state
})

vi.mock('../src/builders/sessionManager.js', () => ({
  buildSessionManager: () => ({
    getSession: async () => ({
      sparqlEndpoint: 'https://registry/acme/sparql',
      findSocialAgentRegistration: async () => h.registration,
    }),
  }),
}))

vi.mock('../src/services/ReciprocalMirror.js', () => ({
  updateReciprocalMirror: h.update,
  deleteReciprocalMirror: h.drop,
}))

import { syncReciprocalMirror } from '../src/temporal/activities/reciprocal.js'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const payload = {
  webId: { id: 'https://id/acme', type: [SOCIAL_AGENT_TYPE] },
  peerId: { id: 'https://id/bob', type: [SOCIAL_AGENT_TYPE] },
}
const RECIPROCAL = 'https://registry/bob/social-agent/x7n2qv/'

beforeEach(() => {
  h.registration = {
    id: 'https://registry/acme/social-agent/r-bob',
    reciprocalRegistration: RECIPROCAL,
  }
  h.update.mockReset()
  h.drop.mockReset()
  h.update.mockResolvedValue(undefined)
  h.drop.mockResolvedValue(undefined)
})

describe('syncReciprocalMirror — terminal-error policy', () => {
  test('mirrors and reports no peer-gone on success', async () => {
    const result = await syncReciprocalMirror(payload)

    expect(result).toEqual({ peerGone: false })
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ sparqlEndpoint: 'https://registry/acme/sparql' }),
      h.registration,
      'https://registry/acme/sparql'
    )
    expect(h.drop).not.toHaveBeenCalled()
  })

  test.each([404, 410])(
    'a %i drops the replica and reports peer-gone (terminal)',
    async (status) => {
      h.update.mockRejectedValue(new HttpStatusError(RECIPROCAL, status))

      const result = await syncReciprocalMirror(payload)

      expect(result).toEqual({ peerGone: true })
      expect(h.drop).toHaveBeenCalledTimes(1)
    }
  )

  test.each([401, 403, 500])('a %i stays retryable (rejects)', async (status) => {
    const failure = new HttpStatusError(RECIPROCAL, status)
    h.update.mockRejectedValue(failure)

    await expect(syncReciprocalMirror(payload)).rejects.toBe(failure)
    // never drop the replica on a failure that may be transient/misconfigured
    expect(h.drop).not.toHaveBeenCalled()
  })

  test('a 404 on a linked grant is not peer-gone — the replica is kept', async () => {
    // the reciprocal document still lists a grant the peer already replaced;
    // the next sync reads the updated link set, so this retries
    const failure = new HttpStatusError('https://registry/bob/grant/g1', 404)
    h.update.mockRejectedValue(failure)

    await expect(syncReciprocalMirror(payload)).rejects.toBe(failure)
    expect(h.drop).not.toHaveBeenCalled()
  })

  test('a network failure stays retryable (rejects)', async () => {
    const failure = new Error('getaddrinfo ENOTFOUND registry.bob.example')
    h.update.mockRejectedValue(failure)

    await expect(syncReciprocalMirror(payload)).rejects.toBe(failure)
    expect(h.drop).not.toHaveBeenCalled()
  })

  test('a registration without a reciprocal link is a no-op', async () => {
    h.registration = { id: 'https://registry/acme/social-agent/r-bob' }

    const result = await syncReciprocalMirror(payload)

    expect(result).toEqual({ peerGone: false })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.drop).not.toHaveBeenCalled()
  })
})
