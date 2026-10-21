import type { LanguageMap } from '@janeirodigital/interop-utils'

import type { NeedBasedAccessRequestGroup } from './access-request.ts'
import type { DataAuthorizationData } from './data-authorization.ts'
import type { RoleData } from './role.ts'
import type { SocialAgentInvitationData } from './social-agent-invitation.ts'

// ──────────────────────────
// Activity types (the outbox) — wire contract in the OpenWiki
// `services/activity-lifecycle.md` (amended wire)
//
// One interface per activity RDF class (capitalized). `type` is the
// discriminant: the class tuple `['Activity', '<Class>', <as:*>]` — the
// values compact from the `dataModelContext` term definitions when framed.
// Fields are FLAT plain IRIs/literals on the wire (storage law: no
// `{ id, type }` ref objects in SPARQL-queried registries) — `XId` refs
// appear only in the temporal inputs the handler builds from these.
//
// The class's primary object rides as `as:object` in one of two forms
// (the object-embedding amendment — the inventory is the wire truth):
//  - live link — a single `as:object <iri>` triple (the resource exists or
//    is pre-minted via `iriForContained` and materialized by the workflow);
//  - snapshot — a minted `urn:uuid` node embedding the full POJO projection
//    inline in the activity graph (id known only at write; never
//    dereferenced — the singly-fetched activity doc already contains it).
// Parties (`admin`, `authorizationGrantee`, `peerId`, role members) ride the
// object — they are NOT flat fields; consumers read them from the embedded
// or linked POJO.
//
// `AuthorizationRequested`/`ShareRequested` (the structure-based flat
// candidates) were DROPPED — authorization-granting.md Decision A settled
// the granting carrier as the term-covered `DataAuthorizationData` POJO(s)
// embedded on `AuthorizationGranted` (no RPC structure rides the wire).
// ──────────────────────────

type ActivityBase = {
  id: string
  /** plain IRI — the changed record/container, or (for ActivityCompleted)
   *  the completed activity IRI — storage law: no ref objects on the wire */
  target: string
  createdAt: string
}

/**
 * Embedded SocialAgentInvitation snapshot (the `InvitationAccepted` object —
 * minted `urn:uuid` node: `type` incl. `interop:SocialAgentInvitation`,
 * the opaque `capabilityUrl`, `label`, `note`). Never dereferenced.
 */
export type EmbeddedSocialAgentInvitation = {
  id: string
  type: string[]
  capabilityUrl: string
  /** language map — the accepted snapshot carries the invitation's `label` per `SocialAgentInvitationData` */
  label: LanguageMap
  note?: string
}

/**
 * Embedded SocialAgentRegistration snapshot (the `AgentRegistrationAdded`
 * object — minted `urn:uuid` node: `type` incl.
 * `interop:SocialAgentRegistration`, `registeredAgent` — the peer,
 * `label`, `note`). Never dereferenced.
 */
export type EmbeddedSocialAgentRegistration = {
  id: string
  type: string[]
  registeredAgent: string
  /** language map — the snapshot carries `label` per `SocialAgentRegistrationData` */
  label: LanguageMap
  note?: string
}

/**
 * Embedded NeedBasedAccessRequest snapshot (the `NeedBasedAccessRequestSent`
 * object — minted `urn:uuid` node: `type` incl.
 * `interop:NeedBasedAccessRequest`, `grantee`, `grantedBy`, `dataOwner`,
 * `hasAccessNeedGroup` — the embedded (framed) access need group). Never
 * dereferenced.
 */
export type EmbeddedNeedBasedAccessRequest = {
  id: string
  type: string[]
  grantee: string
  grantedBy: string
  dataOwner: string
  /** the framed group node — (expanded-form) IRIs; descriptions follow-up */
  hasAccessNeedGroup: NeedBasedAccessRequestGroup
}

/** Acceptance of a social agent invitation (acceptor's Activity Registry).
 *
 * `target` dropped (the InvitationCreated precedent): nothing consumes the
 * acceptor's registry-set id; the object is a self-contained urn:uuid
 * snapshot (the acceptor has no owning container to mint a real id in —
 * id-unknown-at-write keeps the snapshot form). */
export type InvitationAccepted = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'InvitationAccepted', 'as:Accept']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** urn:uuid snapshot of the invitation (opaque capabilityUrl inside) */
  object: EmbeddedSocialAgentInvitation
}

