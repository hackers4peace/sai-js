import type {
  AdminAuthorizationGrantedId,
  AdminAuthorizationRevokedId,
  AgentId,
  EmbeddedAdminAuthorization,
  SocialAgentId,
} from '@janeirodigital/interop-data-model'
import { executeChild, proxyActivities } from '@temporalio/workflow'

import type * as adminActivities from '../activities/admin.js'
import type * as grantsActivities from '../activities/grants.js'

const {
  buildAdminGrants,
  storeAdminGrant,
  createAdminGrantAcr,
  replaceAdminGrantLink,
  findAdminGrants,
  deleteAdminGrants,
  recordAdminAuthorizationAtId,
  deleteAdminAuthorizationAtId,
  syncAdminAcr: syncAdminAcrActivity,
} = proxyActivities<typeof adminActivities>({
  startToCloseTimeout: '1 minute',
})

// NOTE: workflow code runs inside the Temporal sandbox — no runtime imports
// beyond @temporalio/workflow (utils' INTEROP would pull in disallowed Node
// built-ins). The value must match what producers put in `webId.type`.
const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'

const { markActivitiesDone } = proxyActivities<Pick<typeof grantsActivities, 'markActivitiesDone'>>(
  {
    startToCloseTimeout: '1 minute',
  }
)

export interface AdminWorkflowInput {
  webId: SocialAgentId
  /** the admin webId (typed SocialAgent) */
  admin: AgentId
  /** IRI of the activity that triggered this workflow — completed by the orchestrator / grantee consumer once the ACR rewrite also succeeded */
  activityId?: string
}

/**
 * Add — `adminAuthorizationGranted`: materialize the admin marker. One
 * RegistrySet-scoped AdminGrant (linked on the registration via
 * `hasAdminGrant` in a single PATCH — one Update) plus one Read-only
 * DataRegistry-scoped grant per data registry in the org's RegistrySet, each
 * with its own ACR. Idempotent against re-delivery: the link replace rewrites
 * rather than duplicates (fresh grants are created on each run, mirroring the
 * data-grant regeneration path).
 *
 * Completion is NOT recorded here — the caller (processAdminChange or the
 * grantee consumer in grants.ts) marks done only after the ACR rewrite also
 * succeeded, so an activity never completes while one of its two pieces
 * failed (the createAdminGrants-masks-syncAdminAcr hazard).
 */
export async function createAdminGrants(payload: AdminWorkflowInput): Promise<void> {
  const { registrySetGrant, dataRegistryGrants } = await buildAdminGrants({
    webId: payload.webId,
    admin: payload.admin,
  })
  // TODO CSS SPARQL backend has a race condition on dcterms:modified when
  // multiple resources are PUT concurrently in the same container — serialized
  for (const grant of [registrySetGrant, ...dataRegistryGrants]) {
    await storeAdminGrant(grant)
    await createAdminGrantAcr({ grant })
  }
  // only the RegistrySet-scoped grant is linked (the admin marker; data
  // registries are reached through the RegistrySet)
  await replaceAdminGrantLink({
    webId: payload.webId,
    admin: payload.admin,
    grantIds: [registrySetGrant.id!],
  })
}

/**
 * Remove — `adminAuthorizationRevoked`: delete the admin's RegistrySet- and
 * DataRegistry-scoped AdminGrants (resources + ACRs) and unlink
 * `hasAdminGrant` from the registration (single PATCH → one Update).
 * Completion is recorded by the caller (see createAdminGrants).
 */
export async function revokeAdminGrants(payload: AdminWorkflowInput): Promise<void> {
  const grants = await findAdminGrants({ webId: payload.webId, admin: payload.admin })
  await deleteAdminGrants({ webId: payload.webId, grants })
  await replaceAdminGrantLink({ webId: payload.webId, admin: payload.admin, grantIds: [] })
}

/**
 * Both — rewrite the registry-set `.acr` `#fullAdminAccess` matchers from
 * the current admin list + wire the control into `#root` (idempotent derived
 * rewrite; the AuthorizationRegistry is the source of truth). An EMPTY admin
 * list writes the ACR with the control removed entirely — legitimate in the
 * personal context (Phase 5: the owner remains the operator after demoting
 * their only admin; for orgs the RPC last-admin guard prevents the state).
 * Completion is recorded by the caller (see createAdminGrants).
 */
export async function syncAdminAcr(payload: {
  webId: SocialAgentId
  activityId?: string
}): Promise<void> {
  await syncAdminAcrActivity({ webId: payload.webId })
}

/**
 * The activity-first addAdmin leg (step 5): the RPC wrote only the activity
 * (object = the AdminAuthorization-to-be at the PRE-MINTED id) — this
 * workflow PUTs the AdminAuthorization there (find-first idempotent), then
 * materializes the admin grants and the ACR rewrite, and only when BOTH
 * succeeded marks the activity done (children never mark done — the
 * createAdminGrants-masks-syncAdminAcr hazard). The triggering activity
 * rides as a typed ref for a traceable completion.
 */
export async function processAdminAuthorizationGranted(
  webId: SocialAgentId,
  authorization: EmbeddedAdminAuthorization,
  activity: AdminAuthorizationGrantedId
): Promise<void> {
  await recordAdminAuthorizationAtId({ webId, authorization })
  await executeChild(createAdminGrants, {
    args: [{ webId, admin: { id: authorization.grantee, type: [SOCIAL_AGENT_TYPE] } }],
  })
  await executeChild(syncAdminAcr, { args: [{ webId }] })
  await markActivitiesDone({ webId, activities: [activity] })
}

/**
 * The activity-first removeAdmin leg (step 6): the RPC wrote only the
 * activity (object = the existing AdminAuthorization, real-id embedded at
 * its id) — this workflow DELETEs the AdminAuthorization there (find-first,
 * 404-tolerant), revokes the admin grants and runs the ACR rewrite
 * (re-guarding the last admin), and only when ALL succeeded marks the
 * activity done. The triggering activity rides as a typed ref.
 */
export async function processAdminAuthorizationRevoked(
  webId: SocialAgentId,
  authorization: EmbeddedAdminAuthorization,
  activity: AdminAuthorizationRevokedId
): Promise<void> {
  await deleteAdminAuthorizationAtId({ webId, authorization })
  await executeChild(revokeAdminGrants, {
    args: [{ webId, admin: { id: authorization.grantee, type: [SOCIAL_AGENT_TYPE] } }],
  })
  await executeChild(syncAdminAcr, { args: [{ webId }] })
  await markActivitiesDone({ webId, activities: [activity] })
}
