import { buildSessionManager } from '@elfpavlik/sai-components'
import { INTEROP } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { awaitGrantCompletion, dataGrants, localMirror, rpcCall, rpcPayload, waitFor } from './util'

/**
 * The one place in the black-box suite that reads replica graphs directly.
 *
 * Everything else asserts the grantee-facing result through a public RPC after
 * the `done` barrier. These cases exist because the replication contract — "the
 * grantee's local copy of the peer's registration (and of every grant linked
 * from it) is present and current" — has no product surface of its own: a
 * missing replica only shows up as a wrong/empty view later.
 *
 * No test writes a mirror: the seed backfill (`applyReciprocalMirrors`) models a
 * federation that already exists, and the refresh paths under test are the
 * runtime ones (invitation seeding / the delegated-grants consumer).
 */
describe('reciprocal mirror replication', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const bobId = 'https://id/bob'
  const kimId = 'https://id/kim'
  const applicationId = 'https://data/test-client/public/id'
  const resource = 'https://data/alice-home/x1n3cm/n8k3wp'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const readMode = 'http://www.w3.org/ns/auth/acl#Read'

  test('a seeded pair starts with a complete replica of the peer registration', async () => {
    const manager = buildSessionManager()
    const bobSession = await manager.getSession(bobId)

    // bob's replica of alice's registration of him (the seeded reciprocal)
    const replica = await localMirror(bobSession, aliceId)
    expect(replica.registeredAgent).toBe(bobId)
    expect(replica.hasDataGrant?.length).toBeGreaterThan(0)

    // every linked grant body is present — `dataGrants` resolves each graph and
    // throws if one is missing
    const grants = await dataGrants(replica, bobSession)
    expect(grants).toHaveLength(replica.hasDataGrant?.length ?? 0)
  })

  test('a grant write refreshes the replica to match the peer registration', async () => {
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)
    const kimSession = await manager.getSession(kimId)

    const regForKim = (await aliceSession.findSocialAgentRegistration(kimId))!
    await awaitGrantCompletion(aliceSession.fetch, regForKim.id, [aliceId, kimId], async () => {
      await rpcCall(
        rpcPayload({
          _tag: 'ShareResource',
          authorization: {
            applicationId,
            resource,
            agents: [kimId],
            accessMode: [readMode],
            children: [],
          },
          context: aliceId,
        }),
        aliceCookie
      )
    })

    // the authoritative registration (alice's own registry)
    const authoritative = await aliceSession.findSocialAgentRegistration(kimId)
    expect(authoritative).toBeDefined()
    const expected = authoritative!.hasDataGrant ?? []

    // kim's replica converges to the same link set, with every body resolvable
    await waitFor(
      async () => {
        const mirrored = await localMirror(kimSession, aliceId)
        if (new Set(mirrored.hasDataGrant ?? []).size !== expected.length) return false
        // throws while a body is still missing — the completeness half
        await dataGrants(mirrored, kimSession)
        return true
      },
      { timeout: 30_000 }
    )
    const replica = await localMirror(kimSession, aliceId)
    expect(replica.registeredAgent).toBe(kimId)
    expect(new Set(replica.hasDataGrant ?? [])).toEqual(new Set(expected))

    // the replicated body carries the grant semantics the delegation path needs
    const grants = await dataGrants(replica, kimSession)
    const sharedGrant = grants.find(
      (grant) =>
        grant.registeredShapeTree === projectShapeTree &&
        grant.grantedBy === aliceId &&
        grant.hasDataInstance?.includes(resource)
    )
    expect(sharedGrant).toBeDefined()
    expect(sharedGrant!.scopeOfGrant).toBe(INTEROP.SelectedFromRegistry)
    expect(sharedGrant!.accessMode).toEqual([readMode])
  })
})
