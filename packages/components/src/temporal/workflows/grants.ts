import type {
  ActivityData,
  AdminAuthorizationGranted,
  AdminAuthorizationRevoked,
  AgentId,
  AuthorizationGranted,
  AuthorizationGrantedId,
  AuthorizationRevoked,
  DataAuthorizationData,
  DataAuthorizationRef,
  DelegatedGrantsUpdated,
  FinalDataAuthorizationData,
  FinalGrantData,
  GeneratedGrants,
  GrantData,
  GrantId,
  InvitationCreated,
  NeedBasedAccessRequestReceived,
  NeedBasedAccessRequestSent,
  RoleCreated,
  RoleCreatedId,
  RoleData,
  RoleDeleted,
  RoleDeletedId,
  RoleMembershipChanged,
  RoleMembershipChangedId,
  SocialAgentId,
} from '@janeirodigital/interop-data-model'
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common'
import {
  ParentClosePolicy,
  condition,
  defineSignal,
  executeChild,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow'

import type * as activities from '../activities/grants.js'
import {
  detectGrantedRequests,
  processNeedBasedAccessRequest,
  processNeedBasedAccessRequestReceived,
} from './access-request.js'
import { processAdminAuthorizationGranted, processAdminAuthorizationRevoked } from './admin.js'
import { createInvitation } from './invitation.js'
// the mirror child is scheduled on the reciprocal queue (explicit `taskQueue`
// below). Importing it also pulls the reciprocal workflows into this bundle —
// harmless: Temporal routes a run by its start-queue, not by registration.
import { syncReciprocalMirror } from './reciprocal.js'

// NOTE: workflow code runs inside the Temporal sandbox — no runtime imports
// beyond @temporalio/workflow (utils' INTEROP would pull in disallowed Node
// built-ins). The values must match what producers put in the refs they build.
const ROLE_TYPE = 'http://www.w3.org/ns/solid/interop#Role'
const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const DATA_GRANT_TYPE = 'http://www.w3.org/ns/solid/interop#DataGrant'

/** Sandbox-safe discriminant check (the data-model `isActivityClass` helper
 * is a runtime import — not allowed here; the tuples are read as string[]). */
function isActivityClass(activity: ActivityData, cls: string): boolean {
  return (activity.type as readonly string[]).includes(cls)
}

const {
  findAffectedGrantees,
  getGrantees,
  listGranteeRegistrations,
  listReciprocalRegistrations,
  findIncompleteReciprocalMirrors,
  getAuthorizations,
  getExistingGrants,
  getExistingGrantBodies,
  getRegistryGrantsForGrantee,
  generateGrants,
  checkEquivalence,
  deleteDataGrants,
  deleteAuthorizations,
  revokeGrantClosure,
  requestRevocations,
  removeGrantsFromRegistrations,
  dropGrantReplicas,
  resolveGranteeKind,
  findRoleUsage,
  createRoleAtId,
  storeDataGrant,
  createAcr,
  requestDelegations,
  replaceDataGrantsOnRegistration,
  getPendingDelegatedGrantsUpdates,
  getPendingActivities,
  resolveAuthorizationGrantee,
  storeAuthorizationGranted,
  updateRoleInRegistry,
  deleteRoleFromRegistry,
  markActivitiesDone,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
})

async function storeGrantAndAcr(grant: FinalGrantData) {
  await storeDataGrant(grant)
  await createAcr(grant)
}

export async function storeGrant(payload: FinalGrantData[]): Promise<void> {
  // TODO same race condition as in createGrantsForAgent — change back to
  // Promise.all after the CSS SPARQL backend dcterms:modified bug is fixed
  for (const grant of payload) {
    await storeGrantAndAcr(grant)
  }
}

/**
 * Revoke grants in the data owner's registry: delete the given grant resources
 * (the listed grants plus their inheriting children — the dependent closure is
 * computed by the revocation handler) with the data owner's own session, then
 * clear the owner's registration projection for the removed grants (grouped by
 * grantee). The registration PATCH is last: a crash before it leaves a stale
 * projection (enforcement is already correct, the next reconciliation/sweep
 * heals it) and, because the registration is what the grantee mirrors, the
 * peer's reciprocal webhook finally drops the revoked grants from its mirror.
 * Mirrors `storeGrant`: the worker performs the writes, so the deletes get
 * Temporal activity-retry semantics. Idempotent — 404/link-removal are
 * tolerated.
 */
