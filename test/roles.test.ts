import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  type AuthorizationAgent,
  getSocialAgentRegistration,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { DataAuthorization, getDataGrantIris } from '@janeirodigital/interop-data-model'
import { loader } from '@janeirodigital/interop-utils'
const loadDataAuthorization = loader(DataAuthorization.fromJsonLd)

import { beforeEach, describe, expect, test } from 'vitest'

import {
  awaitGrantCompletion,
  dataGrants,
  waitFor,
  waitForQuiescence,
  waitForRoleCreatedCompletion,
  waitForRoleDeletedCompletion,
  waitForRoleMembershipChangedCompletion,
} from './util'

const rpcEndpoint = 'https://auth/.sai/api'

async function verifyAccessGrant(
  granteeId: string,
  grantedById: string,
  dataOwnerId: string,
  shapeTree: string,
  expectGrant: boolean
) {
  const manager = buildSessionManager()
  const granteeSession = await manager.getSession(granteeId)

  const granteeRegForGrantedBy = await granteeSession.findSocialAgentRegistration(grantedById)
  expect(granteeRegForGrantedBy).toBeDefined()
  expect(granteeRegForGrantedBy!.registeredAgent).toBe(grantedById)

  // reciprocal registration is stored as an IRI — load it on demand (SPARQL plane)
  expect(granteeRegForGrantedBy!.reciprocalRegistration).toBeDefined()

  const loadMirror = async () => {
    const grantedByRegForGrantee = await getSocialAgentRegistration(
      localSparqlTransport(granteeSession.sparqlEndpoint),
      granteeRegForGrantedBy!.reciprocalRegistration!
    )
    const grants = await dataGrants(grantedByRegForGrantee, granteeSession)
    const dataGrant = grants.find(
      (grant) =>
        grant.registeredShapeTree === shapeTree &&
        grant.grantedBy === grantedById &&
        grant.dataOwner === dataOwnerId
    )
    return { grantedByRegForGrantee, dataGrant }
  }

  // the peer mirror is refreshed by a webhook-triggered workflow, so it can
  // lag the grantor registration update that the test already awaited
  await waitFor(async () => {
    const { dataGrant } = await loadMirror()
    return expectGrant ? dataGrant !== undefined : dataGrant === undefined
  })

  const { grantedByRegForGrantee, dataGrant } = await loadMirror()
  expect(grantedByRegForGrantee.registeredAgent).toBe(granteeId)

  if (expectGrant) {
    expect((await getDataGrantIris(grantedByRegForGrantee)).length).toBeGreaterThan(0)
    expect(dataGrant).toBeDefined()
    expect(dataGrant!.scopeOfGrant).toBe('http://www.w3.org/ns/solid/interop#AllFromRegistry')
    expect(dataGrant!.dataOwner).toBe(dataOwnerId)
  } else {
    expect(dataGrant).toBeUndefined()
  }
}

function rpcPayload(request: unknown) {
  return [
    {
      request,
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]
}

async function rpcCall(payload: unknown, cookie: string) {
  const response = await fetch(rpcEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  })
  expect(response.status).toBe(200)
  const body = await response.json()
  const result = body[0]
  expect(result._tag).toBe('Success')
  return result.value
}

/**
 * Open the notification stream on the grantor's registration for `granteeId`
 * BEFORE triggering the change, then deliver the activity notification, await
 * the single registration `Update` AND the triggered chain's completion
 * (`activityCompleted` — shared `awaitGrantCompletion`), so the next write
 * can't race this chain's tail in the activity container.
 */
async function awaitGrantChange(
  grantor: AuthorizationAgent,
  granteeId: string,
  trigger: () => Promise<unknown>
): Promise<void> {
  const registration = await grantor.findSocialAgentRegistration(granteeId)
  await awaitGrantCompletion(grantor.fetch, registration.id, [grantor.webId, granteeId], trigger)
}

