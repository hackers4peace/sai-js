import type {
  AgentRegistrationAddedId,
  EmbeddedSocialAgentInvitation,
  InvitationAcceptedId,
  SocialAgentRegistrationData,
} from '@janeirodigital/interop-data-model'
import { proxyActivities } from '@temporalio/workflow'

import type * as grantsActivities from '../activities/grants.js'
import type * as activities from '../activities/reciprocal.js'

const { invitationAcceptance, reciprocalRegistration, reciprocalWebhook } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: '1 minute',
  // explicit retry: the peer creates its reciprocal registration only after
  // responding to the invitation — replaces the old startDelay hack (§6.7)
  retry: {
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 10,
  },
})

// mirror maintenance gets its own policy: the sync re-fetches the peer's
// reciprocal doc + linked grant docs (N round-trips) and rewrites the local
// mirror graphs, so it needs a longer startToClose budget than the
// registration probes. Fewer retries than reciprocalRegistration — a save
// from the cap comes from the delegated-grants consumer (its next drain syncs
// again) or the reconcile sweep, which restarts that consumer
// (openwiki/architecture/federation.md); a permanent 403 stays pending, see
// docs/plans/update-deployment.md.
const { syncReciprocalMirror: syncMirrorActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 5,
  },
})

const { markActivitiesDone } = proxyActivities<typeof grantsActivities>({
  startToCloseTimeout: '1 minute',
})

// NOTE: workflow code runs inside the Temporal sandbox — no runtime imports
// beyond @temporalio/workflow (utils' INTEROP would pull in disallowed Node
// built-ins). The value must match what producers put in `webId.type`.
const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'

/**
 * The inviter-side tail of an invitation accept (template: multi-param +
 * the triggering activity ref): materializes the registration at the
 * pre-minted id from the activity object (find-first), subscribes the
 * reciprocal webhook and completes. The completion rides the
 * `AgentRegistrationAddedId` ref — traceable without dereferencing.
 */
export async function establishReciprocal(
  webId: string,
  registration: SocialAgentRegistrationData,
  accountId: string,
  activity: AgentRegistrationAddedId
): Promise<void> {
  const result = await reciprocalRegistration(webId, registration, accountId)
  await reciprocalWebhook(result)
  // the initial mirror — per-pod stores mean the peer's registration of us is
  // reachable only through this local replica
  // (openwiki/architecture/federation.md 1a); the acceptor leg does the same
  // in `acceptInvitation`
  await syncMirrorActivity({
    webId: { id: webId, type: [SOCIAL_AGENT_TYPE] },
    peerId: { id: registration.registeredAgent, type: [SOCIAL_AGENT_TYPE] },
  })
  await markActivitiesDone({
    webId: { id: webId, type: [SOCIAL_AGENT_TYPE] },
    activities: [activity],
  })
}

/**
 * The acceptor-side half of an invitation accept — runs as the acceptor's own
 * AA (personal or org). Mirrors `establishReciprocal` on the acceptor side:
 * POST the opaque capabilityUrl (the inviter's AA creates its registration of
 * us and returns the inviter's webId), build our registration of the inviter,
 * discover the reciprocal, subscribe the reciprocal webhook on the inviter's
 * registration of us (each side of the pair watches the other's registration
 * — inviter via `establishReciprocal`, acceptor here), seed the local mirror
 * of that reciprocal registration, and only then mark the activity done. The
 * decoded activity object (the urn:uuid snapshot) passes verbatim; the
 * completion rides the `InvitationAcceptedId` ref.
 */
export async function acceptInvitation(
  webId: string,
  object: EmbeddedSocialAgentInvitation,
  accountId: string,
  activity: InvitationAcceptedId
): Promise<void> {
  const { registration } = await invitationAcceptance(webId, object)
  const webhook = await reciprocalRegistration(webId, registration, accountId)
  await reciprocalWebhook(webhook)
  // initial mirror, acceptor side — the inviter-side counterpart is in
  // `establishReciprocal`. Both legs must seed it: it is the ONLY local copy
  // of the peer's registration of us and of the grants the peer issued to us,
  // and delegated-grant generation reads those graphs from the local store
  // without any peer dereference (openwiki/architecture/federation.md).
  // Ordering is safe: the webhook subscription above targets the same
  // registration, so its ACR already admits this session's read.
  await syncMirrorActivity({
    webId: { id: webId, type: [SOCIAL_AGENT_TYPE] },
    peerId: { id: webhook.peerId, type: [SOCIAL_AGENT_TYPE] },
  })
  await markActivitiesDone({
    webId: { id: webId, type: [SOCIAL_AGENT_TYPE] },
    activities: [activity],
  })
}

/**
 * Mirror-sync workflow — the replication step. Started by the invitation
 * workflows (initial mirror, one per leg) and, per `delegatedGrantsUpdated`
 * activity, by the delegated-grants consumer (which serializes it per
 * `(webId, peerId)` and runs it BEFORE regenerating grants —
 * openwiki/architecture/federation.md). Re-fetches the peer's reciprocal
 * registration (+ data grants) with the context's own credentials and
 * rewrites the local mirror graphs.
 */
export async function syncReciprocalMirror(
  payload: activities.SyncReciprocalMirrorInput
): Promise<void> {
  await syncMirrorActivity(payload)
}