export async function revokeGrants(payload: {
  webId: SocialAgentId
  grants: GrantId[]
  /** removed grants grouped by grantee for the owner's projection patch */
  projection?: { grantee: string; grants: string[] }[]
}): Promise<void> {
  await deleteDataGrants(payload)
  if (payload.projection?.length) {
    await removeGrantsFromRegistrations({
      webId: payload.webId,
      groups: payload.projection,
    })
  }
}

/**
 * Signal a running per-peer delegated-grants consumer to wake up and drain new
 * activities (start-or-signal pattern — the handler signals on AlreadyStarted).
 */
export const delegatedGrantsUpdatedSignal = defineSignal<[]>('delegatedGrantsUpdatedSignal')

/** Force one mirror-sync + regeneration without a pending activity (C5). */
export const reconcileMirrorSignal = defineSignal<[]>('reconcileMirrorSignal')

/** How long an idle consumer waits for a signal before exiting. */
const CONSUMER_IDLE_TIMEOUT = '3 seconds'

/**
 * Per-peer consumer for `delegatedGrantsUpdated`
 * (openwiki/architecture/federation.md): started by the webhook handler and by
 * the reconciliation sweep with a deterministic workflowId per
 * `(webId, peerId)`. Each drain runs the same three ordered steps:
 *
 * 1. **replicate** — child `syncReciprocalMirror` on the
 *    `reciprocal-registration` queue (its own worker and retry policy; the
 *    only bulk peer fetch in this flow);
 * 2. **regenerate** — `updateDelegatedGrants` WITHOUT `activityId` (with one it
 *    would self-complete; this workflow owns completion, after both steps
 *    succeeded);
 * 3. **complete** — `markActivitiesDone` for the drained batch, so `done`
 *    always means "mirror and delegated grants are current".
 *
 * Terminal-error policy: when the sync reports `peerGone` (the peer deleted its
 * registration of us — `404`/`410`), step 2 is skipped and the batch completes.
 * There is no source left to regenerate from, and retrying into the mirror cap
 * would leave the activity pending forever.
 *
 * Re-draining after every signal is what prevents a lost update: a delivery
 * that lands while a run is in flight is picked up by the next drain, whose
 * mirror sync starts AFTER that delivery. Joining an already-running sync
 * would not be enough — it may have started before the newer peer update.
 * After an empty drain the consumer waits for a signal before exiting; the
 * residual exit-window gap is the reconciliation sweep's backstop.
 *
 * Forced sync (C5 / D20): `forceSync` on the input, or `reconcileMirrorSignal`
 * on a live consumer, runs one sync + regeneration even with **no** pending
 * activity — the scheduled mirror-freshness pass and the local completeness
 * repair use it, serialized by the same deterministic workflowId.
 */
export async function processDelegatedGrantsUpdated(
  payload: activities.DelegatedGrantsConsumerInput
): Promise<void> {
  let idle = false
  let forceSync = payload.forceSync === true
  setHandler(delegatedGrantsUpdatedSignal, () => {
    idle = false
  })
  setHandler(reconcileMirrorSignal, () => {
    idle = false
    forceSync = true
  })
  while (true) {
    const pending = await getPendingDelegatedGrantsUpdates(payload)
    if (pending.length === 0) {
      if (!forceSync) {
        // wait for a signal (a new activity was routed to this consumer) or exit idle
        idle = true
        const signaled = await condition(() => !idle, CONSUMER_IDLE_TIMEOUT)
        if (!signaled) break
        continue
      }
      // forced run: sync + regenerate once even with nothing pending
      forceSync = false
    }
    // no explicit workflowId on the child: the consumer already serializes per
    // (webId, peerId), and a deterministic id would collide with an in-flight
    // sync started by the previous parallel-start path during a rollout
    const mirror = await executeChild(syncReciprocalMirror, {
      taskQueue: 'reciprocal-registration',
      args: [{ webId: payload.webId, peerId: payload.peerId }],
    })
    if (!mirror.peerGone) {
      await updateDelegatedGrants({ webId: payload.webId, peerId: payload.peerId })
    }
    // terminal case (`peerGone`): the peer deleted its registration of us, so
    // there is no source to regenerate from — completing beats retrying into
    // the mirror cap forever. The dangling reciprocal link on our registration
    // is cleaned up by the unregister flow (pod-isolation-followup A2), which
    // is also when the delegated grants sourced from that peer go away.
    if (pending.length > 0) {
      await markActivitiesDone({ webId: payload.webId, activities: pending })
    }
    forceSync = false
  }
}

