import type { RoleUsage } from '@janeirodigital/interop-authorization-agent'
import {
  ActivityRegistry,
  AgentRegistry,
  RoleRegistry,
  ensureApplicationRegistration,
  getApplicationRegistration,
  getDataGrant,
  getRegistryGrants,
  getSocialAgentRegistration,
  invalidGrantsAfterRemoval,
  listContained,
  localSparqlTransport,
  presentGraphs,
  replaceDataGrants,
  storeDataAuthorizations,
} from '@janeirodigital/interop-authorization-agent'
import {
  type AccessRequestMessage,
  type AccessRevocationMessage,
  type ActivityCompleted,
  type ActivityData,
  type AgentId,
  type AgentOrRoleId,
  type AuthorizationGranted,
  ClientIdDocument,
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
import {
  dropGrantReplicas as dropReplicas,
  storeGrantReplica,
} from '../../services/GrantReplica.js'
import { mirroredGrants } from '../../services/ReciprocalMirror.js'
import { delegatedGrantTrees, grantTrees, pairTrees } from './check-equivalence.js'

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
  /** `generated.sourceGrants` ids to keep (parents AND children of matched trees) */
  reusedSourceIds: string[]
  /** indexes into `generated.delegatedGrants` (top-level only) to keep */
  reusedDelegatedIndexes: number[]
  /** every existing grant IRI in matched trees — parents AND children */
  reusedExisting: GrantId[]
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

export interface ListGranteeRegistrationsInput {
  webId: SocialAgentId
}

/**
 * Every grantee the owner can project grants to: the social-agent and
 * application registrations (the agent universe; role members are registered
 * agents, so role-granted authorizations are covered).
 *
 * C5 drift arm (authorization state vs grant projection): the sweep re-runs
 * the idempotent `reconcileGrantsForGrantee` for each of these, so a missed
 * authorization/grant/role delivery is corrected even when no activity remains
 * pending. A grant whose grantee has no registration has no projection to heal
 * (the owner's registry orphan/closure path owns the grant resource).
 */
export async function listGranteeRegistrations(
  payload: ListGranteeRegistrationsInput
): Promise<AgentId[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const grantees = new Map<string, AgentId>()
  const add = (registration: { registeredAgent: string; type: string[] }) => {
    const agent = registration.registeredAgent
    if (!agent || grantees.has(agent)) return
    const type = registration.type.includes(INTEROP.ApplicationRegistration)
      ? INTEROP.Application
      : INTEROP.SocialAgent
    grantees.set(agent, { id: agent, type: [type] })
  }
  for (const iri of await listContained(transport, session.registrySet.hasSocialAgentRegistry.id)) {
    const registration = await getSocialAgentRegistration(transport, iri).catch(() => undefined)
    if (registration) add(registration)
  }
  for (const iri of await listContained(transport, session.registrySet.hasApplicationRegistry.id)) {
    const registration = await getApplicationRegistration(transport, iri).catch(() => undefined)
    if (registration) add(registration)
  }
  return [...grantees.values()]
}

export interface ReciprocalPair {
  peerId: AgentId
  registrationId: string
  reciprocalIri: string
}

/**
 * The reciprocal-linked social-agent registrations of the context: our
 * registration of the peer plus the peer's registration of us (the mirror).
 * Application registrations carry no `reciprocalRegistration`; they are not
 * mirrored.
 */
export async function listReciprocalRegistrations(payload: {
  webId: SocialAgentId
}): Promise<ReciprocalPair[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const pairs: ReciprocalPair[] = []
  for (const iri of await listContained(transport, session.registrySet.hasSocialAgentRegistry.id)) {
    const registration = await getSocialAgentRegistration(transport, iri).catch(() => undefined)
    if (!registration?.reciprocalRegistration) continue
    pairs.push({
      peerId: { id: registration.registeredAgent, type: [INTEROP.SocialAgent] },
      registrationId: registration.id,
      reciprocalIri: registration.reciprocalRegistration,
    })
  }
  return pairs
}

/**
 * Reciprocal-linked pairs whose local mirror is **missing or incomplete**:
 * the mirrored peer-registration graph is absent, or a grant still linked from
 * it has no body (resource or `meta:` twin). This is the local, no-peer-fetch
 * completeness check — the only signal for a mirror that was never written or
 * lost a graph when no `DelegatedGrantsUpdated` activity exists (D20).
 */
export async function findIncompleteReciprocalMirrors(payload: {
  webId: SocialAgentId
}): Promise<ReciprocalPair[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const incomplete: ReciprocalPair[] = []
  for (const pair of await listReciprocalRegistrations(payload)) {
    const linked = await mirroredGrants(session.sparqlEndpoint, pair.reciprocalIri)
    const present = await presentGraphs(transport, [pair.reciprocalIri, ...linked])
    if (!present.has(pair.reciprocalIri) || linked.some((iri) => !present.has(iri))) {
      incomplete.push(pair)
    }
  }
  return incomplete
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

export interface GetExistingGrantBodiesInput {
  webId: SocialAgentId
  /** grant IRIs from `getExistingGrants` (the registration projection) */
  grants: GrantId[]
}

/**
 * Load existing grant **bodies** from the local plane only — the grantor's own
 * grant registry for source grants and (once replicated) the issuer-side grant
 * replica for delegated grants. Never dereferences a peer resource: one graph
 * read per IRI through the session's own SPARQL endpoint.
 *
 * Declared children (`hasInheritingGrant`) are followed recursively, so a
 * child that is not linked from the registration projection still joins its
 * parent's tree. A missing or unframable body is skipped — the tree it belongs
 * to then fails `grantTrees`' completeness check and is never reused (fail
 * closed; the regeneration replaces the old subtree and, in a later step, the
 * replica write repopulates the body).
 */
export async function getExistingGrantBodies(
  payload: GetExistingGrantBodiesInput
): Promise<GrantData[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const bodies = new Map<string, GrantData>()
  const attempted = new Set<string>()
  const queue = [
    ...new Set(
      payload.grants
        .map((grant) => grant.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ]
  while (queue.length > 0) {
    const iri = queue.shift()!
    if (attempted.has(iri)) continue
    attempted.add(iri)
    let grant: GrantData
    try {
      grant = await getDataGrant(transport, iri)
    } catch {
      continue // missing/unframable body → fail closed (not reusable)
    }
    bodies.set(iri, grant)
    for (const child of grant.hasInheritingGrant ?? []) {
      if (typeof child === 'string' && !attempted.has(child)) queue.push(child)
    }
  }
  return [...bodies.values()]
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
    // the grant's own ACR is part of its lifecycle — delete it with the
    // resource (a deleted resource leaves the ACR orphaned otherwise)
    const head = await session.fetch(grant.id!, { method: 'HEAD' })
    const acrId = head.ok ? getAcl(head.headers.get('link')) : undefined
    if (acrId) {
      const acrResponse = await session.fetch(acrId, { method: 'DELETE' })
      if (!acrResponse.ok && acrResponse.status !== 404) {
        throw new Error(`failed to delete grant ACR: ${acrResponse.status}`)
      }
    }
    const response = await session.fetch(grant.id!, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete grant: ${response.status}`)
    }
  }
}

/**
 * C1 revocation closure for the actor's own grant registry (C2/C3): load the
 * registry, compute every grant that becomes invalid once `grants` are treated
 * as absent (plus inheriting children), delete the whole closure (resource +
 * ACR), and return the removed IRIs. Idempotent (404-tolerant deletes).
 */
export async function revokeGrantClosure(payload: {
  webId: SocialAgentId
  grants: GrantId[]
}): Promise<string[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const registryGrants = await getRegistryGrants(transport, session.registrySet.hasGrantRegistry.id)
  const closure = invalidGrantsAfterRemoval(
    registryGrants,
    payload.grants.map((grant) => grant.id!)
  )
  await deleteDataGrants({
    webId: payload.webId,
    grants: closure.map((grant) => ({ id: grant.id!, type: grant.type ?? [INTEROP.DataGrant] })),
  })
  return closure.map((grant) => grant.id!)
}

/**
 * Grantor-side revocation request at the data owner's delegation boundary
 * (C2/C3, the `requestDelegations` mirror): POST `AccessRevocation` with the
 * listed grant IRIs and return the owner's echo. The owner deletes the whole
 * C1 closure with its own session; the echo is the listed set (the requester
 * only cleans up its own projection/replicas for those).
 */
export async function requestRevocations(payload: {
  webId: SocialAgentId
  dataOwner: string
  grants: GrantId[]
}): Promise<string[]> {
  if (payload.grants.length === 0) return []
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const endpoint = await discoverDelegationIssuanceEndpoint(payload.dataOwner, session.fetch)
  const message: AccessRevocationMessage = {
    type: [INTEROP.AccessRevocation],
    grants: payload.grants.map((grant) => grant.id!),
  }
  const response = await session.fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/ld+json' },
    body: JSON.stringify(message),
  })
  if (!response.ok) {
    throw new Error(
      `revocation request failed: ${response.status} ${await response.text().catch(() => '')}`
    )
  }
  const removed = (await response.json()) as unknown
  if (!Array.isArray(removed) || !removed.every((id) => typeof id === 'string')) {
    throw new Error('invalid revocation response: expected the removed grant IRIs')
  }
  return removed as string[]
}

/**
 * Drop the issuer-side replica graphs of the given delegated grants (the
 * grantor's local copy used by `checkEquivalence`). Never touches own
 * grant-registry graphs.
 */
export async function dropGrantReplicas(payload: {
  webId: SocialAgentId
  grants: string[]
}): Promise<void> {
  if (payload.grants.length === 0) return
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  await dropReplicas(session.sparqlEndpoint, payload.grants)
}

/**
 * Orphan scan for the actor's own grant registry: grants whose `grantee`
 * matches, including ones no longer linked from the registration projection.
 * Unioned with the projection in `reconcileGrantsForGrantee` so a crash
 * between delete and PATCH cannot hide collectable grants.
 */
export async function getRegistryGrantsForGrantee(payload: {
  webId: SocialAgentId
  grantee: AgentId
}): Promise<GrantId[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const grants = await getRegistryGrants(transport, session.registrySet.hasGrantRegistry.id)
  return grants
    .filter((grant) => grant.grantee === payload.grantee.id)
    .map((grant) => ({ id: grant.id!, type: grant.type ?? [INTEROP.DataGrant] }))
}

/**
 * Resolve a plain-IRI grantee to its store kind (role vs social agent vs
 * application) — the authorization-revocation workflow's role expansion.
 */
export async function resolveGranteeKind(payload: {
  webId: SocialAgentId
  grantee: string
}): Promise<AgentOrRoleId> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  return session.typeGrantee(payload.grantee)
}

// ---------------------------------------------------------------------------
// Equivalence (wired; dummy until the real comparison lands)
// ---------------------------------------------------------------------------

/**
 * Real comparison: **both** generated tree kinds are paired as whole subtrees
 * against existing bodies loaded from the local plane.
 *
 * - Source trees (we are the `dataOwner`) pair with existing trees owned by us
 *   (own grant registry).
 * - Delegated trees (a peer is the `dataOwner`) pair with existing trees owned
 *   by a peer — the issuer-side replica written at issuance time.
 *
 * Missing bodies fail closed (`getExistingGrantBodies` skips them), so a
 * pre-replica grant simply gets regenerated and repopulates the replica.
 */
export async function checkEquivalence(payload: CheckEquivalenceInput): Promise<EquivalenceResult> {
  const existingGrants = await getExistingGrantBodies({
    webId: payload.webId,
    grants: payload.existing,
  })
  const existingTrees = grantTrees(existingGrants)
  const sourceExisting = existingTrees.filter((tree) => tree.grant.dataOwner === payload.webId.id)
  const delegatedExisting = existingTrees.filter(
    (tree) => tree.grant.dataOwner !== payload.webId.id
  )

  const reusedSourceIds: string[] = []
  const reusedDelegatedIndexes: number[] = []
  const reusedExisting = new Map<string, GrantId>()
  const rememberExisting = (pairs: ReturnType<typeof pairTrees>) => {
    for (const pair of pairs) {
      for (const node of pair.nodes) {
        if (node.existing.id) {
          reusedExisting.set(node.existing.id, {
            id: node.existing.id,
            type: node.existing.type,
          })
        }
      }
    }
  }

  const sourcePairs = pairTrees(grantTrees(payload.generated.sourceGrants), sourceExisting)
  for (const pair of sourcePairs) {
    for (const node of pair.nodes) {
      if (node.generated.id) reusedSourceIds.push(node.generated.id)
    }
  }
  rememberExisting(sourcePairs)

  // delegated generated grants carry no ids yet — the result addresses them by
  // their position in the workflow's `delegatedGrants` array
  const delegatedTrees = delegatedGrantTrees(payload.generated.delegatedGrants)
  const delegatedIndexByTree = new Map(delegatedTrees.map((tree, index) => [tree, index] as const))
  const delegatedPairs = pairTrees(delegatedTrees, delegatedExisting)
  for (const pair of delegatedPairs) {
    const index = delegatedIndexByTree.get(pair.generated)
    if (index !== undefined) reusedDelegatedIndexes.push(index)
  }
  rememberExisting(delegatedPairs)

  return {
    reusedSourceIds,
    reusedDelegatedIndexes,
    reusedExisting: [...reusedExisting.values()],
  }
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
  const issued = (await response.json()) as unknown
  if (
    !Array.isArray(issued) ||
    !issued.every(
      (grant) =>
        typeof grant === 'object' &&
        grant !== null &&
        typeof (grant as FinalGrantData).id === 'string'
    )
  ) {
    throw new Error('invalid delegation response: expected the finalised grants')
  }
  const finalGrants = issued as FinalGrantData[]
  // Best-effort replica write: the grants are already issued, so failing here
  // would retry the POST and mint duplicates. A missing replica body only
  // disables reuse (fail closed); the next issuance repopulates it.
  try {
    await storeGrantReplica(session.sparqlEndpoint, finalGrants)
  } catch {
    // intentionally swallowed — see the comment above
  }
  return finalGrants.map((grant) => ({ id: grant.id, type: grant.type }))
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
  // `replaceDataGrants` is a no-op when the link set is unchanged (no PATCH,
  // no reciprocal webhook), so an unchanged projection from the sweep writes
  // nothing.
  await replaceDataGrants(
    agentRegistration,
    session.fetch,
    payload.grants.map((grant) => grant.id!)
  )
}

/**
 * Owner-side projection cleanup after a boundary/owner revocation (C4):
 * remove the removed grant IRIs from the data owner's registration of each
 * grantee (`hasDataGrant`). The owner's registration is the document the
 * grantee mirrors, so this PATCH is what makes the peer's reciprocal webhook
 * drop the grants from its mirror. A role grantee has no agent registration
 * and is skipped (its members' links are healed by the next reconciliation /
 * sweep). Idempotent — removing an absent link is a no-op PATCH.
 */
export async function removeGrantsFromRegistrations(payload: {
  webId: SocialAgentId
  groups: { grantee: string; grants: string[] }[]
}): Promise<void> {
  if (payload.groups.length === 0) return
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  for (const group of payload.groups) {
    await session.removeGrantsFromRegistration(group.grantee, group.grants)
  }
}

// ---------------------------------------------------------------------------
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
  /**
   * Run one mirror-sync + delegated-grant regeneration even when no
   * `DelegatedGrantsUpdated` activity is pending (the scheduled mirror-freshness
   * / local completeness repair path, D20).
   */
  forceSync?: boolean
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
