import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { RoleUsage } from '@janeirodigital/interop-authorization-agent'
import {
  ActivityRegistry,
  AgentRegistry,
  RoleRegistry,
  ensureApplicationRegistration,
  replaceDataGrants,
  storeDataAuthorizations,
} from '@janeirodigital/interop-authorization-agent'
import {
  type AccessRequestMessage,
  type ActivityCompleted,
  type ActivityData,
  type AdminAuthorizationGranted,
  type AdminAuthorizationRevoked,
  type AgentId,
  type AgentOrRoleId,
  type AuthorizationGranted,
  type AuthorizationRevoked,
  ClientIdDocument,
  DataAuthorization,
  type DataAuthorizationData,
  type DataAuthorizationId,
  type DelegatedGrantsUpdated,
  type FinalDataAuthorizationData,
  type FinalGrantData,
  type GeneratedGrants,
  type GrantData,
  type GrantId,
  type IncomingGrantData,
  Role,
  type RoleData,
  type RoleId,
  type SocialAgentId,
  dataGrantAcrJsonLd,
  dataModelContext,
  getDataGrantIris,
  isActivityClass,
  toJsonLd,
} from '@janeirodigital/interop-data-model'
const loadRole = loader(Role.fromJsonLd)
const loadDataAuthorization = loader(DataAuthorization.fromJsonLd)
const loadClientIdDocument = loader(ClientIdDocument.fromJsonLd)

import {
  INTEROP,
  discoverAuthorizationAgent,
  discoverDelegationIssuanceEndpoint,
  expandedJsonLd,
  getAcl,
  loader,
  putJsonLd,
  withContext,
} from '@janeirodigital/interop-utils'

import { buildSessionManager } from '../../builders/sessionManager.js'

export interface FindAffectedAuthorizationsInput {
  webId: SocialAgentId
  peerId: SocialAgentId
  roleId?: RoleId
  /** IRI of the activity that triggered this workflow — marked done on success */
  activityId?: string
}

export interface CreateGrantsInput {
  webId: SocialAgentId
  authorizationGrantee: AgentOrRoleId
}

export interface CreateGrantsForAgentInput {
  webId: SocialAgentId
  grantee: AgentId
}

export interface GenerateGrantsInput {
  webId: SocialAgentId
  grantee: AgentId
  dataAuthorizations: DataAuthorizationId[]
}

export interface GetAuthorizationsInput {
  webId: SocialAgentId
  peerId: AgentId
}

export interface CheckEquivalenceInput {
  webId: SocialAgentId
  grantee: AgentId
  generated: GeneratedGrants
  /** the grantee's current grant IRIs (from `getExistingGrants`) */
  existing: GrantId[]
}

export interface EquivalenceResult {
  reused: { existing: GrantId; generated: GrantData }[]
}

// ---------------------------------------------------------------------------
// Authorization → grantee resolution
// ---------------------------------------------------------------------------

/**
 * Ports the match semantics of `findAuthorizationsDelegatingFromOwner`
 * (replicated over the registry-plane listing, docs/sparql.md candidate 3;
 * with optional roleId — when roleId is undefined, `updateDelegatedGrants` —
 * the logic also matches All-scope authorizations) and returns the deduped
 * grantees (typed, may include roles).
 */
export async function findAffectedGrantees(
  payload: FindAffectedAuthorizationsInput
): Promise<AgentOrRoleId[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  // the match semantics live in the AA session method (relocated Phase 4)
  return session.findAffectedGrantees(payload.peerId.id, payload.roleId?.id)
}

export async function findRoleUsage(payload: {
  webId: SocialAgentId
  roleId: RoleId
}): Promise<RoleUsage> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  // role usage scanning lives in the AA session method (relocated Phase 4)
  return session.findRoleUsage(payload.roleId.id)
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

