import { accessRequestsUrl, buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import {
  ActivityRegistry,
  type AuthorizationAgent,
} from '@janeirodigital/interop-authorization-agent'
import { AccessRequest, grantGrantee } from '@janeirodigital/interop-data-model'
const loadAccessRequest = loader(AccessRequest.fromJsonLd)

import { ACCESS_ACTIONS, INTEROP, loader } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  accessGrants,
  awaitGrantCompletion,
  containedIris,
  needBasedAccessRequestPayload,
  rpcCall,
  rpcPayload,
  waitFor,
} from './util'

const aliceId = 'https://id/alice'
const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
const kimId = 'https://id/kim'
const kimCookie = 'css-account=77b0674a-1f3b-4c78-a7d9-0b2e3f4a5b6c'

const projectShapeTree = 'https://data/shapetrees/trees/Project'
const projectRegistration = 'https://data/alice-home/x1n3cm'
// Alice-home projects: Pulse and Glitch. Neon (n8k3wp) is deliberately left
// out; share.test.ts uses it for an unrelated grant.
const instance1 = 'https://data/alice-home/j4t7lm'
const instance2 = 'https://data/alice-home/q5m9vx'
const notRequested = 'https://data/alice-home/n8k3wp'

const needId = 'urn:uuid:9a4b1c2d-3e5f-4a6b-8c7d-9e0f1a2b3c4d'
const groupId = 'urn:uuid:6a1f3c2e-4b5d-4e6f-9a0b-1c2d3e4f5a6b'

const accessNeedGroup = {
  id: groupId,
  type: [INTEROP.AccessNeedGroup],
  hasAccessNeed: [
    {
      id: needId,
      type: [INTEROP.AccessNeed],
      registeredShapeTree: projectShapeTree,
      required: INTEROP.AccessRequired,
      accessMode: [
        ACCESS_ACTIONS.read,
        ACCESS_ACTIONS.create,
        ACCESS_ACTIONS.modify,
        ACCESS_ACTIONS.delete,
      ],
      hasDataInstance: [instance1, instance2],
      hasDataRegistration: projectRegistration,
    },
  ],
}

async function storedRequestForKim(
  session: AuthorizationAgent,
  instance = instance1
): Promise<{
  id: string
  request: any
}> {
  const registry = session.registrySet.hasAccessRequestRegistry
  expect(registry).toBeDefined()
  const iris = await containedIris(session, registry!.id)
  for (const iri of iris) {
    const request = await loadAccessRequest(iri, session.fetch)
    const needs = request.hasAccessNeedGroup.hasAccessNeed as Array<Record<string, unknown>>
    if (
      request.grantee === kimId &&
      needs.some(
        (need) =>
          need.registeredShapeTree === projectShapeTree &&
          (need.hasDataInstance as string[] | undefined)?.includes(instance)
      )
    ) {
      return { id: iri, request }
    }
  }
  throw new Error('stored request for Kim not found')
}

