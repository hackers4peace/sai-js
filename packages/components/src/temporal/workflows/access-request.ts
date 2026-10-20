import type {
  EmbeddedNeedBasedAccessRequest,
  NeedBasedAccessRequestReceivedId,
  NeedBasedAccessRequestSentId,
  SocialAgentId,
} from '@janeirodigital/interop-data-model'
import { proxyActivities } from '@temporalio/workflow'

import type * as accessRequestActivities from '../activities/access-request.js'
import type * as grantsActivities from '../activities/grants.js'

const { forwardNeedBasedAccessRequest, materializeNeedBasedAccessRequest } = proxyActivities<
  typeof accessRequestActivities
>({
  startToCloseTimeout: '1 minute',
})

// the granted-detection activity — destructured under an alias so the
// workflow function below can carry the `detectGrantedRequests` name
// (the diagram + `startChild` label)
const { detectGrantedRequests: detectAndRecordGrantedRequests } = proxyActivities<
  typeof accessRequestActivities
>({
  startToCloseTimeout: '1 minute',
})

const { markActivitiesDone } = proxyActivities<typeof grantsActivities>({
  startToCloseTimeout: '1 minute',
})

/**
 * The requester-side access-request workflow (authorization-granting.md
 * §6.5): the RPC only wrote the `NeedBasedAccessRequestSent` activity
 * (object = the request snapshot, urn:uuid id); this workflow forwards the
 * request to the data owner's (reused) issuance endpoint as the requester
 * (expects **202** — it awaits NOTHING beyond the acceptance), then marks the
 * activity done. The requester-side completion and the owner-side
 * materialization (next phase) run in parallel — any order; the `done` here
 * means "forwarded", not "granted" (the grant outcome arrives later via a
 * webhook when the owner approves, §6.8).
 */
export async function processNeedBasedAccessRequest(
  requester: SocialAgentId,
  request: EmbeddedNeedBasedAccessRequest,
  activity: NeedBasedAccessRequestSentId
): Promise<void> {
  await forwardNeedBasedAccessRequest({ requester, request, activity })
  await markActivitiesDone({
    webId: { id: requester.id, type: requester.type },
    activities: [activity],
  })
}

/**
 * The owner-side access-request workflow (authorization-granting.md §6.5):
 * the data owner's endpoint only wrote the `NeedBasedAccessRequestReceived`
 * activity (object = the request-to-be, real-id embedded projection at the
 * minted id); this workflow PUTs the immutable AccessRequest resource there
 * (find-first idempotent — retries/reconcile are no-ops), then completes.
 * Like the requester side, the completion runs in parallel — any order.
 */
export async function processNeedBasedAccessRequestReceived(
  dataOwner: SocialAgentId,
  request: EmbeddedNeedBasedAccessRequest,
  activity: NeedBasedAccessRequestReceivedId
): Promise<void> {
  await materializeNeedBasedAccessRequest({ dataOwner, request, activity })
  await markActivitiesDone({
    webId: { id: dataOwner.id, type: dataOwner.type },
    activities: [activity],
  })
}

/**
 * The granted-request detector (see the OpenWiki `services/activity-lifecycle.md`): started as
 * a FIRE-AND-FORGET child at the end of the `updateDelegatedGrants` workflow
 * (the trigger that leaves the requester-side received-grant view fresh) —
 * `startChild` with `ParentClosePolicy.ABANDON` (the default TERMINATE
 * policy would kill it when the parent closes) + a derived workflowId (a
 * parent retry re-issues the same StartChild command — deduped by Temporal).
 * Reads the open sent requests × the requester's received grants and writes
 * `AccessRequestGranted` per match — TERMINAL resolution, no completion.
 * The child carries its own retry policy, so transient worker failures
 * re-run the detection itself.
 */
export async function detectGrantedRequests(requester: SocialAgentId): Promise<void> {
  await detectAndRecordGrantedRequests({ requester })
}
