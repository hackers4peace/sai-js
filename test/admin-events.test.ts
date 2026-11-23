import { buildSessionManager } from '@elfpavlik/sai-components'
import { ActivityRegistry, localSparqlTransport } from '@janeirodigital/interop-authorization-agent'
import { Grant, grantGrantee } from '@janeirodigital/interop-data-model'
const loadGrant = loader(Grant.fromJsonLd)

import {
  INTEROP,
  discoverAccessResource,
  fetchJsonLd,
  loader,
  toStore,
} from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  awaitEvent,
  containedIris,
  openEventsStream,
  rpcCall,
  rpcPayload,
  waitForRoleCreatedCompletion,
} from './util'

/**
 * Phase 3 of org-admin-feature.md — admin events forwarding.
 *
 * The admin's UI stream (`/.sai/events`, keyed under the admin's webId)
 * receives org-context activity outcomes through seeded webhook channels the
 * admin's AA holds on each org's Activity Registry (kv.json `**activityWebhook**`):
 * dan has a personal channel (`topic` = dan's own Activity Registry, where he
 * is the *owner*) and a YoYo admin channel (`topic` = YoYo's Activity
 * Registry, where he is an *observer* — forwarding only, no workflow
 * dispatch). `ActivityWebhookHandler` serves both kinds from the same
 * endpoint, discriminated by whether the channel's webId owns the topic.
 *
 * Seed: Dan is an admin of YoYo (`ph8e70` + `#fullAdminAccess`); bob is a
 * plain member — each test re-seeds kv.json + registry.trig (`beforeEach`).
 */

const danId = 'https://id/dan'
const danCookie = 'css-account=4f8fe6e4-4a5a-4318-93f6-d8645778fc28'
const bobId = 'https://id/bob'
const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'
const yoyoId = 'https://id/yoyo'

/** The registry owner an activity belongs to — its actor (as:actor, plain IRI). */
function activityOwner(activity: { actor?: string }): string | undefined {
  return activity.actor
}

