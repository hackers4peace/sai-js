import { accessRequestsUrl, buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import { grantShapeTree } from '@janeirodigital/interop-data-model'
import { CONTEXT, ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import { Client, Connection } from '@temporalio/client'
import { describe, expect, test } from 'vitest'

import {
  awaitGrantCompletion,
  containedIris,
  accessGrants,
  needBasedAccessRequestPayload,
  parseRpcResult,
  rpcCall,
  rpcPayload as encodeRpc,
  waitForActivityCompletion,
  waitForNeedBasedAccessRequestReceivedCompletion,
} from './util'

// TODO: import
const clientId = 'https://data/test-client/public/id'
const accessNeedGroup = 'https://data/test-client/public/access-needs#need-group-pm'
const bobId = 'https://id/bob'

function rpcPayload(authorization: unknown) {
  return encodeRpc({ _tag: 'AuthorizeApp', authorization, context: bobId })
}

describe('get authorization data', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const lang = 'en'

  const payload = encodeRpc({
    _tag: 'GetAuthoriaztionData',
    agentId: clientId,
    lang,
    context: aliceId,
  })

  test('responds with authorization data', async () => {
    const response = await fetch('https://auth/.sai/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ndjson',
        Cookie: aliceCookie,
      },
      body: payload,
    })
    expect(response.status).toBe(200)
    const { _tag, value } = parseRpcResult(await response.text())
    expect(_tag).toBe('Success')
    expect(value).toEqual(expect.objectContaining({ id: clientId }))
    expect(value.accessNeedGroup).toEqual(
      expect.objectContaining({
        label: 'Manage Projects',
        lang,
      })
    )
    expect(value.dataOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: aliceId }),
        expect.objectContaining({ id: 'https://id/acme' }),
      ])
    )
    expect(value.accessNeedGroup.needs).toEqual(
      expect.arrayContaining([
        {
          id: 'https://data/test-client/public/access-needs#need-project',
          label:
            'Access to Projects is essential for Projectron to perform its core function of Project Management.',
          required: true,
          access: expect.arrayContaining([
            'http://www.w3.org/ns/odrl/2/read',
            'https://www.w3.org/ns/lws#create',
            'http://www.w3.org/ns/odrl/2/modify',
            'http://www.w3.org/ns/odrl/2/delete',
          ]),
          shapeTree: { id: 'https://data/shapetrees/trees/Project', label: 'Projects' },
          children: expect.arrayContaining([
            expect.objectContaining({
              id: 'https://data/test-client/public/access-needs#need-task',
            }),
            expect.objectContaining({
              id: 'https://data/test-client/public/access-needs#need-image',
            }),
            expect.objectContaining({
              id: 'https://data/test-client/public/access-needs#need-file',
            }),
          ]),
        },
      ])
    )
  })
})

describe('denied', () => {
  const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'

  const grantedAuthorization = {
    grantee: clientId,
    accessNeedGroup,
    dataAuthorizations: [
      {
        accessNeed: 'https://data/test-client/public/access-needs#need-project',
        scope: 'AllFromAgent',
        dataOwner: bobId,
      },
      { accessNeed: 'https://data/test-client/public/access-needs#need-task', scope: 'Inherited' },
      { accessNeed: 'https://data/test-client/public/access-needs#need-image', scope: 'Inherited' },
      { accessNeed: 'https://data/test-client/public/access-needs#need-file', scope: 'Inherited' },
    ],
    granted: true,
  }

  const deniedAuthorization = {
    grantee: clientId,
    accessNeedGroup,
    granted: false,
  }

  test('creates denied authorization', async () => {
    const manager = buildSessionManager()
    const session = await manager.getSession(bobId)
    const registration = await session.findApplicationRegistration(clientId)
    expect(registration).toBeDefined()

    // grant first — authorizationGranted activity → grants appear on the
    // application registration; wait for the chain's completion (shared
    // barrier: Update + quiescence, so the deny below can't race the tail)
    await awaitGrantCompletion(session.fetch, registration.id, [bobId], async () => {
      const granted = await rpcCall(rpcPayload(grantedAuthorization), bobCookie)
      // activity-first (step 2): the RPC returns a pending ack — pre-minted
      // DataAuthorization ids + the triggering activity id (the workflow
      // materializes the DAs at those ids)
      expect(granted.activityId).toBeDefined()
      expect(granted.ids.length).toBeGreaterThan(0)
    })
    expect(
      (await session.findApplicationRegistration(clientId))?.hasDataGrant?.length
    ).toBeGreaterThan(0)

    // deny — SILENT DECLINE (Step 4, authorization-granting.md): a
    // `AuthorizationDenied`, forward-only — no delete, no grant clear, no
    // workflow. The RPC is the same pending ack (the denial activity id; no
    // DAs minted — ids []). A pure decline produces NO registration Update,
    // so the activity's only terminal is the reconcile sweep: run it and
    // await the completion (the sweep's `reconcileActivities` marks the
    // `AuthorizationDenied` row done — Step 4 branch).
    const denied = await rpcCall(rpcPayload(deniedAuthorization), bobCookie)
    expect(denied.activityId).toBeDefined()
    expect(denied.ids).toHaveLength(0)
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    })
    const client = new Client({ connection })
    await client.workflow.execute('reconcileActivities', {
      taskQueue: 'create-grants',
      args: [{ webId: { id: bobId, type: [INTEROP.SocialAgent] } }],
      workflowId: 'authorization-deny-sweep',
    })
    await waitForActivityCompletion(session, 'AuthorizationDenied')

    // grant and grants remain UNTOUCHED (the old "grant → deny → grants
    // cleared" behavior was the accidental delete — now the revocation
    // plan's revoke action; this assertion moved to authorization-revocation)
    const authorizations = await session.findAuthorizationsForAgent(clientId)
    expect(authorizations.length).toBeGreaterThan(0)
    const regAfterDeny = await session.findApplicationRegistration(clientId)
    expect((regAfterDeny?.hasDataGrant ?? []).length).toBeGreaterThan(0)
  })
})

