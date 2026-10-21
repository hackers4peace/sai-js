import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  getSocialAgentRegistration,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { getDataGrantIris } from '@janeirodigital/interop-data-model'
import { describe, expect, test } from 'vitest'

import { awaitGrantCompletion, dataGrants, waitFor } from './util'

const rpcEndpoint = 'https://auth/.sai/api'

describe('share resource', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const kimId = 'https://id/kim'
  const applicationId = 'https://data/test-client/public/id'
  const resource = 'https://data/alice-home/x1n3cm/n8k3wp'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const readMode = 'http://www.w3.org/ns/auth/acl#Read'

  test('shares a data instance with a social agent', async () => {
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)

    // kim has no grants from alice yet — her registration is the outcome signal
    const regForKim = await aliceSession.findSocialAgentRegistration(kimId)
    expect(regForKim).toBeDefined()

    // trigger the share, await the registration Update AND the chain's
    // completion (shared barrier — the Update fires mid-chain, this also
    // waits for the workflow tail so the next write can't race it)
    await awaitGrantCompletion(aliceSession.fetch, regForKim.id, [aliceId, kimId], async () => {
      const response = await fetch(rpcEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
        },
        body: JSON.stringify([
          {
            request: {
              _tag: 'ShareResource',
              authorization: {
                applicationId,
                resource,
                agents: [kimId],
                accessMode: [readMode],
                children: [],
              },
              context: aliceId,
            },
            headers: {},
            traceId: '13c2035f72f45c1ebbf13b055b7dc526',
            spanId: '685581075752b8a2',
            sampled: true,
          },
        ]),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      const { _tag, value } = body[0]
      expect(_tag).toBe('Success')
      expect(value).toEqual(expect.objectContaining({ callbackEndpoint: 'https://test-client' }))
    })

    // verify the grant for the shared instance on alice's reciprocal registration for kim
    const kimSession = await manager.getSession(kimId)
    const kimRegForAlice = await kimSession.findSocialAgentRegistration(aliceId)
    const loadMirror = async () => {
      const aliceRegForKim = await getSocialAgentRegistration(
        localSparqlTransport(kimSession.sparqlEndpoint),
        kimRegForAlice.reciprocalRegistration!
      )
      const grants = await dataGrants(aliceRegForKim, kimSession)
      const sharedGrant = grants.find(
        (grant) =>
          grant.registeredShapeTree === projectShapeTree &&
          grant.grantedBy === aliceId &&
          grant.dataOwner === aliceId &&
          grant.hasDataInstance?.includes(resource)
      )
      return { aliceRegForKim, sharedGrant }
    }

    // the peer mirror is refreshed by a webhook-triggered workflow, so it can
    // lag the grantor registration update that the test already awaited
    await waitFor(async () => (await loadMirror()).sharedGrant !== undefined)

    const { aliceRegForKim, sharedGrant } = await loadMirror()
    expect((await getDataGrantIris(aliceRegForKim)).length).toBeGreaterThan(0)
    expect(sharedGrant).toBeDefined()
    expect(sharedGrant!.scopeOfGrant).toBe(
      'http://www.w3.org/ns/solid/interop#SelectedFromRegistry'
    )
    expect(sharedGrant!.accessMode).toEqual([readMode])
  })
})