/**
 * Ref to the triggering `invitationAccepted` activity — id + class tuple
 * (the XId pattern for temporal inputs; refs stay TS-level, never on the
 * wire). Carried by the `acceptInvitation` workflow's completion.
 */
export type InvitationAcceptedId = {
  id: string
  type: InvitationAccepted['type']
}

/**
 * Access request sent via RPC (activity-first — the requesting-authorization
 * leg of authorization-granting.md §6.4). `target` dropped: the object is a
 * self-contained urn:uuid snapshot (the requester has NO AccessRequestRegistry —
 * the REAL id is minted owner-side by the data owner's endpoint); the
 * requester-side workflow forwards the request to the owner's (reused)
 * issuance endpoint and completes. The `NeedBasedAccessRequestReceived`
 * counterpart is written owner-side in the next phase.
 */
export type NeedBasedAccessRequestSent = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'NeedBasedAccessRequestSent']
  /** as:actor — plain IRI (the registry owner — the requester) */
  actor: string
  /** the request snapshot (urn:uuid id, the embedded group inside) */
  object: EmbeddedNeedBasedAccessRequest
}

/** Ref to the triggering `needBasedAccessRequestSent` activity — id + class
 *  tuple (the XId pattern for temporal inputs). */
export type NeedBasedAccessRequestSentId = {
  id: string
  type: NeedBasedAccessRequestSent['type']
}

/**
 * Access request received by the data owner's endpoint (activity-first —
 * receiver side of authorization-granting.md §6.2, the minted half): the
 * handler pre-mints the request id in the OWNER's AccessRequestRegistry and
 * writes the activity — `target` = the AccessRequest registry, `as:object` =
 * the request-to-be as a REAL-ID embedded projection at the minted id; the
 * owner-side workflow PUTs the AccessRequest resource there (find-first
 * idempotent), then completes.
 */
export type NeedBasedAccessRequestReceived = ActivityBase & {
  type: ['Activity', 'NeedBasedAccessRequestReceived']
  /** as:actor — plain IRI (the registry owner — the data owner) */
  actor: string
  /** the request-to-be — real-id embedded projection at the minted id */
  object: EmbeddedNeedBasedAccessRequest
}

/** Ref to the triggering `needBasedAccessRequestReceived` activity. */
export type NeedBasedAccessRequestReceivedId = {
  id: string
  type: NeedBasedAccessRequestReceived['type']
}

/**
 * Light request ref — the `{ id, type }` projection carried by the
 * requester-side resolution activities (`AccessRequestGranted` /
 * `AccessRequestArchived`): `id` = the `NeedBasedAccessRequestSent`
 * activity's SNAPSHOT id (urn:uuid — the archive/grant targets). The full
 * snapshot (grantee, grantedBy, dataOwner, need group + per-need
 * registeredShapeTree) lives ONCE on the Sent activity — the open-set
 * queries join `outcome.object.id → sent.object.id` inside the same
 * Activity Registry (the access-request resolution spans in the OpenWiki
 * `services/activity-lifecycle.md`).
 */
export type EmbeddedAccessRequestRef = {
  id: string
  type: string[]
}

/**
 * Requester-side resolution: an open sent request was GRANTED (the
 * detector — a fire-and-forget child at the end of the `updateDelegatedGrants`
 * workflow — observed the new grant and wrote this (see the OpenWiki
 * `services/activity-lifecycle.md`). `target` dropped: the object is the light ref (the Sent activity's
 * SNAPSHOT id). No owner→requester notification needed — the outcome is
 * observed from the received-grant view. TERMINAL resolution — no
 * `ActivityCompleted`.
 */
export type AccessRequestGranted = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AccessRequestGranted']
  /** as:actor — plain IRI (the registry owner — the requester) */
  actor: string
  /** the Sent activity's snapshot id + type (urn:uuid) */
  object: EmbeddedAccessRequestRef
}

/**
 * Requester-side user close: an open sent request was ARCHIVED (the
 * `archiveAccessRequest` RPC; see the OpenWiki
 * `services/activity-lifecycle.md`). `target`
 * dropped: the object is the light ref (the Sent activity's SNAPSHOT id —
 * stable forever, so the archive works at any future point). Direct write +
 * ownership check — no workflow. TERMINAL resolution — no `ActivityCompleted`.
 */
export type AccessRequestArchived = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AccessRequestArchived']
  /** as:actor — plain IRI (the registry owner — the requester) */
  actor: string
  /** the Sent activity's snapshot id + type (urn:uuid) */
  object: EmbeddedAccessRequestRef
}

