import type {
  ActivityData,
  AdminAuthorizationGranted,
  AdminAuthorizationRevoked,
  AgentId,
  AuthorizationGranted,
  AuthorizationGrantedId,
  DataAuthorizationData,
  DelegatedGrantsUpdated,
  FinalDataAuthorizationData,
  FinalGrantData,
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

/** Sandbox-safe discriminant check (the data-model `isActivityClass` helper
 * is a runtime import — not allowed here; the tuples are read as string[]). */
function isActivityClass(activity: ActivityData, cls: string): boolean {
  return (activity.type as readonly string[]).includes(cls)
}

const {
  findAffectedGrantees,
  getGrantees,
  getAuthorizations,
  getExistingGrants,
  generateGrants,
  checkEquivalence,
  deleteDataGrants,
  deleteAuthorizations,
  findRoleUsage,
  createRoleAtId,
  storeDataGrant,
  createAcr,
  requestDelegations,
  replaceDataGrantsOnRegistration,
  getPendingGranteeActivities,
  getPendingDelegatedGrantsUpdates,
  getPendingActivities,
  resolveActivityGrantee,
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
 * computed by the revocation handler) with the data owner's own session.
 * Mirrors `storeGrant`: the worker performs the writes, so the deletes get
 * Temporal activity-retry semantics. Idempotent — 404 is tolerated.
 */
export async function revokeGrants(payload: {
  webId: SocialAgentId
  grants: GrantId[]
}): Promise<void> {
  await deleteDataGrants(payload)
}

/**
 * Signal a running per-grantee consumer to wake up and drain new activities
 * (start-or-signal pattern — the handler signals on AlreadyStarted).
 */
export const granteeActivitiesSignal = defineSignal<[]>('granteeActivitiesSignal')

/** How long an idle consumer waits for a signal before exiting. */
const CONSUMER_IDLE_TIMEOUT = '3 seconds'

/**
 * Per-target consumer (Phase 4.1): started by the webhook handler with a
 * deterministic workflowId per (webId, authorizationGrantee). Drains the
 * pending authorizationRecorded/authorizationRevoked activities for that
 * grantee, coalescing bursts into a single regeneration (full regeneration is
 * idempotent), and marks them done. After an empty drain it waits for a signal
 * (new activity) before exiting, so an activity arriving while the consumer
 * is running is never lost (start-or-signal; residual exit-window gaps are the
 * reconciliation sweep's backstop, §6.11 / Phase 4.2).
 */
export async function processGranteeActivities(
  payload: activities.CreateGrantsInput
): Promise<void> {
  let idle = false
  setHandler(granteeActivitiesSignal, () => {
    idle = false
  })
  while (true) {
    const pending = await getPendingGranteeActivities({
      webId: payload.webId,
      authorizationGrantee: payload.authorizationGrantee,
    })
    if (pending.length === 0) {
      // wait for a signal (a new activity was routed to this consumer) or exit idle
      idle = true
      const signaled = await condition(() => !idle, CONSUMER_IDLE_TIMEOUT)
      if (!signaled) break
      continue
    }
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
    await markActivitiesDone({ webId: payload.webId, activities: pending })
  }
}

/**
 * Signal a running per-peer delegated-grants consumer to wake up and drain new
 * activities (start-or-signal pattern — the handler signals on AlreadyStarted).
 */
export const delegatedGrantsUpdatedSignal = defineSignal<[]>('delegatedGrantsUpdatedSignal')

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
 */
export async function processDelegatedGrantsUpdated(
  payload: activities.DelegatedGrantsConsumerInput
): Promise<void> {
  let idle = false
  setHandler(delegatedGrantsUpdatedSignal, () => {
    idle = false
  })
  while (true) {
    const pending = await getPendingDelegatedGrantsUpdates(payload)
    if (pending.length === 0) {
      // wait for a signal (a new activity was routed to this consumer) or exit idle
      idle = true
      const signaled = await condition(() => !idle, CONSUMER_IDLE_TIMEOUT)
      if (!signaled) break
      continue
    }
    // no explicit workflowId on the child: the consumer already serializes per
    // (webId, peerId), and a deterministic id would collide with an in-flight
    // sync started by the previous parallel-start path during a rollout
    const mirror = await executeChild(syncReciprocalMirror, {
      taskQueue: 'reciprocal-registration',
      args: [payload],
    })
    if (!mirror.peerGone) {
      await updateDelegatedGrants({ webId: payload.webId, peerId: payload.peerId })
    }
    // terminal case (`peerGone`): the peer deleted its registration of us, so
    // there is no source to regenerate from — completing beats retrying into
    // the mirror cap forever. The dangling reciprocal link on our registration
    // is cleaned up by the unregister flow (pod-isolation-followup A2), which
    // is also when the delegated grants sourced from that peer go away.
    await markActivitiesDone({ webId: payload.webId, activities: pending })
  }
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
 * Reconciliation sweep (Phase 4.2): reprocess every pending activity — a
 * non-completion with no `activityCompleted` referencing it — in the webId's
 * Activity Registry; the correctness backstop for missed deliveries, handler
 * crashes and consumer failures (§6.11). Reuses the same routing as the
 * webhook handler: grantee activities join the per-grantee consumer
 * (deterministic workflowId — a running consumer absorbs them),
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
  const granteeGroups = new Map<string, ActivityData[]>()
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
      // no producer today (revocation plan) — keep the per-grantee consumer
      // grouping; the grantee is resolved from the object (kind via the store)
      const grantee = await resolveActivityGrantee({ activity })
      if (!grantee) continue
      const group = granteeGroups.get(grantee.id) ?? []
      group.push(activity)
      granteeGroups.set(grantee.id, group)
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
  for (const [granteeId, group] of granteeGroups) {
    const authorizationGrantee = await resolveActivityGrantee({ activity: group[0] })
    if (!authorizationGrantee) continue
    try {
      await executeChild(processGranteeActivities, {
        workflowId: `grantee:${payload.webId.id}:${granteeId}`,
        args: [{ webId: payload.webId, authorizationGrantee }],
      })
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err
      // a consumer is already draining for this grantee — it picks up the activities
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
}

export async function createGrantsForAgent(
  payload: activities.CreateGrantsForAgentInput
): Promise<void> {
  // SELF-CONTAINED: fetch ALL of the grantee's authorizations (incl. via roles)
  const authorizations = await getAuthorizations({
    webId: payload.webId,
    peerId: payload.grantee,
  })
  const existing = await getExistingGrants({ webId: payload.webId, peerId: payload.grantee })

  // deny case — no authorizations: clear all existing grants + registration
  if (authorizations.length === 0) {
    // await deleteDataGrants({ webId: payload.webId, grants: existing })
    await replaceDataGrantsOnRegistration({
      webId: payload.webId,
      grantee: payload.grantee,
      grants: [],
    })
    return
  }

  const generated = await generateGrants({
    webId: payload.webId,
    grantee: payload.grantee,
    dataAuthorizations: authorizations,
  })
  // value-based sets: activity results cross Temporal's data converter, so
  // object identity never survives (the previous `Set<GrantData>` never
  // matched and silently disabled reuse)
  const { reusedSourceIds, reusedDelegatedIndexes, reusedExisting } = await checkEquivalence({
    webId: payload.webId,
    grantee: payload.grantee,
    generated,
    existing,
  })
  const reusedSource = new Set(reusedSourceIds)
  const reusedDelegated = new Set(reusedDelegatedIndexes)

  // TODO CSS SPARQL backend has a race condition on dcterms:modified when
  // multiple resources are PUT concurrently in the same container,
  // causing "Multiple results for http://purl.org/dc/terms/modified".
  // Change back to Promise.all after the CSS bug is fixed.
  const newGrantIds: GrantId[] = []
  for (const grant of generated.sourceGrants) {
    if (reusedSource.has(grant.id)) continue
    await storeGrantAndAcr(grant)
    newGrantIds.push({ id: grant.id, type: grant.type })
  }

  // one delegation request per data owner: the issuance endpoint accepts a
  // batch (it already requires a single dataOwner), so each peer sees one POST
  // instead of one per grant. Serialized between owners — the CSS
  // `dcterms:modified` race keeps the writes sequential.
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

  // delete the old grant resources that are not reused
  // const reusedExistingIds = new Set(reusedExisting.map((grant) => grant.id))
  // await deleteDataGrants({
  //   webId: payload.webId,
  //   grants: existing
  //     .filter((grant) => !reusedExistingIds.has(grant.id))
  //     .map((grant) => ({ id: grant.id!, type: grant.type })),
  // })

  await replaceDataGrantsOnRegistration({
    webId: payload.webId,
    grantee: payload.grantee,
    grants: [...newGrantIds, ...reusedExisting],
  })
}
