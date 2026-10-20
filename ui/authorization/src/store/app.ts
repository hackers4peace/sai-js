import type {
  ApplicationList,
  Authorization,
  AuthorizationData,
  DataInstanceList,
  DataRegistryList,
  InvitationAcceptedMessage,
  InvitationCreatedMessage,
  Resource,
  Role,
  RoleCreatedMessage,
  RoleDeletedMessage,
  RoleList,
  ShareAuthorization,
  ShareAuthorizationConfirmation,
  SocialAgentInvitationList,
  SocialAgentList,
  UnregisteredApplication,
} from '@janeirodigital/sai-api-messages'
import { IRI } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import * as effect from '@/effect'
import type { ActivityEvent } from '@/events'

import { useCoreStore } from './core'

export const useAppStore = defineStore('app', () => {
  const coreStore = useCoreStore()
  const lang = ref('en')
  /** the webId the UI currently operates in (org-admin context, §2.6) */
  const context = ref<string | null>(null)
  const resource = ref<S.Schema.Type<typeof Resource> | null>(null)
  const shareAuthorizationConfirmation = ref<S.Schema.Type<
    typeof ShareAuthorizationConfirmation
  > | null>(null)
  const authorizationData = ref<S.Schema.Type<typeof AuthorizationData> | null>(null)
  const accessRequestIriRef = ref<string | undefined>()
  const socialAgentList = ref<S.Schema.Type<typeof SocialAgentList>>([])
  const roleList = ref<S.Schema.Type<typeof RoleList>>([])
  const application = ref<S.Schema.Type<typeof UnregisteredApplication>>()
  const loadedDataInstances = reactive<Record<string, S.Schema.Type<typeof DataInstanceList>>>({})
  const applicationList = ref<S.Schema.Type<typeof ApplicationList>>([])
  const dataRegistryList = reactive<Record<string, S.Schema.Type<typeof DataRegistryList>>>({})
  const invitationList = ref<S.Schema.Type<S.mutable<typeof SocialAgentInvitationList>>>([])

  /** the context all registry-backed RPCs target — defaults to the user's own webId */
  function currentContext(): string {
    return context.value ?? coreStore.userId ?? ''
  }

  function setContext(webId: string | null) {
    context.value = webId
  }

  /**
   * Switchable contexts — the personal context plus each org the user
   * administers, derived from the personal-context `ListSocialAgents` list
   * (admin flag + label, §2.2/§2.6 of org-admin-feature.md).
   */
  const contexts = ref<{ webId: string; label: string }[]>([])

  // ──────────────────────────
  // Activity tracker + snackbar (see the OpenWiki `ui/authorization-ui.md`) — record
  // every stream activity pending → done; claims bind a user-triggered
  // action to its activity by the ack-echoed activity id (uniform anchor,
  // uniform across as:object forms); the app-shell snackbar
  // mirrors the latest claim — spinner + yellow while pending, ✓ + light
  // green on done, auto-hidden 5s after completion.
  // ──────────────────────────

  /** a claim — what to expect, bound to a stream event when it arrives */
  interface ActivityClaim {
    context: string
    type: string
    /** exact match anchor — the triggering activity's IRI, echoed in the RPC
     *  ack; unique per activity, uniform across `as:object` forms (live-link,
     *  embedded, urn:uuid snapshot, set) */
    activityId?: string
    /** fallback match anchor for ack shapes that carry no id — e.g. a
     *  pre-activityId create ack's echoed as:object invitation id */
    object?: string
    /** bound once the matching stream event arrived */
    boundActivityId?: string
    status: 'pending' | 'done'
  }

  const streamActivities = reactive<Record<string, ActivityEvent>>({})
  const claims: ActivityClaim[] = []
  const activitySnackbar = reactive({
    visible: false,
    /** mirrors the claim's status — pending: spinner, done: ✓ */
    status: 'pending' as 'pending' | 'done',
    claim: null as ActivityClaim | null,
  })

  function scheduleSnackbarHide() {
    // only the done state auto-hides; pending stays until the workflow finishes
    window.setTimeout(() => {
      if (!activitySnackbar.visible) return
      activitySnackbar.visible = false
      activitySnackbar.claim = null
    }, 5_000)
  }

  /** Bind (or refresh) a claim against the recorded events — the done event
   *  replaces the pending entry (same activity id), so an already-bound claim
   *  re-reads the CURRENT entry and flips to done even when both events
   *  arrived before the claim was registered (webhook beats the RPC ack).
   *  Exact anchor: the ack-echoed activity id; falls back to context + class
   *  (+ optional object) matching for ack shapes that carry no id. */
  function bindClaim(claim: ActivityClaim) {
    // prefer the pinned bound id (re-read the CURRENT entry under the same
    // id — pending → done), then the ack-echoed expected id, then the
    // context + class (+ optional object) fallback for ack shapes that
    // carry no id
    const found = claim.boundActivityId
      ? streamActivities[claim.boundActivityId]
      : claim.activityId
        ? streamActivities[claim.activityId]
        : Object.values(streamActivities).find(
            (a) =>
              a.actor === claim.context &&
              a.type.includes(claim.type) &&
              (claim.object === undefined || a.object === claim.object)
          )
    if (!found) return
    claim.boundActivityId = found.id
    const event = streamActivities[found.id]
    if (event.status === 'done') {
      claim.status = 'done'
      if (activitySnackbar.claim === claim) {
        activitySnackbar.status = 'done'
        scheduleSnackbarHide()
      }
    }
  }

  /** Feed a stream event into the tracker (events.ts — every pending + done). */
  function recordActivity(activity: ActivityEvent) {
    streamActivities[activity.id] = activity
    for (const claim of claims) bindClaim(claim)
  }

  /** Claim a user-triggered action's activity and surface it in the
   *  app-shell snackbar. The claim matches the stream event by the ack-echoed
   *  activity id (fallback: context + class + optional as:object); bindClaim
   *  sweeps events that already arrived, so the snackbar state is correct
   *  even if the workflow completed before the RPC ack resolved. */
  function claimActivity(expected: {
    context: string
    type: string
    object?: string
    activityId?: string
  }) {
    const claim = reactive<ActivityClaim>({ ...expected, status: 'pending' })
    claims.push(claim)
    bindClaim(claim)
    activitySnackbar.claim = claim
    activitySnackbar.status = claim.status
    activitySnackbar.visible = true
    return claim
  }

  async function listSocialAgents(force = false) {
    if (!socialAgentList.value.length || force) {
      socialAgentList.value = await effect.listSocialAgents(lang.value, currentContext())
      // discovery: the reciprocal `adminOf` flags power the switcher — the
      // orgs that made the signed-in user their admin (Phase 5: `admin` is
      // now the DIRECT marker — the agents the user made their own admins)
      if (currentContext() === coreStore.userId) {
        contexts.value = [
          { webId: coreStore.userId, label: coreStore.userId },
          ...socialAgentList.value
            .filter((agent) => agent.adminOf)
            .map((agent) => ({ webId: agent.id, label: agent.label })),
        ]
      }
    }
  }

  /** Switch the current context and re-target all registry-backed views. */
  async function switchContext(webId: string) {
    const previous = context.value
    setContext(webId)
    try {
      await listSocialAgents(true)
      await listApplications(true)
      await listRoles(true)
      await listSocialAgentInvitations(true)
    } catch (err) {
      // the context is no longer allowed (e.g. admin revoked) — revert
      console.error(err)
      setContext(previous)
      await listSocialAgents(true)
    }
  }

  async function getResource(resourceId: string) {
    resource.value = await effect.getResource(resourceId, lang.value, currentContext())
  }

  async function shareResource(shareAuthorization: S.Schema.Type<typeof ShareAuthorization>) {
    shareAuthorizationConfirmation.value = await effect.shareResource(
      shareAuthorization,
      currentContext()
    )
  }

  async function getAuthoriaztion(
    agentId: string,
    preferredLang = lang.value,
    accessNeedGroupIri?: string,
    accessRequestIri?: string
  ) {
    accessRequestIriRef.value = accessRequestIri
    authorizationData.value = await effect.getAuthoriaztionData(
      agentId,
      preferredLang,
      currentContext(),
      accessNeedGroupIri,
      accessRequestIri
    )
  }

  // TODO rename list with load
  async function listDataInstances(agentId: string, registrationId: string) {
    const dataInstances = await effect.listDataInstances(
      IRI.make(agentId),
      IRI.make(registrationId),
      currentContext()
    )
    loadedDataInstances[registrationId] = [...dataInstances]
  }

  async function listApplications(force = false) {
    if (!applicationList.value.length || force) {
      applicationList.value = await effect.listApplications(currentContext())
    }
  }

  async function listRoles(force = false) {
    if (!roleList.value.length || force) {
      roleList.value = await effect.listRoles(lang.value, currentContext())
    }
  }

  async function createRole(
    label: string,
    members: readonly S.Schema.Type<typeof IRI>[]
  ): Promise<S.Schema.Type<typeof RoleCreatedMessage>> {
    // activity-first (step 9): the role is PUT by the createRole workflow
    // later (the ack echoes the role-to-be + activityId) — the RoleCreated
    // done-row (events.ts) refreshes the roles list; the snackbar claims the
    // activity by the ack-echoed activityId
    const result = await effect.createRole(label, members, currentContext())
    claimActivity({
      context: currentContext(),
      type: 'RoleCreated',
      activityId: result.activityId,
    })
    return result
  }

  async function updateRole(
    id: S.Schema.Type<typeof IRI>,
    label: string,
    members: readonly S.Schema.Type<typeof IRI>[]
  ): Promise<S.Schema.Type<typeof Role>> {
    const role = await effect.updateRole(id, label, members, currentContext())
    listRoles(true)
    return role
  }

  async function deleteRole(
    id: S.Schema.Type<typeof IRI>
  ): Promise<S.Schema.Type<typeof RoleDeletedMessage>> {
    // activity-first (step 3): the role is DELETEd by the deleteRole workflow
    // later (the ack echoes the deleted role id + activityId) — the
    // RoleDeleted done-row (events.ts) refreshes the lists; the snackbar
    // claims the activity by the ack-echoed activityId
    const result = await effect.deleteRole(id, currentContext())
    claimActivity({
      context: currentContext(),
      type: 'RoleDeleted',
      activityId: result.activityId,
    })
    return result
  }

  async function listSocialAgentInvitations(force = false) {
    if (!invitationList.value.length || force) {
      invitationList.value = [
        ...(await effect.listSocialAgentInvitations(lang.value, currentContext())),
      ]
    }
  }

  async function authorizeApp(authorization: S.Schema.Type<typeof Authorization>) {
    // activity-first (step 2) — the RPC writes only the AuthorizationGranted
    // activity; the pending ack echoes the pre-minted DA ids + activityId
    // (the uniform UI claim anchor); the done-row refreshes the lists
    const { activityId } = await effect.authorizeApp(
      authorization,
      currentContext(),
      accessRequestIriRef.value
    )
    claimActivity({ context: currentContext(), type: 'AuthorizationGranted', activityId })
    listApplications(true)
    listSocialAgents(true)
    listRoles(true)
  }

  async function revokeGrants(grants: readonly S.Schema.Type<typeof IRI>[]) {
    await effect.revokeGrants(grants, currentContext())
    listSocialAgents(true)
    listApplications(true)
  }

  async function requestAccess(applicationId: string, agentId: string) {
    await effect.requestAccessUsingApplicationNeeds(applicationId, agentId, currentContext())
    listSocialAgents(true)
  }

  async function archiveAccessRequest(request: string) {
    // terminal resolution — the RPC acks `archived` (false = already
    // resolved no-op); refresh either way so the outgoing list clears
    await effect.archiveAccessRequest(request, currentContext())
    listSocialAgents(true)
  }

  async function getUnregisteredApplication(applicationId: string) {
    application.value = await effect.getUnregisteredApplication(applicationId)
  }

  async function listDataRegistries(agentId: string, preferedLang = 'en') {
    const dataRegistries = await effect.listDataRegistries(agentId, preferedLang, currentContext())
    dataRegistryList[agentId] = [...dataRegistries]
  }

  async function createInvitation(
    label: string,
    note?: string
  ): Promise<S.Schema.Type<typeof InvitationCreatedMessage>> {
    // activity-first (step 1): the invitation resource is PUT by the
    // createInvitation workflow later — no optimistic push; the InvitationCreated
    // done-row (events.ts) refreshes the list. The snackbar claims the activity
    // by the ack-echoed activityId (pending spinner → done ✓, step 0).
    const result = await effect.createInvitation(label, note, lang.value, currentContext())
    claimActivity({
      context: currentContext(),
      type: 'InvitationCreated',
      activityId: result.activityId,
    })
    return result
  }

  async function acceptInvitation(
    capabilityUrl: string,
    label: string,
    note?: string
  ): Promise<S.Schema.Type<typeof InvitationAcceptedMessage>> {
    // pending acknowledgment — the acceptance completes via the acceptor's
    // `invitationAccepted` workflow; the list refresh picks the new agent up.
    // Step 0 accept claim: the activity's object is a urn:uuid snapshot the
    // UI cannot know, so the claim anchors on the ack-echoed activity id
    // (exact match — no cross-binding between in-flight accepts).
    const result = await effect.acceptInvitation(
      capabilityUrl,
      label,
      note,
      lang.value,
      currentContext()
    )
    claimActivity({
      context: currentContext(),
      type: 'InvitationAccepted',
      activityId: result.activityId,
    })
    listSocialAgents(true)
    return result
  }

  /** Promote/demote an agent in the current context — §2.6 toggle-admin.
   *  Org context: fellow admins; personal context (Phase 5): the user's own
   *  admins — a regular user manages their own registry set. */
  async function toggleAdmin(webId: string, admin: boolean): Promise<void> {
    if (admin) {
      // activity-first (step 5): the AdminAuthorization is PUT by the addAdmin
      // workflow later (the ack echoes the pre-minted id + activityId) — the
      // AdminAuthorizationGranted done-row (events.ts) refreshes the agent
      // list; the snackbar claims the activity by the ack-echoed activityId
      const result = await effect.addAdmin(webId, currentContext())
      claimActivity({
        context: currentContext(),
        type: 'AdminAuthorizationGranted',
        activityId: result.activityId,
      })
    } else {
      // activity-first (step 6): the AdminAuthorization is DELETEd by the
      // removeAdmin workflow later (the ack echoes the revoked id +
      // activityId) — the AdminAuthorizationRevoked done-row (events.ts)
      // refreshes the agent list; the snackbar claims the activity by the
      // ack-echoed activityId
      const result = await effect.removeAdmin(webId, currentContext())
      claimActivity({
        context: currentContext(),
        type: 'AdminAuthorizationRevoked',
        activityId: result.activityId,
      })
    }
  }

  return {
    lang,
    context,
    contexts,
    resource,
    authorizationData,
    loadedDataInstances,
    socialAgentList,
    roleList,
    application,
    applicationList,
    dataRegistryList,
    shareAuthorizationConfirmation,
    invitationList,
    activitySnackbar,
    recordActivity,
    claimActivity,
    setContext,
    switchContext,
    currentContext,
    toggleAdmin,
    getResource,
    shareResource,
    getAuthoriaztion,
    listDataInstances,
    authorizeApp,
    revokeGrants,
    requestAccess,
    archiveAccessRequest,
    listSocialAgents,
    listRoles,
    createRole,
    updateRole,
    deleteRole,
    getUnregisteredApplication,
    listApplications,
    listDataRegistries,
    createInvitation,
    listSocialAgentInvitations,
    acceptInvitation,
  }
})
