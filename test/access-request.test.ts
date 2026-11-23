import { accessRequestsUrl, buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import {
  ActivityRegistry,
  type AuthorizationAgent,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { AccessRequest, type NeedBasedAccessRequestSent } from '@janeirodigital/interop-data-model'
const loadNeedBasedAccessRequest = loader(AccessRequest.fromJsonLd)

import { ACCESS_ACTIONS, loader } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  containedIris,
  needBasedAccessRequestPayload,
  parseRpcResult,
  rpcPayload,
  waitFor,
  waitForNeedBasedAccessRequestReceivedCompletion,
  waitForNeedBasedAccessRequestSentCompletion,
} from './util'

const aliceId = 'https://id/alice'
const bobId = 'https://id/bob'
const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'

/**
 * The embedded access need group — Bob requests access from Alice with
 * Project (+ inherited Task) needs. Values are (expanded-form) IRIs — the
 * payload rides the message (urn:uuid ids per the accept-invitation
 * precedent); description literals are the follow-up.
 */
const accessNeedGroup = {
  id: 'urn:uuid:6a1f3c2e-4b5d-4e6f-9a0b-1c2d3e4f5a6b',
  type: ['http://www.w3.org/ns/solid/interop#AccessNeedGroup'],
  hasAccessNeed: [
    {
      id: 'urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b',
      type: ['http://www.w3.org/ns/solid/interop#AccessNeed'],
      registeredShapeTree: 'https://data/shapetrees/trees/Project',
      required: 'http://www.w3.org/ns/solid/interop#AccessRequired',
      accessMode: [
        ACCESS_ACTIONS.read,
        ACCESS_ACTIONS.create,
        ACCESS_ACTIONS.modify,
        ACCESS_ACTIONS.delete,
      ],
      hasInheritingNeed: [
        {
          id: 'urn:uuid:8c3b5e40-6d7f-4f81-9a2b-3c4d5e6f7a8b',
          type: ['http://www.w3.org/ns/solid/interop#AccessNeed'],
          registeredShapeTree: 'https://data/shapetrees/trees/Task',
          required: 'http://www.w3.org/ns/solid/interop#AccessRequired',
          accessMode: [
            ACCESS_ACTIONS.read,
            ACCESS_ACTIONS.create,
            ACCESS_ACTIONS.modify,
            ACCESS_ACTIONS.delete,
          ],
        },
      ],
    },
  ],
}

/** The stored AccessRequests of the session's (owner's) AccessRequestRegistry
 *  — container containment (`ldp:contains` ∪ `lws:contains`) + the data-model
 *  loader (embeds the group). */
async function storedAccessRequests(session: AuthorizationAgent): Promise<Array<any>> {
  const registry = session.registrySet.hasAccessRequestRegistry
  expect(registry).toBeDefined()
  const iris = await containedIris(session, registry!.id)
  return Promise.all(iris.map((iri) => loadNeedBasedAccessRequest(iri, session.fetch)))
}

function expectRequestShape(
  request: any,
  { grantee, grantedBy, dataOwner }: { grantee: string; grantedBy: string; dataOwner: string }
) {
  expect(request.grantee).toBe(grantee)
  expect(request.grantedBy).toBe(grantedBy)
  expect(request.dataOwner).toBe(dataOwner)
  // the embedded group must be COMPLETE through the whole chain — the needs
  // incl. their inherited children ride the activity graph and the stored
  // request (sparql.md; regression: the shallow activity frame dropped the
  // children until the class-gated deep embed landed)
  const group = request.hasAccessNeedGroup
  expect(group).toBeDefined()
  expect(group.id).toBe('urn:uuid:6a1f3c2e-4b5d-4e6f-9a0b-1c2d3e4f5a6b')
  expect(group.hasAccessNeed.length).toBe(1)
  expect(group.hasAccessNeed[0].id).toBe('urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b')
  expect(group.hasAccessNeed[0].registeredShapeTree).toBe('https://data/shapetrees/trees/Project')
  // the frozen payload uses compact action terms; the stored request carries
  // the canonical ODRL/LWS IRIs
  expect(group.hasAccessNeed[0].accessMode).toEqual(
    expect.arrayContaining([
      ACCESS_ACTIONS.read,
      ACCESS_ACTIONS.create,
      ACCESS_ACTIONS.modify,
      ACCESS_ACTIONS.delete,
    ])
  )
  expect(group.hasAccessNeed[0].accessMode).toHaveLength(4)
  expect(group.hasAccessNeed[0].hasInheritingNeed.length).toBe(1)
  expect(group.hasAccessNeed[0].hasInheritingNeed[0].id).toBe(
    'urn:uuid:8c3b5e40-6d7f-4f81-9a2b-3c4d5e6f7a8b'
  )
}

describe('request access (sent side)', () => {
  test('bob sends a need-based access request to alice via the access-needs RPC', async () => {
    const response = await fetch('https://auth/.sai/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ndjson',
        Cookie: bobCookie,
      },
      body: rpcPayload({
        _tag: 'RequestAccessUsingAccessNeeds',
        dataOwner: aliceId,
        hasAccessNeedGroup: accessNeedGroup,
        context: bobId,
      }),
    })
    expect(response.status).toBe(200)
    const { _tag, value } = parseRpcResult(await response.text())
    expect(_tag).toBe('Success')
    // the pending ack — the `InvitationAcceptedMessage` shape: the requester
    // mints no real id (the owner does, receive-side phase), so only the
    // claim anchor echoes
    expect(value).toEqual({
      accepted: true,
      activityId: expect.any(String),
    })
    expect(value.activityId).toMatch(/^https:\/\/registry\/bob\/[0-9a-f-]{36}$/u)

    // the requester-side workflow forwarded the request (the data owner's
    // endpoint responded 202) and completed the activity — the done event
    const manager = buildSessionManager()
    const session: AuthorizationAgent = await manager.getSession(bobId)
    await waitForNeedBasedAccessRequestSentCompletion(session)

    // the Sent activity carries the request snapshot with the embedded group
    const registry = session.registrySet.hasActivityRegistry
    expect(registry).toBeDefined()
    const iris = await ActivityRegistry.getActivityIris(
      registry!,
      localSparqlTransport(session.sparqlEndpoint)
    )
    const sentActivities = []
    for (const iri of iris) {
      const activity = await ActivityRegistry.loadActivity(iri, session.fetch)
      if (activity.type.includes('NeedBasedAccessRequestSent')) {
        sentActivities.push(activity as NeedBasedAccessRequestSent)
      }
    }
    expect(sentActivities.length).toBe(1)
    const object = sentActivities[0].object
    expect(object.id).toMatch(/^urn:uuid:/)
    // the class term may frame bare (the context row) or as the full IRI
    expect(object.type).toContain('NeedBasedAccessRequest')
    expectRequestShape(object, { grantee: bobId, grantedBy: bobId, dataOwner: aliceId })
  })
})

