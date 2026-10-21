import { buildSessionManager } from '@elfpavlik/sai-components'
import { type GrantData, Grant, getDataGrantIris } from '@janeirodigital/interop-data-model'
import { INTEROP, loader } from '@janeirodigital/interop-utils'
const loadGrant = loader(Grant.fromJsonLd)

import { describe, expect, test } from 'vitest'

import { awaitGrantCompletion, rpcCall, rpcPayload, waitFor } from './util'

describe('share resource', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const kimId = 'https://id/kim'
  const kimCookie = 'css-account=77b0674a-1f3b-4c78-a7d9-0b2e3f4a5b6c'
  const applicationId = 'https://data/test-client/public/id'
  const resource = 'https://data/alice-home/x1n3cm/n8k3wp'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const readMode = 'http://www.w3.org/ns/auth/acl#Read'

  test('shares a data instance with a social agent', async () => {
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)

    // kim has no grants from alice yet — her registration is the outcome signal
    const regForKim = (await aliceSession.findSocialAgentRegistration(kimId))!
    expect(regForKim).toBeDefined()

    // trigger the share, await the registration Update AND the chain's
    // completion (shared barrier — the Update fires mid-chain, this also
    // waits for the workflow tail so the next write can't race it)
    await awaitGrantCompletion(aliceSession.fetch, regForKim.id, [aliceId, kimId], async () => {
      const response = await fetch('https://auth/.sai/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
        },
        body: JSON.stringify(
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
          })
        ),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      const { _tag, value } = body[0]
      expect(_tag).toBe('Success')
      expect(value).toEqual(expect.objectContaining({ callbackEndpoint: 'https://test-client' }))
    })

    // the grant for the shared instance, on the authoritative side: alice's
    // registration of kim links it and the body sits in alice's own grant
    // registry (she is the data owner) — re-read after the barrier
    const linked = (await aliceSession.findSocialAgentRegistration(kimId))!
    const grants: GrantData[] = []
    for (const iri of getDataGrantIris(linked)) {
      const grant = await loadGrant(iri, aliceSession.fetch).catch(() => undefined)
      if (grant) grants.push(grant)
    }
    const sharedGrant = grants.find(
      (grant) =>
        grant.registeredShapeTree === projectShapeTree &&
        grant.grantedBy === aliceId &&
        grant.dataOwner === aliceId &&
        grant.hasDataInstance?.includes(resource)
    )
    expect(sharedGrant).toBeDefined()
    expect(sharedGrant!.scopeOfGrant).toBe(INTEROP.SelectedFromRegistry)
    expect(sharedGrant!.accessMode).toEqual([readMode])

    // grantee-facing (public RPC): kim sees the shared project registration in
    // her own "data of alice" view. The product serves it from kim's replica,
    // which the delegated-grants consumer refreshes after the grant write — poll
    // until it converges instead of reading the replica directly (the replica
    // contract lives in federation-mirror.test.ts).
    await waitFor(
      async () => {
        const registries = await rpcCall<{ registrations: { shapeTree: string }[] }[]>(
          rpcPayload({
            _tag: 'ListDataRegistries',
            agentId: aliceId,
            lang: 'en',
            context: kimId,
          }),
          kimCookie
        )
        return registries.some((registry) =>
          registry.registrations.some((entry) => entry.shapeTree === projectShapeTree)
        )
      },
      { timeout: 30_000 }
    )
  })
})