describe('role-based access', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const kimId = 'https://id/kim'
  const bobId = 'https://id/bob'
  const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'
  const danId = 'https://id/dan'
  const yoyoId = 'https://id/yoyo'
  const roleId = 'https://registry/alice/role/j1g128'
  const chumsRoleId = 'https://registry/alice/role/xcoq3l'
  const whizRoleId = 'https://registry/bob/role/v7emok'
  const bizRoleId = 'https://registry/bob/role/t6nwde'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'

  // no workflows from earlier tests may be running when the next test starts
  // (they mutate shared state and emit stale notifications) — drain first
  beforeEach(async () => {
    await waitForQuiescence([aliceId, kimId, bobId, danId, yoyoId])
  })

  test('create role test role', async () => {
    const body = await rpcCall(
      rpcPayload({
        _tag: 'CreateRole',
        context: aliceId,
        label: 'Test Role',
        members: [],
      }),
      aliceCookie
    )
    expect(body.id).toMatch('https://registry/alice/role/')
    expect(body.label).toBe('Test Role')
    expect(body.members).toEqual([])
    // activity-first (step 9): the ack echoes the role-to-be (pending
    // handle) + the triggering activity id (the uniform UI claim anchor);
    // the role is PUT by the createRole workflow
    expect(body.activityId).toEqual(expect.any(String))

    const manager = buildSessionManager()
    const session = await manager.getSession(aliceId)
    // wait-for end state: the workflow PUTs the role, then completes
    await waitForRoleCreatedCompletion(session)
    const role = await session.findRole(body.id)
    expect(role).toBeDefined()
    // the stored label is a language map — the untagged value under `@none`
    expect(role!.label).toEqual({ '@none': 'Test Role' })
    expect(role!.members).toEqual([])
  })

  test('delete role test', async () => {
    const manager = buildSessionManager()
    const session = await manager.getSession(aliceId)
    const role = await session.findRole(roleId)
    expect(role).toBeDefined()

    await rpcCall(
      rpcPayload({
        _tag: 'DeleteRole',
        context: aliceId,
        id: roleId,
      }),
      aliceCookie
    )

    // activity-first (step 3): the role is DELETEd by the deleteRole
    // workflow — wait for the completion, then assert the end state
    await waitForRoleDeletedCompletion(session)
    const deletedRole = await session.findRole(roleId)
    expect(deletedRole).toBeUndefined()
  })

  test('update role chums remove kim add bob', async () => {
    const body = await rpcCall(
      rpcPayload({
        _tag: 'UpdateRole',
        context: aliceId,
        id: chumsRoleId,
        label: 'Chums',
        members: [bobId],
      }),
      aliceCookie
    )
    expect(body.label).toBe('Chums')
    expect(body.members).toEqual([bobId])
    // activity-first (step 2): the ack echoes the role-to-be (pending
    // handle) + the triggering activity id (the uniform UI claim anchor);
    // the PATCH + grant regeneration run in the updateRole workflow
    expect(body.activityId).toEqual(expect.any(String))

    const manager = buildSessionManager()
    const session = await manager.getSession(aliceId)
    // wait-for end state: the workflow PATCHes the role, then completes
    await waitForRoleMembershipChangedCompletion(session)
    const role = await session.findRole(chumsRoleId)
    expect(role).toBeDefined()
    // the stored label is a language map — the untagged value under `@none`
    expect(role!.label).toEqual({ '@none': 'Chums' })
    expect(role!.members).toEqual([bobId])
  })

  test('grant is created when kim is added to role and revoked when removed', async () => {
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)

    await awaitGrantChange(aliceSession, kimId, () =>
      rpcCall(
        rpcPayload({
          _tag: 'UpdateRole',
          context: aliceId,
          id: roleId,
          label: 'Test',
          members: [kimId],
        }),
        aliceCookie
      )
    )
    // activity-first (step 2): wait for the workflow completion (the
    // registration Update arrives mid-chain — this makes the end-state read
    // deterministic)
    await waitForRoleMembershipChangedCompletion(aliceSession)
    await verifyAccessGrant(kimId, aliceId, aliceId, projectShapeTree, true)

    await awaitGrantChange(aliceSession, kimId, () =>
      rpcCall(
        rpcPayload({
          _tag: 'UpdateRole',
          context: aliceId,
          id: roleId,
          label: 'Test',
          members: [],
        }),
        aliceCookie
      )
    )
    await waitForRoleMembershipChangedCompletion(aliceSession)
    await verifyAccessGrant(kimId, aliceId, aliceId, projectShapeTree, false)
  })

  describe('AllFromRole scope', () => {
    const payload = rpcPayload({
      _tag: 'AuthorizeApp',
      context: bobId,
      authorization: {
        grantee: whizRoleId,
        accessNeedGroup: 'https://data/test-client/public/access-needs#need-group-pm',
        dataAuthorizations: [
          {
            accessNeed: 'https://data/test-client/public/access-needs#need-project',
            scope: 'AllFromRole',
            dataOwner: bizRoleId,
          },
          {
            accessNeed: 'https://data/test-client/public/access-needs#need-task',
            scope: 'Inherited',
          },
        ],
        granted: true,
      },
    })
    test('existing authorization - add remove members to roles', async () => {
      // activity-first (step 2): the RPC returns a pending ack — pre-minted
      // DataAuthorization ids + the triggering activity id; the workflow
      // materializes the DAs at those ids (asserted via the store below)
      const body = await rpcCall(payload, bobCookie)
      expect(body.activityId).toBeDefined()
      expect(body.ids.length).toBeGreaterThan(0)
      // minted in bob's authorization registry (the pre-minted ids)
      expect(body.ids[0]).toMatch('https://registry/bob/authorization/')

      const manager = buildSessionManager()
      const bobSession = await manager.getSession(bobId)
      // the dedicated workflow PUTs the DA at the pre-minted id for the role
      await waitFor(async () => {
        const da = await loadDataAuthorization(body.ids[0], bobSession.fetch).catch(() => undefined)
        return da?.grantee === whizRoleId && da?.grantedBy === bobId
      })

      const initialRole = await bobSession.findRole(whizRoleId)
      const initialMembers = initialRole?.members ?? []

      await awaitGrantChange(bobSession, danId, () =>
        rpcCall(
          rpcPayload({
            _tag: 'UpdateRole',
            context: bobId,
            id: whizRoleId,
            label: initialRole?.label?.['@none'] ?? 'Whiz',
            members: [...initialMembers, danId],
          }),
          bobCookie
        )
      )
      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, true)

      await awaitGrantChange(bobSession, danId, () =>
        rpcCall(
          rpcPayload({
            _tag: 'UpdateRole',
            context: bobId,
            id: bizRoleId,
            label: 'Biz',
            members: [],
          }),
          bobCookie
        )
      )
      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, false)
    })

    test('create authorization for role with existing members', async () => {
      const manager = buildSessionManager()
      const bobSession = await manager.getSession(bobId)

      // each RPC in its own completion barrier: the UpdateRole chain and the
      // AuthorizeApp chain both touch the seeded role authorization — running
      // them inside one trigger races them against each other (the second's
      // replacement deletes the seeded t1u13z while the first's workflow is
      // still fetching it; the seed is reloaded per test, so it is always
      // present and always the shared target).
      const regForDan = await bobSession.findSocialAgentRegistration(danId)

      await awaitGrantCompletion(bobSession.fetch, regForDan.id, [bobId, danId], async () => {
        await rpcCall(
          rpcPayload({
            _tag: 'UpdateRole',
            context: bobId,
            id: whizRoleId,
            label: 'Whiz',
            members: [danId],
          }),
          bobCookie
        )
      })

      let grantedIds: string[] = []
      await awaitGrantCompletion(bobSession.fetch, regForDan.id, [bobId, danId], async () => {
        const body = await rpcCall(payload, bobCookie)
        // activity-first (step 2): pending ack — pre-minted ids + activityId
        expect(body.activityId).toBeDefined()
        grantedIds = body.ids
        expect(grantedIds.length).toBeGreaterThan(0)
        // minted in bob's authorization registry (the pre-minted ids)
        expect(grantedIds[0]).toMatch('https://registry/bob/authorization/')
      })
      // the dedicated workflow PUTs the DA at the pre-minted id for the role
      await waitFor(async () => {
        const da = await loadDataAuthorization(grantedIds[0], bobSession.fetch).catch(
          () => undefined
        )
        return da?.grantee === whizRoleId && da?.grantedBy === bobId
      })

      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, true)
    })

    test('delete grantee role', async () => {
      // activity-first (step 2): pending ack — pre-minted ids + activityId
      const body = await rpcCall(payload, bobCookie)
      expect(body.activityId).toBeDefined()
      expect(body.ids.length).toBeGreaterThan(0)
      // minted in bob's authorization registry (the pre-minted ids)
      expect(body.ids[0]).toMatch('https://registry/bob/authorization/')

      const manager = buildSessionManager()
      const bobSession = await manager.getSession(bobId)
      // the dedicated workflow PUTs the DA at the pre-minted id for the role
      await waitFor(async () => {
        const da = await loadDataAuthorization(body.ids[0], bobSession.fetch).catch(() => undefined)
        return da?.grantee === whizRoleId && da?.grantedBy === bobId
      })

      await awaitGrantChange(bobSession, danId, () =>
        rpcCall(
          rpcPayload({
            _tag: 'UpdateRole',
            context: bobId,
            id: whizRoleId,
            label: 'Whiz',
            members: [danId],
          }),
          bobCookie
        )
      )
      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, true)

      await awaitGrantChange(bobSession, danId, () =>
        rpcCall(
          rpcPayload({
            _tag: 'DeleteRole',
            context: bobId,
            id: whizRoleId,
          }),
          bobCookie
        )
      )
      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, false)
    })

    test('delete dataOwner role', async () => {
      // activity-first (step 2): pending ack — pre-minted ids + activityId
      const body = await rpcCall(payload, bobCookie)
      expect(body.activityId).toBeDefined()
      expect(body.ids.length).toBeGreaterThan(0)
      // minted in bob's authorization registry (the pre-minted ids)
      expect(body.ids[0]).toMatch('https://registry/bob/authorization/')

      const manager = buildSessionManager()
      const bobSession = await manager.getSession(bobId)
      // the dedicated workflow PUTs the DA at the pre-minted id for the role
      await waitFor(async () => {
        const da = await loadDataAuthorization(body.ids[0], bobSession.fetch).catch(() => undefined)
        return da?.grantee === whizRoleId && da?.grantedBy === bobId
      })

      await awaitGrantChange(bobSession, danId, () =>
        rpcCall(
          rpcPayload({
            _tag: 'UpdateRole',
            context: bobId,
            id: whizRoleId,
            label: 'Whiz',
            members: [danId],
          }),
          bobCookie
        )
      )
      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, true)

      await awaitGrantChange(bobSession, danId, () =>
        rpcCall(
          rpcPayload({
            _tag: 'DeleteRole',
            context: bobId,
            id: bizRoleId,
          }),
          bobCookie
        )
      )
      await verifyAccessGrant(danId, bobId, yoyoId, projectShapeTree, false)
    })
  })
})