/**
 * Start-or-signal the per-peer consumer for one forced mirror sync. Uses the
 * same deterministic workflowId as the webhook handler and the pending-activity
 * arm, so the sync serializes with webhook-driven runs; if a consumer is
 * already live it is signalled instead of started twice. C5 (D20): the local
 * completeness repair (`reconcileActivities`) and the peer-freshness pass
 * (`reconcilePeerMirrors`) both go through here.
 */
async function forceMirrorSync(webId: SocialAgentId, peerId: SocialAgentId): Promise<void> {
  const workflowId = `delegated-grants:${webId.id}:${peerId.id}`
  const start = (): Promise<void> =>
    executeChild(processDelegatedGrantsUpdated, {
      workflowId,
      args: [{ webId, peerId, forceSync: true }],
    }).then(() => undefined)
  const signal = (): Promise<void> =>
    getExternalWorkflowHandle(workflowId).signal(reconcileMirrorSignal)
  // start-or-signal with the same closed-run race handling as the webhook
  // handler: an AlreadyStarted start means a live consumer; a failed signal
  // means that run closed in between — retry the pair.
  try {
    await start()
    return
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await signal()
      return
    } catch {
      try {
        await start()
        return
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err
      }
    }
  }
  // exhausted — the next scheduled sweep/freshness run retries the pair
}

/**
 * Mirror-freshness pass (C5): re-fetch every reciprocal-linked peer's
 * registration + linked grants and re-derive the delegated grants — the only
 * way to see an upstream grant replaced/revoked when the peer's webhook was
 * missed. It is a separate workflow because peer fetches are the expensive
 * signal; the schedule/cadence is a deployment concern
 * (`update-deployment.md` §F). The local completeness repair runs inside
 * `reconcileActivities`.
 */
export async function reconcilePeerMirrors(payload: { webId: SocialAgentId }): Promise<void> {
  const pairs = await listReciprocalRegistrations({ webId: payload.webId })
  await Promise.all(pairs.map((pair) => forceMirrorSync(payload.webId, pair.peerId)))
}

export async function createGrantsForAuthorization(
  payload: activities.CreateGrantsInput
): Promise<void> {
  const grantees = await getGrantees({
    webId: payload.webId,
    grantee: payload.authorizationGrantee,
  })
  await Promise.all(
    grantees.map((grantee) =>
      executeChild(createGrantsForAgent, {
        args: [
          {
            webId: payload.webId,
            grantee,
          },
        ],
      })
    )
  )
}

/**
 * The dedicated granting parent (architecture.md §4, authorization-granting.md
 * §5.1): group the embedded DataAuthorizations by grantee and fan out ONE
 * child workflow per agent (`processGranteeAuthorization` — materialize +
 * regenerate; always fan out, single grantee included), then a SINGLE parent
 * completion once ALL children succeed (children never mark done). A child
 * failure fails the parent → Temporal retries/resumes; children are
 * idempotent (find-first PUTs, full regeneration).
 */
export async function processAuthorizationGranted(
  webId: SocialAgentId,
  dataAuthorizations: AuthorizationGranted['object'],
  activity: AuthorizationGrantedId
): Promise<void> {
  // sandbox-safe grouping (mirror of activities.groupAuthorizationDataAuthorizations)
  const byGrantee = new Map<string, DataAuthorizationData[]>()
  for (const dataAuthorization of dataAuthorizations) {
    const group = byGrantee.get(dataAuthorization.grantee) ?? []
    group.push(dataAuthorization)
    byGrantee.set(dataAuthorization.grantee, group)
  }
  const groups = [...byGrantee.values()]
  await Promise.all(
    groups.map((group) =>
      executeChild(processGranteeAuthorization, {
        args: [{ webId, dataAuthorizations: group }],
      })
    )
  )
  await markActivitiesDone({ webId, activities: [activity] })
}

/**
 * One grantee's leg of a granted authorization (child of
 * `processAuthorizationGranted`, refinement §5.1): materialize the group's
 * DataAuthorizations at the pre-minted ids (find-first) → regenerate the
 * grantee's grants (registry-state full regeneration). No completion — the
 * parent owns it after ALL children succeed.
 */