describe('specific-instance access request', () => {
  test('requesting N1/N2 produces grants limited to those instances', async () => {
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)

    // 1. Kim requests the two specific Project instances
    const sent = await rpcCall(
      rpcPayload({
        _tag: 'RequestAccessUsingAccessNeeds',
        dataOwner: aliceId,
        hasAccessNeedGroup: accessNeedGroup,
        context: kimId,
      }),
      kimCookie
    )
    expect(sent).toEqual({ accepted: true, activityId: expect.any(String) })

    // requester forwarded + owner stored (poll for THIS request; the
    // activity-completion helpers also match earlier requests in the suite)
    const stored = await waitFor(() => storedRequestForKim(aliceSession).catch(() => undefined))
    const requestIri = stored.id
    const [need] = stored.request.hasAccessNeedGroup.hasAccessNeed as Array<Record<string, unknown>>
    expect(need.hasDataInstance).toEqual([instance1, instance2])
    expect(need.hasDataRegistration).toBe(projectRegistration)

    // 2. The owner approval view receives the requested instances
    const authorizationData = await rpcCall<{
      accessNeedGroup: { needs: Array<Record<string, unknown>> }
    }>(
      rpcPayload({
        _tag: 'GetAuthoriaztionData',
        agentId: kimId,
        lang: 'en',
        accessRequestIri: requestIri,
        context: aliceId,
      }),
      aliceCookie
    )
    const [requestedNeed] = authorizationData.accessNeedGroup.needs
    expect(requestedNeed.id).toBe(needId)
    expect(requestedNeed.dataInstances).toEqual([instance1, instance2])
    expect(requestedNeed.dataRegistration).toBe(projectRegistration)

    // 3. Alice approves exactly the requested instances
    const regForKim = await aliceSession.findSocialAgentRegistration(kimId)
    expect(regForKim).toBeDefined()
    await awaitGrantCompletion(aliceSession.fetch, regForKim!.id, [aliceId, kimId], async () => {
      const granted = await rpcCall(
        rpcPayload({
          _tag: 'AuthorizeApp',
          accessRequestIri: requestIri,
          authorization: {
            grantee: kimId,
            accessNeedGroup: groupId,
            dataAuthorizations: [
              {
                accessNeed: needId,
                scope: 'SelectedFromRegistry',
                dataOwner: aliceId,
                dataRegistration: projectRegistration,
                dataInstances: [instance1, instance2],
              },
            ],
            granted: true,
          },
          context: aliceId,
        }),
        aliceCookie
      )
      expect(granted.activityId).toBeDefined()
      expect(granted.ids.length).toBeGreaterThan(0)
    })

    // 4. The authorization is instance-scoped
    const authorizations = await rpcCall<Array<Record<string, unknown>>>(
      rpcPayload({
        _tag: 'ListAuthorizations',
        grantee: kimId,
        lang: 'en',
        context: aliceId,
      }),
      aliceCookie
    )
    const recorded = authorizations.find(
      (authorization) =>
        authorization.satisfiesAccessNeed === needId &&
        authorization.registeredShapeTree === projectShapeTree
    )
    expect(recorded).toBeDefined()
    expect(recorded!.scopeOfAuthorization).toBe(INTEROP.SelectedFromRegistry)
    expect(recorded!.hasDataRegistration).toBe(projectRegistration)
    expect([...(recorded!.hasDataInstance as string[])].toSorted()).toEqual(
      [instance1, instance2].toSorted()
    )

    // 5. The generated grant stays limited to the requested instances
    const regAfter = await aliceSession.findSocialAgentRegistration(kimId)
    expect(regAfter).toBeDefined()
    const grants = await accessGrants(regAfter!, aliceSession)
    const targeted = grants.find(
      (grant) =>
        grant.registeredShapeTree === projectShapeTree &&
        grant.scopeOfGrant === INTEROP.SelectedFromRegistry &&
        grantGrantee(grant) === kimId &&
        grant.hasDataInstance?.length === 2 &&
        grant.hasDataInstance?.includes(instance1) &&
        grant.hasDataInstance?.includes(instance2)
    )
    expect(targeted).toBeDefined()
    expect(targeted!.hasDataInstance).not.toContain(notRequested)

    const assetSources = targeted!.access
      .flatMap((policy) => policy.permission)
      .map((permission) => permission.target)
      .filter((target) => target.type.includes('http://www.w3.org/ns/odrl/2/Asset'))
      .flatMap((target) => target.source)
    expect(new Set(assetSources)).toEqual(new Set([instance1, instance2]))

    // 6. The requester-side detector sees the instance coverage and resolves
    // the open request (the terminal AccessRequestGranted activity).
    const kimSession = await buildSessionManager().getSession(kimId)
    const grantedActivity = await waitFor(
      async () => {
        const registry = kimSession.registrySet.hasActivityRegistry
        if (!registry) return undefined
        const iris = await ActivityRegistry.getActivityIris(registry, kimSession.fetch)
        for (const iri of iris) {
          const activity = await ActivityRegistry.loadActivity(iri, kimSession.fetch)
          if (activity.type.includes('AccessRequestGranted')) return activity
        }
        return undefined
      },
      { timeout: 30_000 }
    )
    expect(grantedActivity).toBeDefined()
  })
})

describe('owner endpoint — instance need payload', () => {
  test('accepts a SAI need with hasDataInstance', async () => {
    const kim = await buildOidcSession(kimId)
    const response = await kim.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: needBasedAccessRequestPayload({
        dataOwner: aliceId,
        grantedBy: kimId,
        grantee: kimId,
        group: accessNeedGroup,
      }),
    })
    const body = await response.text()
    expect(response.status, body).toBe(202)
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)
    await waitFor(() => storedRequestForKim(aliceSession).catch(() => undefined), {
      timeout: 30_000,
    })
  })
})

describe('plain LWS access request', () => {
  test('accepts the ODRL Asset shape and maps it to an instance need', async () => {
    const kim = await buildOidcSession(kimId)
    const response = await kim.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': [
          'https://www.w3.org/ns/lws/v1',
          'http://www.w3.org/ns/odrl.jsonld',
          'https://www.w3.org/ns/solid/interop-context/v1',
        ],
        type: ['AccessRequest'],
        access: [
          {
            type: ['Request'],
            uid: 'urn:uuid:0f5f6a7b-8c9d-4e0f-1a2b-3c4d5e6f7a8b',
            profile: 'https://www.w3.org/ns/lws#AccessProfile',
            permission: [
              {
                action: ['read'],
                assignee: kimId,
                target: {
                  type: ['Asset'],
                  source: [notRequested],
                },
              },
            ],
          },
        ],
      }),
    })
    const body = await response.text()
    expect(response.status, body).toBe(202)
    expect(response.headers.get('location')).toBeTruthy()

    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)
    const stored = await waitFor(
      () => storedRequestForKim(aliceSession, notRequested).catch(() => undefined),
      { timeout: 30_000 }
    )
    const [need] = stored.request.hasAccessNeedGroup.hasAccessNeed as Array<Record<string, unknown>>
    expect(need.hasDataInstance).toEqual([notRequested])
    expect(need.hasDataRegistration).toBe(projectRegistration)
    expect(need.accessMode).toEqual([ACCESS_ACTIONS.read])
  })
})