describe('org context — admin event forwarding (phase 3)', () => {
  test('the admin receives org-context admin activities (pending + done) on their stream', async () => {
    // listen first — the server never replays
    const stream = await openEventsStream(danCookie)

    // promote bob (activity-first step 5 — the RPC pre-mints the
    // AdminAuthorization id + writes the activity only; the workflow PUTs
    // the resource, runs grants/ACR; dan's admin channel must forward the
    // whole lifecycle to his stream)
    const promoted = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    // pending ack: the pre-minted AdminAuthorization id + the activity id
    // (the uniform UI claim anchor)
    expect(promoted.activityId).toEqual(expect.any(String))

    const pending = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('AdminAuthorizationGranted') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(pending).toBeDefined()
    expect(activityOwner(pending!.activity)).toBe(yoyoId)

    const done = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === pending?.activity.id &&
        message.activity.status === 'done'
    )
    expect(done).toBeDefined()
    expect(done!.activity.actor).toBe(yoyoId)

    // demote bob again — the distinct adminAuthorizationRevoked activity flows
    // through the same channel (distinct shape, no granted-flag reuse);
    // activity-first (step 6): the ack echoes the revoked AdminAuthorization
    // id + the activity id (the uniform UI claim anchor)
    const stream2 = await openEventsStream(danCookie)
    const demoted = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'RemoveAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    expect(demoted.id).toMatch(/^https:\/\/registry\/yoyo\/[0-9a-f-]{36}$/u)
    expect(demoted.activityId).toEqual(expect.any(String))

    const revoked = await awaitEvent(
      stream2,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('AdminAuthorizationRevoked') &&
        message.activity.status === 'done'
    )
    expect(revoked).toBeDefined()
    expect(revoked!.activity.actor).toBe(yoyoId)
  })

  test('org-context role activities are forwarded to the admin stream (type-general)', async () => {
    const stream = await openEventsStream(danCookie)

    // a role change in the org context produces roleMembershipChanged in YoYo's
    // Activity Registry (owner channel dispatches the workflow; dan's admin
    // channel forwards pending/done)
    const role = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'CreateRole', label: 'YoYo Watch', members: [], context: yoyoId }),
      danCookie
    )
    // activity-first (step 9): the role is PUT by the createRole workflow —
    // wait for it before the UpdateRole guard reads it
    const yoyoSession = (await buildSessionManager().getSession(yoyoId)) as never
    await waitForRoleCreatedCompletion(yoyoSession as never)
    const updated = await rpcCall<{ id: string }>(
      rpcPayload({
        _tag: 'UpdateRole',
        id: role.id,
        label: 'YoYo Watch',
        members: [bobId],
        context: yoyoId,
      }),
      danCookie
    )
    expect(updated.id).toBe(role.id)

    const done = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('RoleMembershipChanged') &&
        message.activity.status === 'done'
    )
    expect(done).toBeDefined()
    // step 2: `target` dropped — the changed role's id rides `object.id`
    // (the real-id embedded role-to-be in the activity's as:object)
    expect(done!.activity.object.id).toBe(role.id)
    expect(activityOwner(done!.activity)).toBe(yoyoId)
  })

  test("the admin's personal channel delivers their own registry activities (owner path, keyed by the admin webId)", async () => {
    const stream = await openEventsStream(danCookie)

    // dan's own registry: he is the owner, so his personal channel runs the
    // owner path (forward + dispatch) — but the events still land on his stream
    const role = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'CreateRole', label: 'Dan Ops', members: [], context: danId }),
      danCookie
    )
    // activity-first (step 9): wait for the createRole workflow before the
    // DeleteRole guard reads the role
    const danSession = (await buildSessionManager().getSession(danId)) as never
    await waitForRoleCreatedCompletion(danSession as never)
    // DeleteRole returns Void — the roleDeleted activity is the observable
    await rpcCall<unknown>(
      rpcPayload({ _tag: 'DeleteRole', id: role.id, context: danId }),
      danCookie
    )

    const done = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('RoleDeleted') &&
        message.activity.status === 'done' &&
        // step 3: `target` dropped — the deleted role's id rides `object.id`
        // (the real-id embedded role-to-be-deleted in the as:object)
        message.activity.object.id === role.id
    )
    expect(done).toBeDefined()
    expect(activityOwner(done!.activity)).toBe(danId)
  })

  test("a promoted admin's UI learns about it via the reciprocal channel (delegatedGrantsUpdated)", async () => {
    // bob has no org channel — his own-status-change signal is the §2.5
    // reciprocal path: the hasAdminGrant PATCH on YoYo's registration of bob
    // (z3k7wm) → bob's reciprocal webhook → delegatedGrantsUpdated in bob's
    // own Activity Registry → his personal activity channel → his UI stream
    const stream = await openEventsStream(bobCookie)

    const promoted = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    expect(promoted.activityId).toEqual(expect.any(String))

    const pending = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('DelegatedGrantsUpdated') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(pending).toBeDefined()
    expect(pending!.activity.actor).toBe(bobId)
    expect(pending!.activity.target).toBe(yoyoId)

    const done = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === pending?.activity.id &&
        message.activity.status === 'done'
    )
    expect(done).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Phase 4 guards — ACR integrity, completion-after-both, no cross-org
// dispatch. These assert the state *behind* the forwarded events: the org
// `.acr` rewrite must have succeeded before the activity completes (the old
// parallel dispatch marked done while `syncAdminAcr` failed, and successful
// runs wrote duplicate completions), and an admin change in the YoYo context
// must leave Dan's own registries untouched (the dan-credited phantom runs).
// ──────────────────────────────────────────────────────────────────────────

const acp = {
  AccessControl: 'http://www.w3.org/ns/solid/acp#AccessControl',
  apply: 'http://www.w3.org/ns/solid/acp#apply',
  anyOf: 'http://www.w3.org/ns/solid/acp#anyOf',
  agent: 'http://www.w3.org/ns/solid/acp#agent',
}

/**
 * The registry set's ACR + its document, read as the webid — 4xx fails the
 * test. Discovery uses `discoverAccessResource` (an explicit `Accept`): the
 * registry set is a storage root, and a wildcard HEAD gets the LWS storage
 * description, which has no `acl` link.
 */
async function fetchRegistrySetAcr(webId: string): Promise<{ acrId: string; doc: unknown }> {
  const manager = buildSessionManager()
  const session = await manager.getSession(webId)
  const acrId = await discoverAccessResource(session.registrySet.id, session.fetch)
  if (!acrId) {
    throw new Error(`no acl link on registry set: ${session.registrySet.id}`)
  }
  return { acrId, doc: await fetchJsonLd(acrId, session.fetch) }
}

/** `acp:agent` values of every matcher under the registry set's `#fullAdminAccess`. */
async function fullAdminAccessAgents(webId: string): Promise<string[]> {
  const { acrId, doc } = await fetchRegistrySetAcr(webId)
  const store = await toStore(doc as Record<string, unknown>, acrId)
  const policies = new Set<string>()
  const matchers = new Set<string>()
  for (const quad of store) {
    if (quad.predicate.value === acp.apply && quad.subject.value.endsWith('#fullAdminAccess')) {
      policies.add(quad.object.value)
    }
  }
  for (const quad of store) {
    if (policies.has(quad.subject.value) && quad.predicate.value === acp.anyOf) {
      matchers.add(quad.object.value)
    }
  }
  const agents: string[] = []
  for (const quad of store) {
    if (matchers.has(quad.subject.value) && quad.predicate.value === acp.agent) {
      agents.push(quad.object.value)
    }
  }
  return [...new Set(agents)]
}

/** `target`s of every completion in the webId's Activity Registry. */
async function completedActivityTargets(webId: string): Promise<string[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(webId)
  return ActivityRegistry.getCompletedActivityIris(
    session.registrySet.hasActivityRegistry,
    localSparqlTransport(session.sparqlEndpoint)
  )
}

/** AdminGrant IRIs in the webId's GrantRegistry for the given grantee. */
async function adminGrantIris(webId: string, grantee: string): Promise<string[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(webId)
  const registry = session.registrySet.hasGrantRegistry
  const iris = await containedIris(session, registry.id)
  const adminGrants: string[] = []
  for (const iri of iris) {
    const grant = await loadGrant(iri, session.fetch)
    if (grant.type.includes(INTEROP.AdminGrant) && grantGrantee(grant) === grantee) {
      adminGrants.push(iri)
    }
  }
  return adminGrants
}

describe('org context — ACR + completion integrity (phase 4 guards)', () => {
  test('the activity completes only after the ACR rewrite lists the new admin — no masking, no duplicate completion', async () => {
    const stream = await openEventsStream(danCookie)

    const promoted = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    expect(promoted.activityId).toEqual(expect.any(String))

    const pending = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('AdminAuthorizationGranted') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(pending).toBeDefined()
    const done = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === pending?.activity.id &&
        message.activity.status === 'done'
    )
    expect(done).toBeDefined()

    // done ⇒ the derived ACR rewrite already succeeded and lists bob (+ dan)
    const agents = await fullAdminAccessAgents(yoyoId)
    expect(agents).toEqual(expect.arrayContaining([danId, bobId]))

    // exactly one completion for the activity — the old parallel dispatch wrote
    // two (both workflows marked done) or completed while the ACR rewrite failed
    const targets = await completedActivityTargets(yoyoId)
    expect(targets.filter((target) => target === pending!.activity.id)).toHaveLength(1)
  })

  test('promoting in the YoYo context leaves the admin’s own registries untouched (no cross-org dispatch)', async () => {
    const stream = await openEventsStream(danCookie)
    await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    const pending = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('AdminAuthorizationGranted') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(pending).toBeDefined()
    await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === pending?.activity.id &&
        message.activity.status === 'done'
    )

    // the intended org got the admin
    expect(await fullAdminAccessAgents(yoyoId)).toEqual(expect.arrayContaining([bobId]))

    // …and the admin's own registry set must carry no admin artifacts for bob
    expect(await adminGrantIris(danId, bobId)).toHaveLength(0)
    const manager = buildSessionManager()
    const session = await manager.getSession(danId)
    const registration = await session.findSocialAgentRegistration(bobId)
    expect(registration?.hasAdminGrant ?? []).toHaveLength(0)
    const { doc } = await fetchRegistrySetAcr(danId)
    expect(JSON.stringify(doc)).not.toContain('#fullAdminAccess')
  })

  test('demotion removes the admin from the ACR while keeping the remaining admin', async () => {
    const stream = await openEventsStream(danCookie)
    await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    const addPending = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('AdminAuthorizationGranted') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(addPending).toBeDefined()
    await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === addPending?.activity.id &&
        message.activity.status === 'done'
    )

    const stream2 = await openEventsStream(danCookie)
    const demoted = await rpcCall<{ id: string }>(
      rpcPayload({ _tag: 'RemoveAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    expect(demoted.id).toMatch(/^https:\/\/registry\/yoyo\/[0-9a-f-]{36}$/u)
    expect(demoted.activityId).toEqual(expect.any(String))

    const revokedPending = await awaitEvent(
      stream2,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('AdminAuthorizationRevoked') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(revokedPending).toBeDefined()
    const revokedDone = await awaitEvent(
      stream2,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === revokedPending?.activity.id &&
        message.activity.status === 'done'
    )
    expect(revokedDone).toBeDefined()

    // bob is gone from the ACR, dan remains — and a single completion again
    expect(await fullAdminAccessAgents(yoyoId)).toEqual([danId])
    const targets = await completedActivityTargets(yoyoId)
    expect(targets.filter((target) => target === revokedPending!.activity.id)).toHaveLength(1)
  })
})