export async function processGranteeAuthorization(
  input: activities.ProcessGranteeAuthorizationInput
): Promise<void> {
  const { webId, dataAuthorizations } = input
  if (dataAuthorizations.length > 0) {
    await storeAuthorizationGranted({
      webId,
      dataAuthorizations: dataAuthorizations as FinalDataAuthorizationData[],
    })
  }
  const authorizationGrantee = await resolveAuthorizationGrantee({
    webId,
    object: dataAuthorizations,
  })
  if (!authorizationGrantee) return
  await createGrantsForAuthorization({ webId, authorizationGrantee })
}

export async function updateDelegatedGrants(
  payload: activities.FindAffectedAuthorizationsInput
): Promise<void> {
  const grantees = await findAffectedGrantees(payload)
  await Promise.all(
    grantees.map((authorizationGrantee) =>
      executeChild(createGrantsForAuthorization, {
        args: [
          {
            webId: payload.webId,
            authorizationGrantee,
          },
        ],
      })
    )
  )
  if (payload.activityId) {
    await markActivitiesDone({
      webId: payload.webId,
      activities: [{ id: payload.activityId }],
    })
  }
  // fire-and-forget granted-detection (see the OpenWiki `services/activity-lifecycle.md`): the
  // requester's received-grant view is FRESH here — start the detector child
  // and deliberately do NOT await its result. `ParentClosePolicy.ABANDON` is
  // REQUIRED: the default policy TERMINATES children when their parent
  // closes — the child would be killed the moment `updateDelegatedGrants`
  // returns (the dev failure: `workflowExecutionTerminatedEventAttributes,
  // reason: by parent close policy`); ABANDON lets it keep running
  // independently. The derived workflowId makes a parent retry re-issue the
  // SAME StartChild command (deduped by Temporal — no unbounded children);
  // its own retry policy covers transient worker failures; the result's
  // rejection is swallowed so a best-effort miss never fails this workflow.
  await startChild(detectGrantedRequests, {
    taskQueue: 'create-grants',
    args: [payload.webId],
    workflowId: `${workflowInfo().workflowId}-granted-detection`,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    retry: { maximumAttempts: 3 },
  })
}

/**
 * Requester hop (grantor-side, §5 System 1): POST the AccessRevocation to the
 * data owner's delegation endpoint, then on success clear the grantor's
 * registration projection (`hasDataGrant`) for the revoked grants, then mark
 * the triggering activity done. The data owner's handler removes the listed
 * grants plus their inheriting children; the response echo drives the link
 * cleanup here.
 */
export async function createRole(
  webId: SocialAgentId,
  role: RoleData,
  activity: RoleCreatedId
): Promise<void> {
  // activity-first step 9: the RPC wrote only the activity (object = the
  // role-to-be at the PRE-MINTED id) — this workflow PUTs the role there
  // (find-first idempotent), then completes. No derived work: no
  // authorizations can exist before the role exists (the PUT is the create).
  await createRoleAtId({ webId, role })
  await markActivitiesDone({ webId, activities: [activity] })
}

export async function processRoleMembershipChange(
  webId: SocialAgentId,
  role: RoleData,
  activity: RoleMembershipChangedId
): Promise<void> {
  // activity-first step 2: the RPC wrote only the intended change (the
  // role-to-be as the activity's real-id embedded object) — this workflow
  // PATCHes the role to that state, derives the affected diff from the
  // before-image the activity loaded, regenerates and completes. Idempotent:
  // a re-run sees the role already equal to the intended state → empty diff.
  const beforeMembers = new Set(await updateRoleInRegistry({ webId, role }))
  const afterMembers = new Set(role.members)
  const changed = [
    ...[...beforeMembers].filter((member) => !afterMembers.has(member)),
    ...[...afterMembers].filter((member) => !beforeMembers.has(member)),
  ]
  const usage = await findRoleUsage({ webId, roleId: { id: role.id, type: role.type } })
  const affected: AgentId[] = []
  const seen = new Set<string>()
  const add = (agent: AgentId) => {
    if (seen.has(agent.id)) return
    seen.add(agent.id)
    affected.push(agent)
  }
  // role used as grantee → the changed members' received grants changed
  if (usage.usedAsGrantee) {
    for (const member of changed) add({ id: member, type: [SOCIAL_AGENT_TYPE] })
  }
  // role used as dataOwner → the *grantees of those authorizations* are affected
  for (const grantee of usage.affectedGrantees) {
    if (grantee.type.includes(ROLE_TYPE)) {
      const members = await getGrantees({ webId, grantee })
      for (const member of members) add(member)
    } else {
      add(grantee as AgentId)
    }
  }
  await Promise.all(
    affected.map((grantee) =>
      executeChild(createGrantsForAgent, {
        args: [
          {
            webId,
            grantee,
          },
        ],
      })
    )
  )
  // single completion after all branches succeed (children never mark done)
  await markActivitiesDone({ webId, activities: [activity] })
}