/** Invitation created via RPC (activity-first step 1).
 *
 * Note (target dropped with the embedded-object form): the class has NO
 * `target` — the changed record's id rides `object.id` (the embedded pojo),
 * and the changed *container* (the invitation registry) is not consumed by
 * any dispatch/read path. The plan pins the same removal for the other
 * workflow-materialized classes as each step lands. */
export type InvitationCreated = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'InvitationCreated', 'as:Create']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /**
   * the invitation-to-be — full `SocialAgentInvitationData` projection minus
   * `capabilityUrl` (generated by the workflow at PUT time — never known to
   * the RPC/activity) and `registeredAgent` (accept-time only). The object is
   * named by the REAL pre-minted invitation id and carries `type` — the
   * storage-law read plane self-graph-filters (`FILTER(?g = ?s)`, sparql.md)
   * so the activity-graph type claim never surfaces as authoritative.
   */
  object: CreateInvitationPojo
}

/**
 * The invitation-to-be — the stored `SocialAgentInvitationData` POJO minus
 * the fields this workflow must not receive: `capabilityUrl` (generated in
 * the workflow/activity — the RPC must never know it early) and
 * `registeredAgent` (accept-time only, never set at creation). Also the
 * `as:object` of the `InvitationCreated` activity — the handler passes the
 * decoded object verbatim into the `createInvitation` workflow input.
 */
export type CreateInvitationPojo = Omit<
  SocialAgentInvitationData,
  'capabilityUrl' | 'registeredAgent'
>

/**
 * Ref to the triggering `invitationCreated` activity — id + class tuple
 * (the XId pattern for temporal inputs; refs stay TS-level, never on the
 * wire — the completed activity's type is still read from the resource).
 * Carried by the `createInvitation` workflow so the completion it writes is
 * traceable without dereferencing (activity-first step 1).
 */
export type InvitationCreatedId = {
  id: string
  type: InvitationCreated['type']
}

/** Reciprocal social agent registration written by the invitation handler.
 *
 * `target` dropped (the InvitationCreated precedent): the changed record's
 * id rides `object.id` — the REAL pre-minted registration id (the handler
 * pre-mints via `iriForContained`; the `establishReciprocal` workflow PUTs
 * the registration there and discovers the reciprocal). */
export type AgentRegistrationAdded = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AgentRegistrationAdded', 'as:Add']
  /** as:actor — plain IRI (the session that wrote the registration) */
  actor: string
  /** real-id embedded projection of the registration-to-be — `registeredAgent`
   *  (the peer), `label`, `note` at the pre-minted id */
  object: EmbeddedSocialAgentRegistration
}

/**
 * Ref to the triggering `agentRegistrationAdded` activity — id + class
 * tuple (the XId pattern for temporal inputs). Carried by the
 * `establishReciprocal` workflow's completion.
 */
export type AgentRegistrationAddedId = {
  id: string
  type: AgentRegistrationAdded['type']
}

/** Admin authorization recorded (org context — activity-first step 5).
 * `target` dropped: the changed record's id rides `object.id`. The object
 * is a real-id embedded projection of the AdminAuthorization-to-be at the
 * PRE-MINTED id — the `addAdmin` workflow PUTs the resource there, then
 * grants + ACR rewrite, then completes (R1 re-decision: validation reads
 * stay in the RPC, the write moves to the workflow). */
export type AdminAuthorizationGranted = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AdminAuthorizationGranted']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the AdminAuthorization-to-be — real-id embedded projection at the
   *  pre-minted id (never dereferenced — the workflow materializes it) */
  object: EmbeddedAdminAuthorization
}

/** Typed activity ref for the `addAdmin` workflow's completion — the XId
 * pattern for temporal inputs (refs stay TS-level, never on the wire). */
export type AdminAuthorizationGrantedId = {
  id: string
  type: AdminAuthorizationGranted['type']
}

/**
 * Embedded AdminAuthorization — the full wire shape shared by the recorded
 * and revoked objects (real-id embedded projections at their ids, steps 5–6;
 * previously a urn:uuid snapshot). The admin's `grantee` rides inside either
 * way.
 */
export type EmbeddedAdminAuthorization = {
  id: string
  type: string[]
  grantee: string
  grantedBy: string
  scopeOfAuthorization: string
}