/** Routes by type: Role → its members, agent types → [grantee] as-is. */
export async function getGrantees(payload: {
  webId: SocialAgentId
  grantee: AgentOrRoleId
}): Promise<AgentId[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  // role → members routing lives in the AA session method (relocated Phase 4)
  return session.getGrantees(payload.grantee)
}

// ---------------------------------------------------------------------------
// Role update (activity-first step 2 — the updateRole move)
// ---------------------------------------------------------------------------

/**
 * PATCH the role to its intended state with the context's own session — the
 * activity-first updateRole leg. Find-first by the STABLE role id: the role
 * is loaded first (the before-image the workflow derives the affected diff
 * from) and the write is a full-resource PUT (`RoleRegistry.updateRole`), so
 * a re-run after a crash or a reconcile re-delivery just re-writes the same
 * state. Returns the role's members before the update.
 */
export async function updateRoleInRegistry(payload: {
  webId: SocialAgentId
  role: RoleData
}): Promise<string[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const before = await loadRole(payload.role.id, session.fetch)
  await RoleRegistry.updateRole(
    session.registrySet.hasRoleRegistry,
    session.fetch,
    payload.role.id,
    payload.role.label,
    payload.role.members
  )
  return before.members
}

// ---------------------------------------------------------------------------
// Role deletion (activity-first step 3 — the deleteRole move)
// ---------------------------------------------------------------------------

/**
 * DELETE the role with the context's own session — the activity-first
 * deleteRole leg. Find-first by the STABLE role id: a retry or reconcile
 * re-delivery after the role was already deleted (e.g. a crash between the
 * DELETE and the completion) must NOT throw — 404-tolerant skip. The
 * affected set rides the activity's embedded role-to-be (the write-time
 * snapshot), never this read.
 */