export async function processRoleDeletion(
  webId: SocialAgentId,
  role: RoleData,
  activity: RoleDeletedId
): Promise<void> {
  // scan BEFORE the deletions — the usage info and the matched authorization
  // ids must be captured while the authorizations still exist; the affected
  // members ride the object (the write-time snapshot — unrecoverable from
  // the store after the role and its role-grantee authorizations are gone,
  // e.g. on a retry after a crash between the DELETE and the completion)
  const usage = await findRoleUsage({ webId, roleId: { id: role.id, type: role.type } })
  await deleteAuthorizations({ webId, authorizations: usage.authorizations })
  // the role must be gone before the regeneration: the self-contained
  // createGrantsForAgent re-derives memberships from the store (find-first,
  // 404-tolerant — a retry sees the role already deleted and skips)
  await deleteRoleFromRegistry({ webId, role })
  const affected: AgentId[] = []
  const seen = new Set<string>()
  const add = (agent: AgentId) => {
    if (seen.has(agent.id)) return
    seen.add(agent.id)
    affected.push(agent)
  }
  // role.members ARE the grantees of grantee-authorizations — read from the
  // embedded object, not the store (the role is gone by now)
  if (usage.usedAsGrantee) {
    for (const member of role.members) add({ id: member, type: [SOCIAL_AGENT_TYPE] })
  }
  // grantees of dataOwner-authorizations — route by type
  for (const grantee of usage.affectedGrantees) {
    if (grantee.type.includes(ROLE_TYPE)) {
      const members = await getGrantees({ webId, grantee })
      for (const member of members) add(member)
    } else {
      add(grantee as AgentId)
    }
  }
  await Promise.all(
    affected.map((grantee) =>
      executeChild(createGrantsForAgent, {
        args: [
          {
            webId,
            grantee,
          },
        ],
      })
    )
  )
  // single completion after all branches succeed (children never mark done)
  await markActivitiesDone({ webId, activities: [activity] })
}

/**
 * Reconciliation sweep (Phase 4.2 / C5): reprocess every pending activity — a
 * non-completion with no `activityCompleted` referencing it — in the webId's
 * Activity Registry, repair any missing/incomplete reciprocal mirror (C5
 * mirror arm), then re-derive every registered grantee's projection from the
 * authorization state (the C5 drift arm; a pending-activity drain alone cannot
 * see a change whose activity row is gone). The mirror repair is a forced sync
 * for locally incomplete pairs; the drift pass reuses unchanged trees and
 * `replaceDataGrants` is a no-op when the link set is unchanged, so a no-op
 * sweep writes nothing. Reuses the same routing as the webhook handler:
 * grantee activities join the per-grantee consumer (deterministic workflowId —
 * a running consumer absorbs them),
 * `delegatedGrantsUpdated` joins the per-peer delegated-grants consumer (same
 * start-or-join contract: the consumer replicates the mirror, regenerates and
 * marks the drained activities done itself), role
 * activities run their workflow and are marked done (one completion activity
 * per entry; duplicate completions are accepted — completion is a container
 * `Add`, so reprocessing an already-done activity is harmless). Idempotent by
 * construction (full regeneration). `agentRegistrationAdded` is skipped
 * (accountId is not resolvable here).
 */