/** Admin authorization revoked (org context — activity-first step 6).
 * `target` dropped: the revoked record's id rides `object.id`. The object
 * is a real-id embedded projection of the EXISTING AdminAuthorization at its
 * real id (alive at write) — the `removeAdmin` workflow DELETEs it, revokes
 * grants + the ACR rewrite, then completes. The last-admin guard stays a
 * validation read in the RPC and is re-checked by `syncAdminAcr`. */
export type AdminAuthorizationRevoked = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AdminAuthorizationRevoked']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the AdminAuthorization — real-id embedded projection at the EXISTING
   *  id (never dereferenced — the workflow deletes it) */
  object: EmbeddedAdminAuthorization
}

/** Typed activity ref for the `removeAdmin` workflow's completion — the XId
 * pattern for temporal inputs (refs stay TS-level, never on the wire). */
export type AdminAuthorizationRevokedId = {
  id: string
  type: AdminAuthorizationRevoked['type']
}

/**
 * Embedded request-structure snapshot (the denied `AuthorizationGranted`
 * object — minted `urn:uuid` node; moves to `AuthorizationDenied` at the
 * deny/revoke split, authorization-granting.md Step 4). A denied
 * authorization creates NO DataAuthorization resource
 * (`recordAuthorizationFromStructure` returns [] for `granted:false`), so
 * there is nothing to link — the structure's `grantee` rides here (parties
 * ride the object); `hasAccessNeedGroup` is carried for completeness. Only
 * fields with dataModelContext terms survive the wire (agentType/granted
 * are not encoded — the grantee kind resolves in the store and `granted:
 * false` is implied by the snapshot's existence).
 */
export type EmbeddedAuthorization = {
  id: string
  type: string[]
  grantee: string
  hasAccessNeedGroup?: string
}

/** Authorization granted (activity-first granting leg,
 * authorization-granting.md Step 2/§5.1). `grantee` is read from the object —
 * its kind is resolved in the store (`getGrantees` routes by SPARQL), never
 * baked into the activity. The object is the term-covered
 * `DataAuthorizationData` POJO(s)-to-be, real-id embedded at the PRE-MINTED
 * id(s) — ONE activity carries ALL grantees' DAs (grantee rides every POJO,
 * parents and children alike; the `processAuthorizationGranted` parent
 * groups by grantee and fans out one child workflow per grantee). A single
 * embedded DA frames as an object (jsonld.md gotcha 1 — the decoder wraps
 * it). Sync/decline (no grant) is `AuthorizationDenied` (Step 4). */
export type AuthorizationGranted = ActivityBase & {
  type: ['Activity', 'AuthorizationGranted']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the resolved need-based access request (activity-level back-link — the
   *  owner-span close; see the OpenWiki `services/activity-lifecycle.md`). Optional: direct
   *  approvals without a request carry none */
  satisfiesAccessRequest?: string
  /** the AuthorizationRegistry */
  target: string
  /** the DataAuthorizations-to-be (embedded POJOs, all grantees) */
  object: DataAuthorizationData[]
}

/** Typed activity ref for the `processAuthorizationGranted` workflow's
 * completion — the XId pattern for temporal inputs (refs stay TS-level,
 * never on the wire). */
export type AuthorizationGrantedId = {
  id: string
  type: AuthorizationGranted['type']
}

/** Authorization denied (decline — silent, forward-only;
 * authorization-granting.md Step 4). `target` dropped: nothing is consumed. */
export type AuthorizationDenied = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AuthorizationDenied']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the resolved need-based access request (activity-level back-link — the
   *  owner-span close; see the OpenWiki `services/activity-lifecycle.md`). Optional: direct
   *  declines without a request carry none */
  satisfiesAccessRequest?: string
  /** the request-structure snapshot (urn:uuid) carrying `grantee` */
  object: EmbeddedAuthorization
}

/** A DataAuthorization reference (id + type) carried by `AuthorizationRevoked`. */
export type DataAuthorizationRef = {
  id: string
  type: string[]
}

/**
 * Authorization revoked — `target` dropped (the AdminAuthorizationRevoked
 * precedent). `object` is the revoked DataAuthorization set as refs (the
 * producer expands the inheritance closure at write time); `grantee` is the
 * routing key that survives deletion of the referenced resources, so a
 * retry/sweep can still resolve the consumer after the DAs are gone.
 */
export type AuthorizationRevoked = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AuthorizationRevoked']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the DataAuthorizations — refs (selected + expanded descendants) */
  object: DataAuthorizationRef[]
  /** the revoked authorization's grantee (agent, application, or role) */
  grantee: string
}