describe('request access (receive side)', () => {
  test('leg A — the data owner endpoint receives and stores the request', async () => {
    const manager = buildSessionManager()
    const aliceSession: AuthorizationAgent = await manager.getSession(aliceId)
    // the earlier tests may already have delivered requests to Alice's
    // registry (the sent-side leg forwards to the same endpoint), so anchor on
    // the requests present before this POST instead of an absolute count
    const before = new Set((await storedAccessRequests(aliceSession)).map((request) => request.id))

    // Bob's UAS POSTs DIRECTLY to Alice's owner-scoped access request
    // endpoint — no RPC, no requester activity
    const session = await buildOidcSession(bobId)
    const response = await session.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: needBasedAccessRequestPayload({
        dataOwner: aliceId,
        grantedBy: bobId,
        grantee: bobId,
        group: accessNeedGroup,
      }),
    })
    expect(response.status).toBe(202)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toBe('')

    // the owner-side workflow materialized the immutable AccessRequest —
    // exactly one new resource (a retried/duplicated delivery would add more)
    const added = await waitFor(async () => {
      const fresh = (await storedAccessRequests(aliceSession)).filter(
        (request) => !before.has(request.id)
      )
      return fresh.length > 0 ? fresh : undefined
    })
    expect(added.length).toBe(1)
    expectRequestShape(added[0], { grantee: bobId, grantedBy: bobId, dataOwner: aliceId })
  })

  test('owner reads the request registry through the access request facade', async () => {
    const bob = await buildOidcSession(bobId)
    const response = await bob.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: needBasedAccessRequestPayload({
        dataOwner: aliceId,
        grantedBy: bobId,
        grantee: bobId,
        group: accessNeedGroup,
      }),
    })
    expect(response.status).toBe(202)

    const manager = buildSessionManager()
    const aliceSession: AuthorizationAgent = await manager.getSession(aliceId)
    await waitForNeedBasedAccessRequestReceivedCompletion(aliceSession)
    const [requestIri] = await containedIris(
      aliceSession,
      aliceSession.registrySet.hasAccessRequestRegistry!.id
    )
    expect(requestIri).toBeDefined()

    const alice = await buildOidcSession(aliceId)
    const container = await alice.authFetch(accessRequestsUrl(aliceId), {
      headers: { Accept: 'application/ld+json' },
    })
    expect(container.status).toBe(200)
    expect(await container.text()).toContain(requestIri)

    const head = await alice.authFetch(accessRequestsUrl(aliceId), { method: 'HEAD' })
    expect(head.status).toBe(200)

    // member reads use the owner-registry-relative member path
    const memberPath = requestIri.slice(aliceSession.registrySet.id.length)
    const member = await alice.authFetch(`${accessRequestsUrl(aliceId)}/${memberPath}`, {
      headers: { Accept: 'application/ld+json' },
    })
    expect(member.status).toBe(200)
    expect(await member.text()).toContain('NeedBasedAccessRequest')

    const forbidden = await bob.authFetch(accessRequestsUrl(aliceId), { method: 'HEAD' })
    expect(forbidden.status).toBe(403)
    const unauthenticated = await fetch(accessRequestsUrl(aliceId), {
      headers: { Accept: 'application/ld+json' },
    })
    expect(unauthenticated.status).toBe(401)
  })

  test('full sequence — the RPC leg converges on the stored request', async () => {
    const response = await fetch('https://auth/.sai/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ndjson',
        Cookie: bobCookie,
      },
      body: rpcPayload({
        _tag: 'RequestAccessUsingAccessNeeds',
        dataOwner: aliceId,
        hasAccessNeedGroup: accessNeedGroup,
        context: bobId,
      }),
    })
    expect(response.status).toBe(200)
    const { _tag, value } = parseRpcResult(await response.text())
    expect(_tag).toBe('Success')
    expect(value).toEqual({ accepted: true, activityId: expect.any(String) })

    const manager = buildSessionManager()
    const bobSession: AuthorizationAgent = await manager.getSession(bobId)
    const aliceSession: AuthorizationAgent = await manager.getSession(aliceId)
    // both sides completed — the requester forwarded (202), the owner stored
    await waitForNeedBasedAccessRequestSentCompletion(bobSession)
    await waitForNeedBasedAccessRequestReceivedCompletion(aliceSession)
    const stored = await storedAccessRequests(aliceSession)
    expect(stored.length).toBe(1)
    expectRequestShape(stored[0], { grantee: bobId, grantedBy: bobId, dataOwner: aliceId })
  })
})

describe('owner access-request endpoint — removed delegation/revocation paths', () => {
  const headers = { 'Content-Type': 'application/ld+json' }

  test('rejects a DelegationRequest payload', async () => {
    const bob = await buildOidcSession(bobId)
    const response = await bob.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers,
      body: JSON.stringify([]),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('need-based access request')
  })

  test('rejects an AccessRevocationRequest payload', async () => {
    const bob = await buildOidcSession(bobId)
    const response = await bob.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        '@context': [
          'https://www.w3.org/ns/lws/v1',
          'http://www.w3.org/ns/odrl.jsonld',
          'https://www.w3.org/ns/solid/interop-context/v1',
        ],
        type: ['AccessRequest', 'AccessRevocationRequest'],
        grants: ['https://registry/alice/does-not-exist'],
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('need-based access request')
  })
})