export async function reconcileActivities(payload: { webId: SocialAgentId }): Promise<void> {
  const pending = await getPendingActivities({ webId: payload.webId })
  const roleActivities: ActivityData[] = []
  for (const activity of pending) {
    if (isActivityClass(activity, 'AuthorizationGranted')) {
      // dedicated workflow (step 2 — architecture.md §4): materialize the
      // embedded DataAuthorizations at the pre-minted ids, regenerate grants;
      // self-completes (the outer markActivitiesDone is the accepted
      // duplicate for a reconcile re-run)
      const granted = activity as AuthorizationGranted
      await executeChild(processAuthorizationGranted, {
        args: [payload.webId, granted.object, { id: activity.id, type: [...granted.type] }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'AuthorizationDenied')) {
      // silent decline (Step 4) — forward-only, nothing to materialize or
      // regenerate; no workflow ever completes it, so the sweep closes the
      // outbox row (UI sees a done event — silent, no claim/refresh)
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'AuthorizationRevoked')) {
      // C2: the carrier is self-contained (refs + grantee), so the sweep runs
      // the dedicated workflow directly (self-completing; the outer
      // markActivitiesDone is the accepted duplicate for a reconcile re-run)
      const revoked = activity as AuthorizationRevoked
      await executeChild(processAuthorizationRevoked, {
        args: [
          payload.webId,
          revoked.object,
          revoked.grantee,
          { id: activity.id, type: [...revoked.type] },
        ],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (
      isActivityClass(activity, 'RoleMembershipChanged') ||
      isActivityClass(activity, 'RoleDeleted')
    ) {
      roleActivities.push(activity)
    } else if (isActivityClass(activity, 'DelegatedGrantsUpdated')) {
      // the same per-peer consumer as the webhook path
      // (openwiki/architecture/federation.md): replicate the mirror, regenerate
      // from it, then complete the activity. Start-or-join — a run that is
      // already live picks the activity up in one of its drains; a closed one
      // is restarted here. The consumer owns completion, so the sweep must not
      // also mark it done (a second completion would be accepted but points at
      // a possibly pre-mirror regeneration).
      const decoded = activity as DelegatedGrantsUpdated
      try {
        await executeChild(processDelegatedGrantsUpdated, {
          workflowId: `delegated-grants:${payload.webId.id}:${decoded.target}`,
          args: [
            {
              webId: payload.webId,
              peerId: { id: decoded.target, type: [SOCIAL_AGENT_TYPE] },
            },
          ],
        })
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err
        // a consumer is already draining for this peer — it holds the delivery
      }
    } else if (isActivityClass(activity, 'NeedBasedAccessRequestReceived')) {
      // the owner-side leg (authorization-granting.md §6.2) — same routing as
      // the webhook handler: the workflow PUTs the immutable AccessRequest at
      // the minted id (find-first — a reconcile re-run sees the resource and
      // only marks done), then completes
      const received = activity as NeedBasedAccessRequestReceived
      await executeChild(processNeedBasedAccessRequestReceived, {
        args: [payload.webId, received.object, { id: activity.id, type: [...received.type] }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'NeedBasedAccessRequestSent')) {
      // the requester-side access-request leg (authorization-granting.md
      // §6.4) — same routing as the webhook handler: the workflow forwards
      // the request to the data owner's (reused) issuance endpoint (expects
      // 202), then completes (self-completing; the outer markActivitiesDone
      // is the accepted duplicate for a reconcile re-run)
      const sent = activity as NeedBasedAccessRequestSent
      await executeChild(processNeedBasedAccessRequest, {
        args: [payload.webId, sent.object, { id: activity.id, type: [...sent.type] }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'RoleCreated')) {
      // step 9 — the workflow PUTs the role at the pre-minted id, then
      // completes (self-completing; the outer markActivitiesDone is the
      // accepted duplicate)
      const created = activity as RoleCreated
      await executeChild(createRole, {
        args: [payload.webId, created.object, { id: activity.id, type: [...created.type] }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'AdminAuthorizationGranted')) {
      // step 5 — the workflow PUTs the AdminAuthorization at the pre-minted
      // id, materializes grants + the ACR rewrite, then completes
      // (self-completing; the outer markActivitiesDone is the accepted
      // duplicate for a reconcile re-run)
      const recorded = activity as AdminAuthorizationGranted
      await executeChild(processAdminAuthorizationGranted, {
        args: [payload.webId, recorded.object, { id: activity.id, type: [...recorded.type] }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'AdminAuthorizationRevoked')) {
      // step 6 — the workflow DELETEs the AdminAuthorization at the embedded
      // id, revokes grants + the ACR rewrite, then completes (self-completing;
      // the outer markActivitiesDone is the accepted duplicate)
      const revoked = activity as AdminAuthorizationRevoked
      await executeChild(processAdminAuthorizationRevoked, {
        args: [payload.webId, revoked.object, { id: activity.id, type: [...revoked.type] }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    } else if (isActivityClass(activity, 'InvitationCreated')) {
      // step 1 — same routing as the webhook handler: the workflow PUTs the
      // invitation at the pre-minted id (find-first — a reconcile re-run
      // after a handler crash sees the existing invitation and only marks
      // the activity done)
      const decoded = activity as InvitationCreated
      await executeChild(createInvitation, {
        args: [payload.webId.id, decoded.object, { id: activity.id, type: decoded.type }],
      })
      await markActivitiesDone({ webId: payload.webId, activities: [activity] })
    }
  }
  for (const activity of roleActivities) {
    // steps 2–3: both role classes carry the role-to-be as a real-id
    // embedded object (`target` dropped) — same multi-param signature
    if (isActivityClass(activity, 'RoleMembershipChanged')) {
      const roleActivity = activity as RoleMembershipChanged
      await executeChild(processRoleMembershipChange, {
        args: [
          payload.webId,
          roleActivity.object,
          { id: activity.id, type: [...roleActivity.type] },
        ],
      })
    } else {
      const roleActivity = activity as RoleDeleted
      await executeChild(processRoleDeletion, {
        args: [
          payload.webId,
          roleActivity.object,
          { id: activity.id, type: [...roleActivity.type] },
        ],
      })
    }
    await markActivitiesDone({ webId: payload.webId, activities: [activity] })
  }

  // C5 mirror arm — repair a missing/incomplete local mirror first: delegated
  // grant generation reads the mirror, so a stale run must not precede the
  // repair. The sync itself is idempotent (immutable grants + no-op guard).
  const incompleteMirrors = await findIncompleteReciprocalMirrors({ webId: payload.webId })
  for (const pair of incompleteMirrors) {
    await forceMirrorSync(payload.webId, pair.peerId)
  }

  // C5 drift arm — authorization state vs grant projection. No separate
  // desired-vs-existing comparison: `reconcileGrantsForGrantee` is idempotent,
  // `checkEquivalence` reuses every unchanged tree, and the registration PATCH
  // is skipped when the link set is unchanged. This catches a missed
  // authorization/role/delegated delivery even when no activity is pending.
  const grantees = await listGranteeRegistrations({ webId: payload.webId })
  for (const grantee of grantees) {
    await executeChild(reconcileGrantsForGrantee, {
      args: [{ webId: payload.webId, grantee }],
    })
  }
}

/**
 * Projection + garbage collection for one grantee (D13): the desired grants
 * are generated from the authorization registry state; `checkEquivalence`
 * decides reuse; `existing − reused` is the GC set, removed **before** the new
 * trees are created (fail closed). "Existing" is the registration projection
 * union the own-registry orphan scan (recovery after a crash between delete
 * and PATCH). Removal is grouped by `dataOwner`: own registry → C1 closure
 * delete (`revokeGrantClosure`); peer-owned → the `AccessRevocation` boundary
 * (`requestRevocations`, which also runs the owner's C1 closure). The removed
 * delegated trees' issuer-side replicas are dropped; the registration
 * projection is PATCHed last.
 */
export async function reconcileGrantsForGrantee(
  payload: activities.CreateGrantsForAgentInput
): Promise<void> {
  // SELF-CONTAINED: fetch ALL of the grantee's authorizations (incl. via roles)
  const authorizations = await getAuthorizations({
    webId: payload.webId,
    peerId: payload.grantee,
  })
  const projected = await getExistingGrants({ webId: payload.webId, peerId: payload.grantee })
  const orphans = await getRegistryGrantsForGrantee({
    webId: payload.webId,
    grantee: payload.grantee,
  })
  const existingById = new Map<string, GrantId>()
  for (const grant of [...projected, ...orphans]) {
    if (grant.id) existingById.set(grant.id, grant)
  }
  const existing = [...existingById.values()]

  // the deny case is just the empty desired set — no special short-circuit
  const generated: GeneratedGrants =
    authorizations.length === 0
      ? { sourceGrants: [], delegatedGrants: [] }
      : await generateGrants({
          webId: payload.webId,
          grantee: payload.grantee,
          dataAuthorizations: authorizations,
        })

  // value-based sets: activity results cross Temporal's data converter, so
  // object identity never survives
  const { reusedSourceIds, reusedDelegatedIndexes, reusedExisting } = await checkEquivalence({
    webId: payload.webId,
    grantee: payload.grantee,
    generated,
    existing,
  })
  const reusedSource = new Set(reusedSourceIds)
  const reusedDelegated = new Set(reusedDelegatedIndexes)
  const reusedExistingIds = new Set(reusedExisting.map((grant) => grant.id))
  const removeIds = existing.filter((grant) => !grant.id || !reusedExistingIds.has(grant.id))

  if (removeIds.length > 0) {
    const bodies = await getExistingGrantBodies({ webId: payload.webId, grants: removeIds })
    const bodyById = new Map(bodies.map((body) => [body.id, body]))
    // own-registry grants are removable by IRI even without a body (the
    // owner-session closure loads the registry itself); peer-owned grants
    // without a replica body cannot be owner-grouped — they are left to the
    // data owner's sweep/closure (fail-closed reuse already kept them out of
    // the projection)
    const ownIds = new Set(orphans.map((grant) => grant.id))
    const byOwner = new Map<string, GrantId[]>()
    for (const grant of removeIds) {
      if (!grant.id) continue
      const body = bodyById.get(grant.id)
      const owner = body?.dataOwner ?? (ownIds.has(grant.id) ? payload.webId.id : undefined)
      if (!owner) continue
      const group = byOwner.get(owner) ?? []
      group.push({ id: grant.id, type: body?.type ?? [DATA_GRANT_TYPE] })
      byOwner.set(owner, group)
    }
    for (const [owner, grants] of byOwner) {
      if (owner === payload.webId.id) {
        // own registry: the owner session deletes the C1 closure
        await revokeGrantClosure({ webId: payload.webId, grants })
      } else {
        // peer-owned: the data owner deletes the closure at its boundary
        await requestRevocations({ webId: payload.webId, dataOwner: owner, grants })
        await dropGrantReplicas({
          webId: payload.webId,
          grants: grants.map((grant) => grant.id!),
        })
      }
    }
  }

  // create the unmatched desired trees (after the GC — delete-before-create)
  const newGrantIds: GrantId[] = []
  for (const grant of generated.sourceGrants) {
    if (reusedSource.has(grant.id)) continue
    await storeGrantAndAcr(grant)
    newGrantIds.push({ id: grant.id, type: grant.type })
  }

  // one delegation request per data owner (the issuance endpoint accepts a
  // single dataOwner batch)
  const delegatedByOwner = new Map<string, GrantData[]>()
  for (const [index, grant] of generated.delegatedGrants.entries()) {
    if (reusedDelegated.has(index)) continue
    const group = delegatedByOwner.get(grant.dataOwner) ?? []
    group.push(grant)
    delegatedByOwner.set(grant.dataOwner, group)
  }
  for (const grants of delegatedByOwner.values()) {
    newGrantIds.push(...(await requestDelegations({ webId: payload.webId, grants })))
  }

  await replaceDataGrantsOnRegistration({
    webId: payload.webId,
    grantee: payload.grantee,
    grants: [...newGrantIds, ...reusedExisting],
  })
}

export async function createGrantsForAgent(
  payload: activities.CreateGrantsForAgentInput
): Promise<void> {
  return reconcileGrantsForGrantee(payload)
}

/**
 * C2 authorization-revocation leg: delete the selected DataAuthorizations
 * (source-of-truth mutation), expand the grantee's kind (role → members), run
 * the projection + GC reconciliation per affected grantee (the chain closure
 * is applied at each data owner inside `reconcileGrantsForGrantee`), then
 * complete. Idempotent: DA deletes are 404-tolerant, the reconciliation
 * re-derives from registry state, and completion is an accepted duplicate.
 */
export async function processAuthorizationRevoked(
  webId: SocialAgentId,
  authorizations: DataAuthorizationRef[],
  grantee: string,
  activity: { id: string; type: string[] }
): Promise<void> {
  await deleteAuthorizations({ webId, authorizations })
  const granteeKind = await resolveGranteeKind({ webId, grantee })
  const grantees = await getGrantees({ webId, grantee: granteeKind })
  for (const affected of grantees) {
    await executeChild(reconcileGrantsForGrantee, {
      args: [{ webId, grantee: affected }],
    })
  }
  await markActivitiesDone({ webId, activities: [activity] })
}