/**
 * Role membership changed — activity-first step 2 (the updateRole move).
 * `target` dropped (the InvitationCreated precedent): the changed role's id
 * rides `object.id`. The object is a real-id embedded projection of the
 * role-to-be (the full `RoleData` — the workflow loads the before-image,
 * PATCHes the role to this state and derives the affected diff from it; the
 * A-carrier member set is retired).
 */
export type RoleMembershipChanged = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'RoleMembershipChanged', 'as:Update']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the role-to-be — real-id embedded projection `{ id, type, label,
   *  members }` (the role exists at write; never dereferenced after) */
  object: RoleData
}

/** Typed activity ref for the `updateRole` workflow's completion — the XId
 * pattern for temporal inputs (refs stay TS-level, never on the wire; the
 * completed activity's type is still read from the resource). */
export type RoleMembershipChangedId = {
  id: string
  type: RoleMembershipChanged['type']
}

/** Role created (activity-first step 9). `target` dropped: the created
 * role's id rides `object.id`. The object is a real-id embedded projection
 * of the role-to-be at the PRE-MINTED id — the `createRole` workflow PUTs
 * the resource there (the `createInvitation` pattern) and completes; no
 * derived work (no authorizations can exist before the role exists). */
export type RoleCreated = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'RoleCreated', 'as:Add']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the role-to-be — real-id embedded projection at the pre-minted id
   *  (never dereferenced — the workflow materializes it) */
  object: RoleData
}

/** Typed activity ref for the `createRole` workflow's completion — the XId
 * pattern for temporal inputs (refs stay TS-level, never on the wire). */
export type RoleCreatedId = {
  id: string
  type: RoleCreated['type']
}

/** Role deleted (activity-first step 3). `target` dropped — the deleted
 * role's id rides `object.id`; the object is a real-id embedded projection
 * of the role-to-be-deleted (the full `RoleData`, alive at write) — the
 * write-time snapshot is the retry backstop: after a crash between the
 * DELETE and the completion, the role is gone and the member set would
 * otherwise be unrecoverable (the role-grantee authorizations are deleted
 * too), so the affected-set derivation uses the embedded members. */
export type RoleDeleted = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'RoleDeleted']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the role-to-be-deleted — real-id embedded projection `{ id, type,
   *  label, members }` (never dereferenced — the role disappears) */
  object: RoleData
}

/** Typed activity ref for the `deleteRole` workflow's completion — the XId
 * pattern for temporal inputs (refs stay TS-level, never on the wire). */
export type RoleDeletedId = {
  id: string
  type: RoleDeleted['type']
}

/** Peer mirror grants updated (reciprocal webhook). */
export type DelegatedGrantsUpdated = ActivityBase & {
  type: ['Activity', 'DelegatedGrantsUpdated']
  /** as:actor — plain IRI (the registry owner) */
  actor: string
  /** the peer */
  target: string
  /** the reciprocal registration — live link */
  object: string
}

/** Completion marker — no own fields; `target` is the completed activity IRI. */
export type ActivityCompleted = ActivityBase & {
  type: ['Activity', 'ActivityCompleted']
}

/**
 * The typed activity discriminant union — one member per activity RDF class.
 * Adding a class (the compile-time rule): extend this union, add the vocab
 * term + context entry; the handler, `reconcileActivities` and `events.ts`
 * each add their row to stay exhaustive.
 */
export type ActivityData =
  | InvitationAccepted
  | InvitationCreated
  | AgentRegistrationAdded
  | AccessRequestGranted
  | AccessRequestArchived
  | NeedBasedAccessRequestReceived
  | NeedBasedAccessRequestSent
  | AdminAuthorizationGranted
  | AdminAuthorizationRevoked
  | AuthorizationGranted
  | AuthorizationDenied
  | AuthorizationRevoked
  | RoleMembershipChanged
  | RoleDeleted
  | RoleCreated
  | DelegatedGrantsUpdated
  | ActivityCompleted

/**
 * Whether the activity's `type` tuple contains the given class term
 * (`type[1]` — e.g. `'InvitationAccepted'`, or `'ActivityCompleted'`).
 * The typed union's per-member tuple literals make a bare `.includes` call
 * awkward to type, so the discriminant check lives here.
 */
export function isActivityClass(activity: ActivityData, cls: string): boolean {
  return (activity.type as readonly string[]).includes(cls)
}