describe('approve a need-based access request', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const bobId = 'https://id/bob'
  const INTEROP = 'http://www.w3.org/ns/solid/interop#'

  const accessNeedGroup = {
    id: 'urn:uuid:6a1f3c2e-4b5d-4e6f-9a0b-1c2d3e4f5a6b',
    type: [`${INTEROP}AccessNeedGroup`],
    hasAccessNeed: [
      {
        id: 'urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b',
        type: [`${INTEROP}AccessNeed`],
        registeredShapeTree: 'https://data/shapetrees/trees/Project',
        required: `${INTEROP}AccessRequired`,
        accessMode: [
          ACCESS_ACTIONS.read,
          ACCESS_ACTIONS.create,
          ACCESS_ACTIONS.modify,
          ACCESS_ACTIONS.delete,
        ],
        hasInheritingNeed: [
          {
            id: 'urn:uuid:8c3b5e40-6d7f-4f81-9a2b-3c4d5e6f7a8b',
            type: [`${INTEROP}AccessNeed`],
            registeredShapeTree: 'https://data/shapetrees/trees/Task',
            required: `${INTEROP}AccessRequired`,
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

  test('alice approves bobs request — authorization data from the request, grants follow', async () => {
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)

    // setup: Bob requests access from Alice via her owner-scoped access
    // request endpoint — the request is stored in Alice's AccessRequestRegistry
    const bob = await buildOidcSession(bobId)
    const sent = await bob.authFetch(accessRequestsUrl(aliceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: needBasedAccessRequestPayload({
        dataOwner: aliceId,
        grantedBy: bobId,
        grantee: bobId,
        group: accessNeedGroup,
      }),
    })
    expect(sent.status).toBe(202)
    await waitForNeedBasedAccessRequestReceivedCompletion(aliceSession)

    const registry = aliceSession.registrySet.hasAccessRequestRegistry
    expect(registry).toBeDefined()
    const [requestIri] = await containedIris(aliceSession, registry!.id)
    expect(requestIri).toBeDefined()
    expect(requestIri).toMatch(/^https:\/\/registry\/alice\/[0-9a-f-]{36}$/u)

    // the authorization data resolves from the EMBEDDED group in the request
    // (accessRequestIri) — no client-id doc, no reciprocal registration
    const getDataResponse = await fetch('https://auth/.sai/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/ndjson', Cookie: aliceCookie },
      body: encodeRpc({
        _tag: 'GetAuthoriaztionData',
        agentId: bobId,
        lang: 'en',
        accessRequestIri: requestIri,
        context: aliceId,
      }),
    })
    expect(getDataResponse.status).toBe(200)
    const dataResult = parseRpcResult(await getDataResponse.text())
    expect(dataResult._tag).toBe('Success')
    const authorizationData = dataResult.value
    expect(authorizationData).toEqual(
      expect.objectContaining({
        id: bobId,
        accessNeedGroup: expect.objectContaining({
          id: accessNeedGroup.id,
          needs: expect.arrayContaining([
            expect.objectContaining({
              id: accessNeedGroup.hasAccessNeed[0].id,
              required: true,
              access: expect.arrayContaining([
                ACCESS_ACTIONS.read,
                ACCESS_ACTIONS.create,
                ACCESS_ACTIONS.modify,
                ACCESS_ACTIONS.delete,
              ]),
              shapeTree: expect.objectContaining({
                id: 'https://data/shapetrees/trees/Project',
                label: 'Projects',
              }),
              children: expect.arrayContaining([
                expect.objectContaining({
                  id: 'urn:uuid:8c3b5e40-6d7f-4f81-9a2b-3c4d5e6f7a8b',
                  shapeTree: expect.objectContaining({
                    id: 'https://data/shapetrees/trees/Task',
                    label: 'Tasks',
                  }),
                }),
              ]),
            }),
          ]),
        }),
      })
    )
    expect(authorizationData.dataOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: aliceId,
          dataRegistrations: [
            expect.objectContaining({
              id: 'https://data/alice-work/sx86hi',
              dataRegistry: 'https://data/alice-work/',
              // the registration label is its shape tree's label — never a
              // slice of the (flat) registration IRI
              label: 'Projects',
              shapeTree: 'https://data/shapetrees/trees/Project',
              count: 1,
            }),
            expect.objectContaining({
              id: 'https://data/alice-home/x1n3cm',
              dataRegistry: 'https://data/alice-home/',
              label: 'Projects',
              shapeTree: 'https://data/shapetrees/trees/Project',
              count: 3,
            }),
          ],
        }),
        expect.objectContaining({
          id: 'https://id/acme',
          dataRegistrations: [
            expect.objectContaining({
              id: 'https://data/acme-rnd/reb39k',
              label: 'Projects',
              shapeTree: 'https://data/shapetrees/trees/Project',
              count: 1,
            }),
          ],
        }),
      ])
    )

    // alice approves — the existing authorization + grant generation
    const bobRegistration = await aliceSession.findSocialAgentRegistration(bobId)
    expect(bobRegistration).toBeDefined()
    await awaitGrantCompletion(aliceSession.fetch, bobRegistration!.id, [aliceId], async () => {
      const granted = await rpcCall(
        encodeRpc({
          _tag: 'AuthorizeApp',
          accessRequestIri: requestIri,
          authorization: {
            grantee: bobId,
            accessNeedGroup: accessNeedGroup.id,
            dataAuthorizations: [
              {
                accessNeed: accessNeedGroup.hasAccessNeed[0].id,
                scope: 'AllFromAgent',
                dataOwner: aliceId,
              },
              {
                accessNeed: accessNeedGroup.hasAccessNeed[0].hasInheritingNeed[0].id,
                scope: 'Inherited',
              },
            ],
            granted: true,
          },
          context: aliceId,
        }),
        aliceCookie
      )
      // activity-first (step 2): pending ack — the workflow materializes the
      // DataAuthorizations at the pre-minted ids
      expect(granted.activityId).toBeDefined()
      expect(granted.ids.length).toBeGreaterThan(0)
    })

    const regAfter = await aliceSession.findSocialAgentRegistration(bobId)
    expect((regAfter?.hasDataGrant ?? []).length).toBeGreaterThan(0)

    // regression guard (authorization-granting.md activity-first): the FRAMED
    // activity drops the parent's `@reverse` child list, and grant generation
    // must still emit the INHERITED child grant — a count-only check passes
    // with the parent grant alone (exactly why the missing Task grant slipped
    // through: test/ had no shape assertion on runtime-generated grants).
    const grantsAfter = await accessGrants(regAfter!, aliceSession)
    const projectGrants = grantsAfter.filter(
      (grant) => grantShapeTree(grant) === 'https://data/shapetrees/trees/Project'
    )
    const taskGrants = grantsAfter.filter(
      (grant) => grantShapeTree(grant) === 'https://data/shapetrees/trees/Task'
    )
    expect(projectGrants.length).toBeGreaterThan(0)
    expect(taskGrants.length).toBeGreaterThan(0)
    // FULL parent↔child linkage per child, not a single pair: an
    // AllFromAgent approval spans every registry of the tree (alice-home AND
    // the seeded alice-work grants), so the first Project/Task match may
    // belong to different registries
    for (const taskGrant of taskGrants) {
      expect(taskGrant.scopeOfGrant).toBe(CONTEXT.Inherited)
      const parent = grantsAfter.find((grant) => grant.id === taskGrant.inheritsFromGrant)
      expect(parent).toBeDefined()
      expect(grantShapeTree(parent!)).toBe('https://data/shapetrees/trees/Project')
      expect(parent!.hasInheritingGrant).toContain(taskGrant.id)
    }

    // the request stays unchanged — granting only references it (immutable)
    const [requestIriAfter] = await containedIris(aliceSession, registry!.id)
    expect(requestIriAfter).toBe(requestIri)
  })
})