export async function deleteRoleFromRegistry(payload: {
  webId: SocialAgentId
  role: RoleData
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const existing = await loadRole(payload.role.id, session.fetch).catch((): undefined => undefined)
  if (!existing) return
  await RoleRegistry.deleteRole(session.registrySet.hasRoleRegistry, session.fetch, payload.role.id)
}

// ---------------------------------------------------------------------------
// Role creation (activity-first step 9 — the createRole move)
// ---------------------------------------------------------------------------

/**
 * The activity-first createRole leg (step 9): PUT the role at the PRE-MINTED
 * id with the context's own session. Find-first by the STABLE pre-minted id
 * — idempotent under retries/reconcile: a re-run after a crash sees the
 * resource already materialized and skips (the `If-None-Match: *` PUT would
 * 412 on the second attempt). No derived work — the role is the leaf.
 */
export async function createRoleAtId(payload: {
  webId: SocialAgentId
  role: RoleData
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const existing = await loadRole(payload.role.id, session.fetch).catch((): undefined => undefined)
  if (existing) return
  // the shared context carries the `label` language-map container so the map
  // expands to proper literals on the wire
  await putJsonLd(payload.role.id, session.fetch, withContext(dataModelContext, payload.role), {
    'If-None-Match': '*',
  })
}

// ---------------------------------------------------------------------------
// Authorization fetching / grant generation
// ---------------------------------------------------------------------------

/** All authorizations for the grantee (incl. via roles), typed. */
export async function getAuthorizations(
  payload: GetAuthorizationsInput
): Promise<DataAuthorizationId[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const authorizations = await session.findAuthorizationsForAgent(payload.peerId.id)
  return authorizations.map((dataAuthorization) => ({
    id: dataAuthorization.id,
    type: dataAuthorization.type,
  }))
}

/** Generate grants from the given data authorizations. */
export async function generateGrants(payload: GenerateGrantsInput): Promise<GeneratedGrants> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  return session.generateDataGrants(
    payload.dataAuthorizations.map((dataAuthorization) => dataAuthorization.id!),
    payload.grantee.id
  )
}

// ---------------------------------------------------------------------------
// Existing grants
// ---------------------------------------------------------------------------

/**
 * The grantee's current grant **IRIs**, read from the grantor's registration of
 * the grantee (`hasDataGrant`) — local, one registration read, no grant bodies.
 *
 * Why IRIs only: every grant where the context
 * is the `grantedBy` and a peer is the `dataOwner` lives in the *peer's* grant
 * registry, so loading the bodies would be one HTTP dereference per grant — for
 * a value only `checkEquivalence` consumes, and that activity is still a dummy.
 * When real equivalence lands it needs the bodies (body-only fields like
 * `registeredShapeTree`/`scopeOfGrant`); those must come from an issuer-side
 * replica, not a peer read — see
 * [`docs/plans/check-equivalence.md`](../../../../docs/plans/check-equivalence.md) §2.1.
 */
export async function getExistingGrants(payload: {
  webId: SocialAgentId
  peerId: AgentId
}): Promise<GrantId[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const agentRegistration = await AgentRegistry.findRegistration(
    session.registrySet.hasSocialAgentRegistry,
    session.registrySet.hasApplicationRegistry,
    session.fetch,
    payload.peerId.id
  )
  if (!agentRegistration) {
    throw new Error('agent registration for the peer does not exist')
  }
  return getDataGrantIris(agentRegistration).map((id) => ({ id, type: [INTEROP.DataGrant] }))
}

/**
 * HTTP-DELETE grant resources using the webId's session.
 *
 * Internal to the data owner's revocation handler only (DD14): the
 * data-grant ACR is read-only for everyone but the owner, so a
 * grantor's direct DELETE of grant resources in another peer's registry is
 * ACR-blocked. Idempotent: 404 is tolerated (already gone).
 */
export async function deleteDataGrants(payload: {
  webId: SocialAgentId
  grants: GrantId[]
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  // TODO CSS SPARQL backend has a race condition on dcterms:modified when
  // multiple resources are PUT concurrently in the same container,
  // causing "Multiple results for http://purl.org/dc/terms/modified".
  // Change back to Promise.all after the CSS bug is fixed.
  for (const grant of payload.grants) {
    const response = await session.fetch(grant.id!, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete grant: ${response.status}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Equivalence (dummy for now)
// ---------------------------------------------------------------------------

/**
 * DUMMY for now: always returns { reused: [] } (pretend nothing is equivalent).
 * Interface ready for the real comparison (see plan "Future step").
 */
export async function checkEquivalence(
  _payload: CheckEquivalenceInput
): Promise<EquivalenceResult> {
  return { reused: [] }
}

// ---------------------------------------------------------------------------
// Deletion of data authorizations
// ---------------------------------------------------------------------------

/**
 * Separate deletion step — deletes the authorization resources whose IRIs come
 * from `findRoleUsage().authorizations` (replaces `deleteAuthorizationsUsingRole`:
 * usage scanning is findRoleUsage's job, deletion is this activity's job).
 * Idempotent: 404 is tolerated (already deleted).
 */
export async function deleteAuthorizations(payload: {
  webId: SocialAgentId
  authorizations: DataAuthorizationId[]
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  // TODO CSS SPARQL backend has a race condition on dcterms:modified when
  // multiple resources are PUT concurrently in the same container,
  // causing "Multiple results for http://purl.org/dc/terms/modified".
  // Change back to Promise.all after the CSS bug is fixed.
  for (const authorization of payload.authorizations) {
    const response = await session.fetch(authorization.id!, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete data authorization: ${response.status}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Storing grants (unchanged)
// ---------------------------------------------------------------------------

export async function storeDataGrant(payload: FinalGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.dataOwner)

  const body = JSON.stringify(await expandedJsonLd(toJsonLd(payload)))
  const response = await session.fetch(payload.id, {
    method: 'PUT',
    body,
    headers: {
      'Content-Type': 'application/ld+json',
      'If-None-Match': '*',
    },
  })
  if (!response.ok) throw new Error(`failed to store grant: ${response.status}`)
}

/*
 * 1. owner grants to a peer
 * 2. owner grants to an application
 * 3. grantor grants to a peer (delegation)
 * 4. grantor grants to an application (delegation)
 */
export async function createAcr(payload: FinalGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.dataOwner)
  // TODO: improve error handling
  let uasId
  try {
    uasId = await discoverAuthorizationAgent(payload.grantee, fetch)
  } catch {}
  let grantor
  let peer
  let client
  // if grantedBy is a peer also their UAS has write access
  // eg. ACME to Alice, then Alice to Kim
  if (payload.grantedBy !== payload.dataOwner) {
    grantor = {
      agent: payload.grantedBy,
      client: await discoverAuthorizationAgent(payload.grantedBy, fetch),
    }
  }
  if (uasId) {
    // no self granting at this moment!
    if (payload.grantee === payload.dataOwner) throw payload

    // grantee is a social agent - only their UAS has access
    peer = {
      agent: payload.grantee,
      client: uasId,
    }
  } else {
    // grantee is an application - used by the grantedBy
    client = {
      agent: payload.grantedBy,
      client: payload.grantee,
    }
  }
  if (!peer && !client) throw new Error('peer or client are required')
  const headResponse = await session.fetch(payload.id, {
    method: 'HEAD',
  })
  const acrId = getAcl(headResponse.headers.get('link'))
  if (!acrId) throw new Error(`no acl link on grant: ${payload.id}`)
  await putJsonLd(
    acrId,
    session.fetch,
    dataGrantAcrJsonLd({
      id: acrId,
      resource: payload.id,
      owner: {
        agent: session.webId,
        client: session.agentId,
      },
      grantor,
      peer,
      client,
    })
  )
}

export interface RequestDelegationsInput {
  /** the grantor (`grantedBy`) whose session issues the request */
  webId: SocialAgentId
  /** grants delegated to one data owner — the endpoint accepts them together */
  grants: GrantData[]
}

/**
 * Request delegated grants from the data owner in **one** call: grants for a
 * single `dataOwner` travel in one `interop:AccessRequest` envelope (the
 * issuance endpoint already validates a single data owner and materializes the
 * whole batch), so endpoint discovery and the POST happen once instead of once
 * per grant.
 */
export async function requestDelegations(payload: RequestDelegationsInput): Promise<GrantId[]> {
  if (payload.grants.length === 0) return []
  const dataOwners = new Set(payload.grants.map((grant) => grant.dataOwner))
  if (dataOwners.size !== 1) {
    throw new Error('requestDelegations requires grants of a single data owner')
  }
  const [dataOwner] = [...dataOwners]
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)

  const endpoint = await discoverDelegationIssuanceEndpoint(dataOwner, session.fetch)
  // the delegation endpoint takes an interop:AccessRequest envelope (§3)
  const message: AccessRequestMessage = {
    type: [INTEROP.AccessRequest],
    grants: payload.grants as unknown as IncomingGrantData[],
  }
  // the whole delegation endpoint now requires application/ld+json
  // (authorization-granting.md §6.2) — the AccessRequest envelope is
  // JSON-LD-shaped, so the header is the gate, not the body
  const response = await session.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/ld+json',
    },
    body: JSON.stringify(message),
  })
  if (!response.ok) {
    throw new Error(
      `delegation request failed: ${response.status} ${await response.text().catch(() => '')}`
    )
  }
  if (response.status !== 200) {
    throw new Error(`expected 200 but received ${response.status}`)
  }
  const iris = (await response.json()) as string[]
  return iris.map((id) => ({ id, type: [INTEROP.DataGrant] }))
}

// ---------------------------------------------------------------------------
// Registration link/unlink
// ---------------------------------------------------------------------------

export interface ReplaceDataGrantsOnRegistrationInput {
  webId: SocialAgentId
  grantee: AgentId
  grants: GrantId[]
}

/**
 * Set the grantee's registration hasDataGrant links to exactly `grants` in a
 * single PATCH (remove old + insert new) → exactly one Update notification on
 * the registration. Deny case: `grants: []`.
 */
export async function replaceDataGrantsOnRegistration(
  payload: ReplaceDataGrantsOnRegistrationInput
): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const agentRegistration = await AgentRegistry.findRegistration(
    session.registrySet.hasSocialAgentRegistry,
    session.registrySet.hasApplicationRegistry,
    session.fetch,
    payload.grantee.id
  )
  if (!agentRegistration) {
    throw new Error('agent registration for the grantee does not exist')
  }
  await replaceDataGrants(
    agentRegistration,
    session.fetch,
    payload.grants.map((grant) => grant.id!)
  )
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Grantor-side grantee of an authorization/admin activity — read from the object
// ---------------------------------------------------------------------------

/**
 * The grantee of an `authorizationRecorded`/`authorizationRevoked` or
 * `adminAuthorizationGranted`/`adminAuthorizationRevoked` activity, read
 * from the `as:object` (parties ride the object). Authorizations: the first
 * object DataAuthorization's `grantee`, its kind resolved in the store
 * (`session.typeGrantee` — role vs social agent vs application). Admin
 * authorizations: the object's `grantee` (always a social agent). Returns
 * undefined when the activity is not an authorization/admin activity or its
 * object is unresolvable.
 */
export async function resolveActivityGrantee(payload: {
  activity: ActivityData
}): Promise<AgentOrRoleId | undefined> {
  const manager = buildSessionManager()
  const actor = (payload.activity as { actor: string }).actor
  const session = await manager.getSession(actor)
  if (
    isActivityClass(payload.activity, 'AuthorizationGranted') ||
    isActivityClass(payload.activity, 'AuthorizationRevoked')
  ) {
    const authorizationActivity = payload.activity as AuthorizationGranted | AuthorizationRevoked
    // granted → the first embedded DataAuthorization POJO (no deref — the
    // resource does not exist until the workflow PUTs it); revoked → the
    // first live-link DataAuthorization (deref). `granteeFromObject` handles
    // both. (Declines are `AuthorizationDenied` — forward-only, no dispatch.)
    const grantee = await granteeFromObject(
      (authorizationActivity.object as (string | DataAuthorizationData)[])[0],
      session
    )
    if (!grantee) return undefined
    return session.typeGrantee(grantee)
  }
  if (
    isActivityClass(payload.activity, 'AdminAuthorizationGranted') ||
    isActivityClass(payload.activity, 'AdminAuthorizationRevoked')
  ) {
    // both admin forms embed the AdminAuthorization snapshot — the RPC
    // records/deletes the resource synchronously, so nothing is dereferenced
    const adminActivity = payload.activity as AdminAuthorizationGranted | AdminAuthorizationRevoked
    return { id: adminActivity.object.grantee, type: [INTEROP.SocialAgent] }
  }
  return undefined
}

/** The grantee of an object's first DataAuthorization — live link (404
 * tolerant: the DA may already be gone — a later deny deleted the grantee's
 * authorizations) or embedded POJO (granted form reads the grantee directly).
 * A lost object must skip the activity, never fail the sweep. */
async function granteeFromObject(
  idOrNode: string | DataAuthorizationData | undefined,
  session: AuthorizationAgent
): Promise<string | undefined> {
  if (!idOrNode) return undefined
  if (typeof idOrNode === 'string') {
    try {
      const authorization = await loadDataAuthorization(idOrNode, session.fetch)
      return authorization.grantee
    } catch {
      return undefined
    }
  }
  return idOrNode.grantee
}

// ---------------------------------------------------------------------------
// Authorization granted (activity-first step 2 — the dedicated workflow)
// ---------------------------------------------------------------------------

export interface StoreAuthorizationGrantedInput {
  webId: SocialAgentId
  dataAuthorizations: FinalDataAuthorizationData[]
}

/**
 * Materialize the pre-built DataAuthorizations at their embedded ids (the
 * `processAuthorizationGranted` workflow's materialize step). Runs as the
 * context's own session (`getSession(webId)`); the AA `storeDataAuthorizations`
 * is find-first idempotent (`If-None-Match: *`).
 */
export async function storeAuthorizationGranted(
  payload: StoreAuthorizationGrantedInput
): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  await storeDataAuthorizations(payload.dataAuthorizations, {
    fetch: session.fetch,
    randomUUID: session.randomUUID,
  })
}

export interface AuthorizationGrantedObjectInput {
  webId: SocialAgentId
  object: AuthorizationGranted['object']
}

export interface ProcessGranteeAuthorizationInput {
  webId: SocialAgentId
  /** one grantee's DataAuthorizations-to-be (a group from the parent) */
  dataAuthorizations: AuthorizationGranted['object']
}

/**
 * Split an `AuthorizationGranted` object into per-grantee groups — one child
 * workflow per agent (refinement §5.1, authorization-granting.md). Members
 * are the flat DataAuthorization POJOs (parents + children; every member
 * carries its `grantee`). The workflow (workflows/grants.ts) keeps a
 * sandbox-safe inline mirror — see the NOTE at its top (no runtime imports
 * of this module inside the Temporal sandbox).
 */
export function groupAuthorizationDataAuthorizations(
  object: AuthorizationGranted['object']
): AuthorizationGranted['object'][] {
  const byGrantee = new Map<string, DataAuthorizationData[]>()
  for (const dataAuthorization of object) {
    const group = byGrantee.get(dataAuthorization.grantee) ?? []
    group.push(dataAuthorization)
    byGrantee.set(dataAuthorization.grantee, group)
  }
  return [...byGrantee.values()]
}

/**
 * The grantee of an `AuthorizationGranted` object — kind via the store
 * (`session.typeGrantee`). The object is the embedded DataAuthorization
 * POJO(s)-to-be: the grantee is read from the first DA (no deref — the
 * resources do not exist until the workflow PUTs them). An unresolvable
 * grantee = an unregistered agent → only applications are auto-registered at
 * grant time (`ensureApplicationRegistration`, then re-check); the grantee
 * kind cannot ride the wire (no `agentType` term).
 */
export async function resolveAuthorizationGrantee(
  payload: AuthorizationGrantedObjectInput
): Promise<AgentOrRoleId | undefined> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const granteeIri = payload.object[0]?.grantee
  if (!granteeIri) return undefined
  try {
    return await session.typeGrantee(granteeIri)
  } catch {
    // unregistered — only APPLICATIONS are auto-registered at grant time
    // (authorization-granting.md Step 2). The RPC no longer carries
    // agentType (the grantee kind is store-inferred, anti-spoofing), so
    // verify the grantee actually has a client-id document before creating
    // an application registration — a social agent's WebID frames none of
    // the interop/OIDC client terms, a role is already resolved above.
    let hasClientDocument = false
    try {
      const doc = await loadClientIdDocument(granteeIri, session.fetch)
      hasClientDocument =
        doc.clientName !== undefined ||
        doc.hasAccessNeedGroup !== undefined ||
        doc.callbackEndpoint !== undefined
    } catch {
      /* unreadable — not an application */
    }
    if (!hasClientDocument) {
      throw new Error(`grantee is neither a registered agent nor an application: ${granteeIri}`)
    }
    await ensureApplicationRegistration(
      session.registrySet.hasApplicationRegistry,
      { fetch: session.fetch, randomUUID: session.randomUUID },
      { agent: payload.webId.id, client: session.agentId },
      granteeIri
    )
    return session.typeGrantee(granteeIri)
  }
}

// ---------------------------------------------------------------------------
// Per-target consumer (Phase 4.1): drain + coalesce authorization activities
// ---------------------------------------------------------------------------

export interface GetPendingGranteeActivitiesInput {
  webId: SocialAgentId
  authorizationGrantee: AgentOrRoleId
}

/**
 * The pending authorizationRecorded/authorizationRevoked activities targeting
 * the given grantee in the activity registry (not yet completed). The grantee
 * is read from each activity's `as:object` (parties ride the object).
 */
export async function getPendingGranteeActivities(
  payload: GetPendingGranteeActivitiesInput
): Promise<ActivityData[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registry = session.registrySet.hasActivityRegistry
  if (!registry) return []
  const iris = await ActivityRegistry.getActivityIris(registry, session.fetch)
  // pass 1 — partition completions into a completed-set, keep the work items
  // (NO grantee resolution yet: completed activities may reference deleted
  // DataAuthorizations — e.g. a later deny removed them — and must never be
  // dereferenced)
  const workItems: ActivityData[] = []
  const completed = new Set<string>()
  for (const iri of iris) {
    const activity = await ActivityRegistry.loadActivity(iri, session.fetch)
    if (isActivityClass(activity, 'ActivityCompleted')) {
      completed.add((activity as ActivityCompleted).target)
      continue
    }
    if (
      !isActivityClass(activity, 'AuthorizationGranted') &&
      !isActivityClass(activity, 'AuthorizationRevoked')
    )
      continue
    workItems.push(activity)
  }
  // pass 2 — the grantee is read from each PENDING activity's `as:object`
  // (parties ride the object); activities already completed are skipped
  const pending: ActivityData[] = []
  for (const activity of workItems) {
    if (completed.has(activity.id)) continue
    const grantee = await resolveActivityGrantee({ activity })
    if (!grantee || grantee.id !== payload.authorizationGrantee.id) continue
    pending.push(activity)
  }
  return pending
}

export interface GetPendingActivitiesInput {
  webId: SocialAgentId
}

/**
 * All pending activities (any non-completion type, no completion referencing
 * them) in the webId's activity registry.
 */
export async function getPendingActivities(
  payload: GetPendingActivitiesInput
): Promise<ActivityData[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registry = session.registrySet.hasActivityRegistry
  if (!registry) return []
  const iris = await ActivityRegistry.getActivityIris(registry, session.fetch)
  // one pass: partition completions into a completed-set, keep the rest
  const workItems: ActivityData[] = []
  const completed = new Set<string>()
  for (const iri of iris) {
    const activity = await ActivityRegistry.loadActivity(iri, session.fetch)
    if (isActivityClass(activity, 'ActivityCompleted')) {
      completed.add((activity as ActivityCompleted).target)
    } else {
      workItems.push(activity)
    }
  }
  return workItems.filter((activity) => !completed.has(activity.id))
}

export interface DelegatedGrantsConsumerInput {
  /** the context whose registry set is being regenerated */
  webId: SocialAgentId
  /** the peer whose reciprocal registration changed (`activity.target`) */
  peerId: SocialAgentId
}

/**
 * Pending `delegatedGrantsUpdated` activities **for one peer** — the
 * delegated-grants consumer's drain (openwiki/architecture/federation.md).
 * `getPendingActivities` lists everything pending in the registry; this
 * narrows it to the class and to the peer in `target` (the consumer is
 * per-`(webId, peerId)`, so unrelated activities stay with their own
 * workflows).
 */
export async function getPendingDelegatedGrantsUpdates(
  payload: DelegatedGrantsConsumerInput
): Promise<ActivityData[]> {
  const pending = await getPendingActivities({ webId: payload.webId })
  return pending.filter(
    (activity) =>
      isActivityClass(activity, 'DelegatedGrantsUpdated') &&
      (activity as DelegatedGrantsUpdated).target === payload.peerId.id
  )
}

export interface MarkActivitiesDoneInput {
  webId: SocialAgentId
  /** the activities to complete — only their ids are read */
  activities: { id: string }[]
}

/** Mark the given activities done (one minimal completion activity each). */
export async function markActivitiesDone(payload: MarkActivitiesDoneInput): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registry = session.registrySet.hasActivityRegistry
  if (!registry) return
  for (const activity of payload.activities) {
    await ActivityRegistry.createCompletion(
      registry,
      { fetch: session.fetch, randomUUID: session.randomUUID },
      activity.id
    )
  }
}
