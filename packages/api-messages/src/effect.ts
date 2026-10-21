import { Rpc, RpcRouter } from '@effect/rpc'
import { Context, Effect, pipe } from 'effect'
import * as S from 'effect/Schema'
import type { PushSubscription } from 'web-push'

export const IRI = pipe(S.String, S.brand('IRI'))
export type IRI = S.Schema.Type<typeof IRI>

// Node 26 runs TypeScript in strip-only mode, which does not support `enum`.
// A frozen const object + a derived union type keeps the same value/type API.
export const Scopes = {
  Inherited: 'Inherited',
  All: 'All',
  AllFromAgent: 'AllFromAgent',
  AllFromRole: 'AllFromRole',
  AllFromRegistry: 'AllFromRegistry',
  SelectedFromRegistry: 'SelectedFromRegistry',
} as const

export type Scopes = (typeof Scopes)[keyof typeof Scopes]

export const AccessModes = {
  Read: 'http://www.w3.org/ns/auth/acl#Read',
  Update: 'http://www.w3.org/ns/auth/acl#Update',
  Create: 'http://www.w3.org/ns/auth/acl#Create',
  Delete: 'http://www.w3.org/ns/auth/acl#Delete',
} as const

export const WebPushSubscription = S.Struct({
  endpoint: S.String,
  keys: S.Struct({
    p256dh: S.String,
    auth: S.String,
  }),
})

export const Application = S.Struct({
  id: IRI,
  name: S.String,
  logo: S.optional(S.String),
  callbackEndpoint: S.optional(S.String),
  //authorizationDate: S.String, // interop:registeredAt
  //lastUpdateDate: S.optional(S.String), // interop:updatedAt
  accessNeedGroup: S.String, // interop:hasAccessNeedGroup
})

export const ApplicationList = S.Array(Application)

export const UnregisteredApplication = S.Struct({
  id: IRI,
  name: S.String,
  logo: S.optional(S.String),
  accessNeedGroup: S.String, // interop:hasAccessNeedGroup
})

const accessNeedFields = {
  id: IRI,
  label: S.String,
  description: S.optional(S.String),
  required: S.optional(S.Boolean),
  // IRIs for the access modes
  access: S.Array(IRI),
  shapeTree: S.Struct({
    id: IRI,
    label: S.String,
  }),
  parent: S.optional(IRI),
}

interface AccessNeed extends S.Struct.Type<typeof accessNeedFields> {
  readonly children?: ReadonlyArray<AccessNeed>
}

interface AccessNeedEncoded extends S.Struct.Encoded<typeof accessNeedFields> {
  readonly children?: ReadonlyArray<AccessNeedEncoded>
}

export const AccessNeed = S.Struct({
  ...accessNeedFields,
  children: S.optional(
    S.Array(S.suspend((): S.Schema<AccessNeed, AccessNeedEncoded> => AccessNeed))
  ),
})

export const AccessNeedGroup = S.Struct({
  id: IRI,
  label: S.String,
  description: S.optional(S.String),
  required: S.optional(S.Boolean),
  needs: S.Array(AccessNeed),
  descriptionLanguages: S.Array(S.String),
  lang: S.String,
})

export const DataRegistration = S.Struct({
  id: IRI,
  shapeTree: S.String,
  // TODO dataOwner: IRI,
  dataRegistry: S.optional(S.String),
  count: S.optional(S.Number),
  label: S.optional(S.String), // TODO label should be ensured
})

export const DataOwner = S.Struct({
  id: IRI,
  label: S.String,
  dataRegistrations: S.Array(DataRegistration),
})

export const AuthorizationData = S.Struct({
  id: IRI, // TODO change to agentId
  accessNeedGroup: AccessNeedGroup,
  dataOwners: S.Array(DataOwner),
})

export const ShapeTree = S.Struct({
  id: IRI,
  label: S.String,
})

export const ChildInfo = S.Struct({
  count: S.Int,
  shapeTree: ShapeTree,
})

export const Resource = S.Struct({
  id: IRI,
  label: S.optional(S.String),
  shapeTree: ShapeTree,
  children: S.Array(ChildInfo),
  accessGrantedTo: S.Array(IRI),
})

export const SocialAgent = S.Struct({
  id: IRI,
  label: S.String,
  note: S.optional(S.String),
  /**
   * INCOMING — OPEN need-based access requests sent by this agent (owner
   * side): the AccessRequest IRIs (approval entries — each opens the
   * authorization screen with `accessRequestIri`, §6.8). Empty when nothing
   * is pending — granted/denied dropped the entries (see the OpenWiki
   * `services/activity-lifecycle.md`).
   */
  accessRequestsReceived: S.Array(IRI),
  /**
   * OUTGOING — OPEN need-based access requests sent TO this agent (requester
   * side): the request SNAPSHOT ids (urn:uuid — the archive targets). Empty
   * when nothing is pending — granted/archived dropped the entries.
   */
  accessRequestsSent: S.Array(IRI),
  accessGrant: S.optional(S.String),
  /**
   * True when the agent is an admin of the *current context's* registry set
   * — the DIRECT admin marker (non-empty `hasAdminGrant`) on the context
   * owner's registration of the agent: the org's registration of the agent in
   * an org context, the signed-in user's own registration of the agent in the
   * personal context (Phase 5 of org-admin-feature.md — a regular user
   * promotes/demotes their own admins). Drives the toggle-admin button.
   */
  admin: S.Boolean,
  /**
   * True when the signed-in user is an admin of THIS agent's registry set —
   * the RECIPROCAL admin marker: the agent's registration of the user
   * (reached via `reciprocalRegistration`) carries a non-empty
   * `hasAdminGrant`. Only meaningful in the personal context — the context
   * switcher source (the orgs the user administers, §2.2 of
   * org-admin-feature.md).
   */
  adminOf: S.Boolean,
  //authorizationDate: S.String, // interop:registeredAt TODO: rename to not imply access
  //lastUpdateDate: S.optional(S.String), // interop:updatedAt
})

export const SocialAgentList = S.Array(SocialAgent)

export const Role = S.Struct({
  id: IRI,
  label: S.String,
  members: S.Array(IRI),
})

export const RoleList = S.Array(Role)

export const SocialAgentInvitation = S.Struct({
  id: IRI,
  label: S.String,
  note: S.optional(S.String),
  capabilityUrl: S.String,
})

export const SocialAgentInvitationList = S.Array(SocialAgentInvitation)

/**
 * Pending acknowledgment of an accepted invitation — the acceptance itself
 * completes asynchronously via the acceptor's `invitationAccepted` workflow.
 * `Message` suffix per the RPC naming rule (see the OpenWiki
 * `services/rpc-and-services.md`):
 * the name `InvitationAccepted` is the activity class Schema below.
 */
export const InvitationAcceptedMessage = S.Struct({
  accepted: S.Boolean,
  /** the triggering activity's IRI — the uniform UI claim anchor: the
   *  producer mints the activity at write time, so the ack can echo it even
   *  though the object is a urn:uuid snapshot (no UI-known id rides the
   *  activity). `bindClaim` matches the stream event by id exactly. */
  activityId: IRI,
})

/**
 * Pending acknowledgment of an invitation creation (activity-first step 1) —
 * the RPC only writes the `invitationCreated` activity; the `createInvitation`
 * workflow PUTs the invitation resource at the echoed `id` and generates the
 * `capabilityUrl` there, so the ack deliberately carries neither. Echoed
 * `label`/`note` + the pre-minted id give the UI a pending handle for the
 * step-0 indicator; the capabilityUrl is learned from the invitation resource
 * after completion (never from an RPC or activity). `activityId` is the
 * triggering activity's IRI — the uniform UI claim anchor (the producer
 * mints the activity at write time; the stream event carries the same id).
 */
/**
 * Pending acknowledgment of a need-based access request (activity-first,
 * authorization-granting.md §6.4) — the RPC writes the
 * `NeedBasedAccessRequestSent` activity and echoes its IRI (the uniform UI
 * claim anchor). No minted resource id: the requester mints NO real id (the
 * data owner mints it owner-side, next phase) — the
 * `InvitationAcceptedMessage` shape.
 */
export const NeedBasedAccessRequestSentMessage = S.Struct({
  accepted: S.Boolean,
  /** the triggering `needBasedAccessRequestSent` activity's IRI */
  activityId: IRI,
})

/**
 * The archive acknowledgement (see the OpenWiki `services/activity-lifecycle.md`) — the RPC
 * writes the `AccessRequestArchived` activity (TERMINAL resolution — no
 * workflow, no `ActivityCompleted`) and echoes its IRI. `archived: false`
 * means the request was NOT open (unknown snapshot or already resolved —
 * the granted ∧ archived race no-op): the UI refreshes either way.
 */
export const AccessRequestArchivedMessage = S.Struct({
  /** whether the archive wrote a resolution (false = no-op) */
  archived: S.Boolean,
  /** the triggering `accessRequestArchived` activity's IRI (absent on no-op) */
  activityId: S.optional(IRI),
})

export const InvitationCreatedMessage = S.Struct({
  accepted: S.Boolean,
  /** the pre-minted invitation IRI the workflow will PUT at */
  id: IRI,
  /** the triggering `invitationCreated` activity's IRI */
  activityId: IRI,
  label: S.String,
  note: S.optional(S.String),
})

/**
 * Pending acknowledgment of a role update (activity-first step 2) — the RPC
 * only writes the `roleMembershipChanged` activity (object = the role-to-be,
 * real-id embedded projection); the `updateRole` workflow PATCHes the role to
 * that state and regenerates grants. The ack echoes the role-to-be (pending
 * handle) + the triggering activity id (the uniform UI claim anchor).
 */
export const RoleMembershipChangedMessage = S.Struct({
  /** the role-to-be — the workflow PATCHes the role to this state */
  id: IRI,
  label: S.String,
  members: S.Array(IRI),
  /** the triggering `roleMembershipChanged` activity's IRI */
  activityId: IRI,
})

/**
 * Pending acknowledgment of a role deletion (activity-first step 3) — the
 * RPC only writes the `roleDeleted` activity (object = the role-to-be-deleted,
 * real-id embedded projection); the `deleteRole` workflow DELETEs the role
 * and regenerates grants. The ack echoes the deleted role id (pending
 * handle) + the triggering activity id (the uniform UI claim anchor).
 */
export const RoleDeletedMessage = S.Struct({
  /** the role-to-be-deleted — the workflow DELETEs it */
  id: IRI,
  /** the triggering `roleDeleted` activity's IRI */
  activityId: IRI,
})

/**
 * Pending acknowledgment of a role creation (activity-first step 9) — the
 * RPC mints the role id and writes the `roleCreated` activity (object = the
 * role-to-be, real-id embedded projection); the `createRole` workflow PUTs
 * the role at the minted id and completes. The ack echoes the role-to-be
 * (pending handle) + the triggering activity id (the uniform UI claim
 * anchor).
 */
export const RoleCreatedMessage = S.Struct({
  /** the role-to-be — the workflow PUTs the role to this state */
  id: IRI,
  label: S.String,
  members: S.Array(IRI),
  /** the triggering `roleCreated` activity's IRI */
  activityId: IRI,
})

/**
 * Pending acknowledgment of an admin promotion (activity-first step 5 — R1
 * re-decision: validation reads stay in the RPC, the write moves to the
 * workflow) — the RPC pre-mints the AdminAuthorization id and writes the
 * `adminAuthorizationGranted` activity (object = the AdminAuthorization-to-be,
 * real-id embedded projection at that id); the `addAdmin` workflow PUTs the
 * resource there, then grants + ACR rewrite, then completes. The ack echoes
 * the pre-minted id (pending handle) + the triggering activity id (the
 * uniform UI claim anchor).
 */
export const AdminAuthorizationGrantedMessage = S.Struct({
  /** the pre-minted AdminAuthorization IRI the workflow will PUT at */
  id: IRI,
  /** the triggering `adminAuthorizationGranted` activity's IRI */
  activityId: IRI,
})

/**
 * Pending acknowledgment of an admin demotion (activity-first step 6 — the
 * R1 re-decision's remove half: validation reads + the last-admin guard stay
 * in the RPC, the DELETE moves to the workflow) — the RPC writes the
 * `adminAuthorizationRevoked` activity (object = the existing
 * AdminAuthorization as a real-id embedded projection at its id); the
 * `removeAdmin` workflow DELETEs the resource there, revokes grants + the
 * ACR rewrite (re-guarding the last admin), then completes. The ack echoes
 * the revoked id (pending handle) + the triggering activity id (the uniform
 * UI claim anchor).
 */
export const AdminAuthorizationRevokedMessage = S.Struct({
  /** the revoked AdminAuthorization IRI the workflow DELETEs */
  id: IRI,
  /** the triggering `adminAuthorizationRevoked` activity's IRI */
  activityId: IRI,
})

// ──────────────────────────
// Activity projections (the outbox) — the wire contract in the OpenWiki
// `services/activity-lifecycle.md` (amended wire). Same field sets as the data-model ActivityData union
// (wire truth), UNBRANDED: every IRI field is plain S.String — no refs on
// the wire, so no ActorRef (refs stay data-model XId types for temporal
// inputs). The `as:object` forms: live-link objects are plain S.String,
// sets are S.Array(S.String), snapshots embed their POJO projection.
// ──────────────────────────

const activityBaseFields = {
  id: S.String,
  /** plain IRI — the changed record/container, or the completed activity IRI */
  target: S.String,
  createdAt: S.String,
}

/** Unbranded projection of data-model `EmbeddedSocialAgentInvitation` —
 * the `InvitationAccepted` object (urn:uuid snapshot, never dereferenced). */
export const EmbeddedSocialAgentInvitation = S.Struct({
  id: S.String,
  type: S.Array(S.String),
  capabilityUrl: S.String,
  /** language map — the snapshot carries `label` per `SocialAgentInvitationData` */
  label: S.Record({ key: S.String, value: S.String }),
  note: S.optional(S.String),
})

/** Unbranded projection of data-model `EmbeddedSocialAgentRegistration` —
 * the `AgentRegistrationAdded` object (urn:uuid snapshot). */
export const EmbeddedSocialAgentRegistration = S.Struct({
  id: S.String,
  type: S.Array(S.String),
  registeredAgent: S.String,
  /** language map — the snapshot carries `label` per `SocialAgentRegistrationData` */
  label: S.Record({ key: S.String, value: S.String }),
  note: S.optional(S.String),
})

/** Unbranded projection of data-model `EmbeddedNeedBasedAccessRequest` —
 * the `NeedBasedAccessRequestSent` object (urn:uuid snapshot; the embedded
 * access need group passes through loosely — payload values are
 * (expanded-form) IRIs). */
export const EmbeddedNeedBasedAccessRequest = S.Struct({
  id: S.String,
  type: S.Array(S.String),
  grantee: S.String,
  grantedBy: S.String,
  dataOwner: S.String,
  hasAccessNeedGroup: S.Unknown,
})

/** Access request sent via RPC (activity-first — the requesting-authorization
 * leg, authorization-granting.md §6.4). `target` dropped: the request
 * snapshot (urn:uuid id — the requester has no AccessRequestRegistry) rides
 * `object`; the requester-side workflow forwards it to the owner's (reused)
 * issuance endpoint. */
export const NeedBasedAccessRequestSent = S.Struct({
  id: S.String,
  /** no `target` — the request snapshot (urn:uuid id) rides `object` */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('NeedBasedAccessRequestSent')),
  /** as:actor — plain IRI (the registry owner — the requester) */
  actor: S.String,
  /** the request snapshot — urn:uuid id + the embedded access need group */
  object: EmbeddedNeedBasedAccessRequest,
})

/** Access request received by the data owner's endpoint (the minted half,
 * authorization-granting.md §6.2) — `target` = the AccessRequest registry;
 * the object is the request-to-be as a real-id embedded projection at the
 * PRE-MINTED id (the owner-side workflow PUTs the AccessRequest resource
 * there). */
export const NeedBasedAccessRequestReceived = S.Struct({
  id: S.String,
  /** as:target — the AccessRequest registry (the changed container) */
  target: S.String,
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('NeedBasedAccessRequestReceived')),
  /** as:actor — plain IRI (the registry owner — the data owner) */
  actor: S.String,
  /** the request-to-be — real-id embedded projection at the minted id */
  object: EmbeddedNeedBasedAccessRequest,
})

/** Acceptance of a social agent invitation (acceptor's Activity Registry). */
export const InvitationAccepted = S.Struct({
  id: S.String,
  /** no `target` — the object is a self-contained urn:uuid snapshot (the
   *  acceptor has no owning container to mint a real id in) */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('InvitationAccepted'), S.Literal('as:Accept')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** urn:uuid snapshot of the invitation (opaque capabilityUrl inside) */
  object: EmbeddedSocialAgentInvitation,
})

/** Invitation created via RPC (activity-first step 1). */
export const InvitationCreated = S.Struct({
  id: S.String,
  /** no `target` — the changed record's id rides `object.id` (the embedded
   *  invitation-to-be); the changed container is not consumed */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('InvitationCreated'), S.Literal('as:Create')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the invitation-to-be — `CreateInvitationPojo` projection (id + type +
   *  label/note; no capabilityUrl — generated by the workflow later) */
  object: S.Struct({
    id: S.String,
    type: S.Array(S.String),
    /** language map — `label` per `SocialAgentInvitationData` */
    label: S.Record({ key: S.String, value: S.String }),
    note: S.optional(S.String),
  }),
})

/** Reciprocal social agent registration written by the invitation handler. */
export const AgentRegistrationAdded = S.Struct({
  id: S.String,
  /** no `target` — the changed record's id rides `object.id` (the real-id
   *  embedded registration-to-be) */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('AgentRegistrationAdded'), S.Literal('as:Add')),
  /** as:actor — plain IRI (the session that wrote the registration) */
  actor: S.String,
  /** real-id embedded projection of the registration-to-be (`registeredAgent`
   *  — the peer; the `establishReciprocal` workflow PUTs it at `object.id`) */
  object: EmbeddedSocialAgentRegistration,
})

/** Unbranded projection of data-model `EmbeddedAdminAuthorization` — the
 * shared wire shape: the recorded object (real-id embedded projection at the
 * pre-minted id, step 5) and the revoked object (urn:uuid snapshot — the
 * RPC deletes the resource synchronously until step 6). */
export const EmbeddedAdminAuthorization = S.Struct({
  id: S.String,
  type: S.Array(S.String),
  grantee: S.String,
  grantedBy: S.String,
  scopeOfAuthorization: S.String,
})

/** Admin authorization recorded (org context, activity-first step 5) —
 * `target` dropped; the AdminAuthorization-to-be rides `object` as a real-id
 * embedded projection at the pre-minted id. */
export const AdminAuthorizationGranted = S.Struct({
  id: S.String,
  /** no `target` — the changed record's id rides `object.id` (the embedded
   *  AdminAuthorization-to-be); the changed container is not consumed */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('AdminAuthorizationGranted')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the AdminAuthorization-to-be — real-id embedded projection */
  object: EmbeddedAdminAuthorization,
})

/** Admin authorization revoked (org context, activity-first step 6) —
 * `target` dropped; the existing AdminAuthorization rides `object` as a
 * real-id embedded projection at its real id (the workflow DELETEs it). */
export const AdminAuthorizationRevoked = S.Struct({
  id: S.String,
  /** no `target` — the revoked record's id rides `object.id` (the embedded
   *  AdminAuthorization); the changed container is not consumed */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('AdminAuthorizationRevoked')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the AdminAuthorization — real-id embedded projection at the existing id */
  object: EmbeddedAdminAuthorization,
})

/** Unbranded projection of data-model `EmbeddedAuthorization` — the denied
 * `AuthorizationGranted` object (urn:uuid snapshot of the request structure;
 * a denied authorization creates no DataAuthorization, so `grantee` rides
 * here; moves to `AuthorizationDenied` at Step 4). */
export const EmbeddedAuthorization = S.Struct({
  id: S.String,
  type: S.Array(S.String),
  grantee: S.String,
  hasAccessNeedGroup: S.optional(S.String),
})

/** Unbranded projection of data-model `DataAuthorizationData` — the granted
 * `AuthorizationGranted` object (term-covered fields only: the real-id
 * embedded DataAuthorization(s)-to-be at the pre-minted ids). */
export const EmbeddedDataAuthorization = S.Struct({
  id: S.String,
  type: S.Array(S.String),
  grantee: S.String,
  grantedBy: S.String,
  registeredShapeTree: S.String,
  scopeOfAuthorization: S.String,
  dataOwner: S.optional(S.String),
  hasDataRegistration: S.optional(S.String),
  satisfiesAccessNeed: S.optional(S.String),
  inheritsFromAuthorization: S.optional(S.String),
  accessMode: S.Array(S.String),
  creatorAccessMode: S.optional(S.Array(S.String)),
  hasDataInstance: S.optional(S.Array(S.String)),
  hasInheritingAuthorization: S.optional(S.Array(S.String)),
})

/** Authorization granted — the granting class (authorization-granting.md
 * Step 2/§5.1): object = the DataAuthorizations-to-be (real-id embedded
 * POJOs, ALL grantees in one activity; a decline/no-grant is
 * `AuthorizationDenied`, Step 4). */
export const AuthorizationGranted = S.Struct({
  ...activityBaseFields,
  type: S.Tuple(S.Literal('Activity'), S.Literal('AuthorizationGranted')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the DataAuthorizations-to-be (embedded) */
  object: S.Array(EmbeddedDataAuthorization),
})

/** Pending acknowledgment of an approved authorization (activity-first step
 * 2) — the RPC pre-mints the DataAuthorization id(s) and writes the
 * activity; the `processAuthorizationGranted` workflow materializes them at
 * those ids. Echoes the pre-minted ids (pending handles) + the triggering
 * activity id (the uniform UI claim anchor). */
export const AuthorizationGrantedMessage = S.Struct({
  /** the pre-minted DataAuthorization IRIs the workflow will PUT at */
  ids: S.Array(IRI),
  /** the triggering `AuthorizationGranted` activity's IRI */
  activityId: IRI,
})

/** Authorization revoked — `object` = the DataAuthorization refs (selected +
 * expanded descendants); `grantee` is the routing key that survives deletion. */
export const DataAuthorizationRef = S.Struct({
  id: S.String,
  type: S.Array(S.String),
})

export const AuthorizationRevoked = S.Struct({
  id: S.String,
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('AuthorizationRevoked')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the DataAuthorizations — refs (selected + expanded descendants) */
  object: S.Array(DataAuthorizationRef),
  /** the revoked authorization's grantee (agent, application, or role) */
  grantee: S.String,
})

/** Pending acknowledgment of an authorization revocation (C2): the RPC wrote
 * the `AuthorizationRevoked` activity and echoes its IRI (the uniform UI claim
 * anchor) plus the expanded closure it captured at write time. */
export const AuthorizationRevokedMessage = S.Struct({
  /** absent when every selected authorization was already removed (no-op) */
  activityId: S.optional(IRI),
  authorizations: S.Array(IRI),
})

/** Authorization denied (decline — silent, forward-only;
 * authorization-granting.md Step 4). `target` dropped. */
export const AuthorizationDenied = S.Struct({
  id: S.String,
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('AuthorizationDenied')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the request-structure snapshot (urn:uuid) carrying `grantee` */
  object: EmbeddedAuthorization,
})

/** Role membership changed (activity-first step 2) — `target` dropped; the
 * role-to-be rides `object` as a real-id embedded projection (the workflow
 * PATCHes the role to it and derives the affected diff). */
export const RoleMembershipChanged = S.Struct({
  id: S.String,
  /** no `target` — the changed role's id rides `object.id` (the embedded
   *  role-to-be); the changed container is not consumed */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('RoleMembershipChanged'), S.Literal('as:Update')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the role-to-be — real-id embedded projection of the `RoleData` */
  object: S.Struct({
    id: S.String,
    type: S.Array(S.String),
    /** language map — the embedded role-to-be carries `label` per `RoleData` */
    label: S.Record({ key: S.String, value: S.String }),
    members: S.Array(S.String),
  }),
})

/** Role created (activity-first step 9) — `target` dropped; the
 * role-to-be rides `object` as a real-id embedded projection at the
 * PRE-MINTED id. */
export const RoleCreated = S.Struct({
  id: S.String,
  /** no `target` — the created role's id rides `object.id` (the embedded
   *  role-to-be); the changed container is not consumed */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('RoleCreated'), S.Literal('as:Add')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the role-to-be — real-id embedded projection of the `RoleData` */
  object: S.Struct({
    id: S.String,
    type: S.Array(S.String),
    /** language map — the embedded role-to-be carries `label` per `RoleData` */
    label: S.Record({ key: S.String, value: S.String }),
    members: S.Array(S.String),
  }),
})

/** Role deleted (activity-first step 3) — `target` dropped; the
 * role-to-be-deleted rides `object` as a real-id embedded projection. */
export const RoleDeleted = S.Struct({
  id: S.String,
  /** no `target` — the deleted role's id rides `object.id` (the embedded
   *  role-to-be-deleted); the changed container is not consumed */
  createdAt: S.String,
  type: S.Tuple(S.Literal('Activity'), S.Literal('RoleDeleted')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the role-to-be-deleted — real-id embedded projection of the `RoleData` */
  object: S.Struct({
    id: S.String,
    type: S.Array(S.String),
    /** language map — the embedded role-to-be carries `label` per `RoleData` */
    label: S.Record({ key: S.String, value: S.String }),
    members: S.Array(S.String),
  }),
})

/** Peer mirror grants updated (reciprocal webhook). */
export const DelegatedGrantsUpdated = S.Struct({
  ...activityBaseFields,
  type: S.Tuple(S.Literal('Activity'), S.Literal('DelegatedGrantsUpdated')),
  /** as:actor — plain IRI (the registry owner) */
  actor: S.String,
  /** the peer */
  target: S.String,
  /** the reciprocal registration — live link */
  object: S.String,
})

/** Completion marker — no own fields; `target` is the completed activity IRI. */
export const ActivityCompleted = S.Struct({
  ...activityBaseFields,
  type: S.Tuple(S.Literal('Activity'), S.Literal('ActivityCompleted')),
})

export const DataRegistry = S.Struct({
  id: IRI,
  label: S.String,
  registrations: S.Array(DataRegistration),
})

export const DataRegistryList = S.Array(DataRegistry)

export const DataInstance = S.Struct({
  id: IRI,
  label: S.String,
})

export const DataInstanceList = S.Array(DataInstance)

export const ShareAuthorization = S.Struct({
  applicationId: IRI,
  resource: IRI,
  agents: S.Array(IRI),
  accessMode: S.Array(IRI),
  children: S.Array(
    S.Struct({
      shapeTree: IRI,
      accessMode: S.Array(IRI),
    })
  ),
})

export const ShareAuthorizationConfirmation = S.Struct({
  callbackEndpoint: S.String,
})

export const BaseAuthorization = S.Struct({
  grantee: IRI,
  accessNeedGroup: IRI,
})

export const DataAuthorization = S.Struct({
  accessNeed: IRI,
  scope: S.Enums(Scopes),
  dataOwner: S.optional(IRI),
  dataRegistration: S.optional(IRI),
  dataInstances: S.optional(S.Array(IRI)),
})

export const GrantedAuthorization = S.Struct({
  ...BaseAuthorization.fields,
  dataAuthorizations: S.Array(DataAuthorization),
  granted: S.Literal(true),
})

export const DeniedAuthorization = S.Struct({
  ...BaseAuthorization.fields,
  granted: S.Literal(false),
})

export const Authorization = S.Union(GrantedAuthorization, DeniedAuthorization)

/** A data authorization as recorded by the authorization agent (API response). */
export const RecordedDataAuthorization = S.Struct({
  id: IRI,
  grantee: IRI,
  grantedBy: IRI,
  registeredShapeTree: IRI,
  scopeOfAuthorization: IRI,
  dataOwner: S.optional(IRI),
  hasDataRegistration: S.optional(IRI),
  satisfiesAccessNeed: S.optional(IRI),
  inheritsFromAuthorization: S.optional(IRI),
  accessMode: S.Array(IRI),
  creatorAccessMode: S.optional(S.Array(IRI)),
  hasDataInstance: S.optional(S.Array(IRI)),
  hasInheritingAuthorization: S.optional(S.Array(IRI)),
  /** resolved from the shape tree description in the requested language; falls
   *  back to the shape tree IRI when no description is available */
  shapeTreeLabel: S.String,
})

export const AccessAuthorization = S.Array(RecordedDataAuthorization)
/** The list shape returned by `ListAuthorizations` (same as `AccessAuthorization`). */
export const AuthorizationList = AccessAuthorization

export class GetWebId extends S.TaggedRequest<GetWebId>()('GetWebId', {
  failure: S.Never,
  success: S.String,
  payload: {},
}) {}

export class CheckHandle extends S.TaggedRequest<CheckHandle>()('CheckHandle', {
  failure: S.Never,
  success: S.Boolean,
  payload: { handle: S.String },
}) {}

export class BootstrapAccount extends S.TaggedRequest<BootstrapAccount>()('BootstrapAccount', {
  failure: S.Never,
  success: S.String,
  payload: { handle: S.String },
}) {}

export class RegisterPushSubscription extends S.TaggedRequest<RegisterPushSubscription>()(
  'RegisterPushSubscription',
  {
    failure: S.Never,
    success: S.Void,
    payload: {
      subscription: WebPushSubscription,
    },
  }
) {}

export class ListApplications extends S.TaggedRequest<ListApplications>()('ListApplications', {
  failure: S.Never,
  success: ApplicationList,
  payload: { context: IRI },
}) {}

export class GetUnregisteredApplication extends S.TaggedRequest<GetUnregisteredApplication>()(
  'GetUnregisteredApplication',
  {
    failure: S.Never,
    success: UnregisteredApplication,
    payload: { id: IRI },
  }
) {}

export class GetAuthoriaztionData extends S.TaggedRequest<GetAuthoriaztionData>()(
  'GetAuthoriaztionData',
  {
    failure: S.Never,
    success: AuthorizationData,
    payload: {
      agentId: IRI,
      lang: S.String,
      accessNeedGroupIri: S.optional(IRI),
      accessRequestIri: S.optional(IRI),
      context: IRI,
    },
  }
) {}

/**
 * The recorded authorizations for a grantee (peer, application, or role).
 * Read-only: grants are projections, authorizations are the source of truth;
 * revocation (C2) will target this list.
 */
export class ListAuthorizations extends S.TaggedRequest<ListAuthorizations>()(
  'ListAuthorizations',
  {
    failure: S.Never,
    success: AuthorizationList,
    payload: { grantee: IRI, lang: S.String, context: IRI },
  }
) {}

export class GetResource extends S.TaggedRequest<GetResource>()('GetResource', {
  failure: S.Never,
  success: Resource,
  payload: {
    id: IRI,
    lang: S.String, // TODO lang code validation
    context: IRI,
  },
}) {}

export class ListSocialAgents extends S.TaggedRequest<ListSocialAgents>()('ListSocialAgents', {
  failure: S.Never,
  success: SocialAgentList,
  payload: {
    /** preferred language — the agent label is picked from its language map */
    lang: S.String,
    context: IRI,
  },
}) {}

export class ListSocialAgentInvitations extends S.TaggedRequest<ListSocialAgentInvitations>()(
  'ListSocialAgentInvitations',
  {
    failure: S.Never,
    success: SocialAgentInvitationList,
    payload: {
      /** preferred language — the invitation label is picked from its language map */
      lang: S.String,
      context: IRI,
    },
  }
) {}

export class ListRoles extends S.TaggedRequest<ListRoles>()('ListRoles', {
  failure: S.Never,
  success: RoleList,
  payload: {
    /** preferred language — the role label is picked from its language map */
    lang: S.String,
    context: IRI,
  },
}) {}

export class CreateRole extends S.TaggedRequest<CreateRole>()('CreateRole', {
  failure: S.Never,
  success: RoleCreatedMessage,
  payload: {
    label: S.String,
    members: S.Array(IRI),
    context: IRI,
  },
}) {}

export class UpdateRole extends S.TaggedRequest<UpdateRole>()('UpdateRole', {
  failure: S.Never,
  success: RoleMembershipChangedMessage,
  payload: {
    id: IRI,
    label: S.String,
    members: S.Array(IRI),
    context: IRI,
  },
}) {}

export class DeleteRole extends S.TaggedRequest<DeleteRole>()('DeleteRole', {
  failure: S.Never,
  success: RoleDeletedMessage,
  payload: {
    id: IRI,
    context: IRI,
  },
}) {}

export class ListDataRegistries extends S.TaggedRequest<ListDataRegistries>()(
  'ListDataRegistries',
  {
    failure: S.Never,
    success: DataRegistryList,
    payload: {
      agentId: IRI,
      lang: S.String, // TODO lang code validation
      context: IRI,
    },
  }
) {}

export class ListDataInstances extends S.TaggedRequest<ListDataInstances>()('ListDataInstances', {
  failure: S.Never,
  success: DataInstanceList,
  payload: {
    agentId: IRI,
    registrationId: IRI,
    context: IRI,
  },
}) {}

export class RequestAccessUsingApplicationNeeds extends S.TaggedRequest<RequestAccessUsingApplicationNeeds>()(
  'RequestAccessUsingApplicationNeeds',
  {
    failure: S.Never,
    success: NeedBasedAccessRequestSentMessage,
    payload: {
      applicationId: IRI,
      /** the data owner — the service method extracts the access needs from
       *  `applicationId`'s client-id document (§6.4); kept for dev-env
       *  manual testing, the access-needs variant is the tested path */
      agentId: IRI,
      context: IRI,
    },
  }
) {}

export class RequestAccessUsingAccessNeeds extends S.TaggedRequest<RequestAccessUsingAccessNeeds>()(
  'RequestAccessUsingAccessNeeds',
  {
    failure: S.Never,
    success: NeedBasedAccessRequestSentMessage,
    payload: {
      /** the data owner (e.g. Alice) */
      dataOwner: IRI,
      /** the embedded access need group — (expanded-form) IRIs inside */
      hasAccessNeedGroup: S.Unknown,
      context: IRI,
    },
  }
) {}

export class ArchiveAccessRequest extends S.TaggedRequest<ArchiveAccessRequest>()(
  'ArchiveAccessRequest',
  {
    failure: S.Never,
    success: AccessRequestArchivedMessage,
    payload: {
      /** the open request's SNAPSHOT id (urn:uuid — the `accessRequestsSent` entry) */
      request: IRI,
      context: IRI,
    },
  }
) {}

export class CreateInvitation extends S.TaggedRequest<CreateInvitation>()('CreateInvitation', {
  failure: S.Never,
  success: InvitationCreatedMessage,
  payload: {
    /** preferred language — the created invitation's label is tagged with it */
    lang: S.String,
    label: S.String,
    note: S.optional(S.String),
    context: IRI,
  },
}) {}

export class AcceptInvitation extends S.TaggedRequest<AcceptInvitation>()('AcceptInvitation', {
  failure: S.Never,
  success: InvitationAcceptedMessage,
  payload: {
    /** preferred language — the accepted snapshot's label is tagged with it */
    lang: S.String,
    capabilityUrl: S.String,
    label: S.String,
    note: S.optional(S.String),
    context: IRI,
  },
}) {}

export class ShareResource extends S.TaggedRequest<ShareResource>()('ShareResource', {
  failure: S.Never,
  success: ShareAuthorizationConfirmation,
  payload: {
    authorization: ShareAuthorization,
    context: IRI,
  },
}) {}

export class AuthorizeApp extends S.TaggedRequest<AuthorizeApp>()('AuthorizeApp', {
  failure: S.Never,
  success: AuthorizationGrantedMessage,
  payload: {
    authorization: Authorization,
    /** the approval path (authorization-granting.md §6.8) — the record
     *  resolves the group from the EMBEDDED copy in the request */
    accessRequestIri: S.optional(IRI),
    context: IRI,
  },
}) {}

/** Machine-readable authorization-revocation refusals (C4): the producer's
 *  validation errors, no 500 defects. */
export const AuthorizationRevocationFailure = S.Union(
  S.Struct({ code: S.Literal('unauthorized'), authorizations: S.Array(IRI) }),
  S.Struct({ code: S.Literal('empty-selection') }),
  S.Struct({ code: S.Literal('not-a-data-authorization'), authorization: IRI }),
  S.Struct({ code: S.Literal('mixed-grantee'), authorizations: S.Array(IRI) })
)
export type AuthorizationRevocationFailure = S.Schema.Type<typeof AuthorizationRevocationFailure>

/**
 * Revoke authorizations (C2): the UI sends the selected DataAuthorization
 * IRIs; the service expands the inheritance closure and writes one
 * `AuthorizationRevoked` activity per grantee. The workflow deletes the DAs and
 * reconciles the grant projections. Grants are never targeted from the UI.
 */
export class RevokeAuthorizations extends S.TaggedRequest<RevokeAuthorizations>()(
  'RevokeAuthorizations',
  {
    failure: AuthorizationRevocationFailure,
    success: AuthorizationRevokedMessage,
    payload: {
      authorizations: S.Array(IRI),
      context: IRI,
    },
  }
) {}

export class AddAdmin extends S.TaggedRequest<AddAdmin>()('AddAdmin', {
  failure: S.Never,
  success: AdminAuthorizationGrantedMessage,
  payload: { webId: IRI, context: IRI },
}) {}

export class RemoveAdmin extends S.TaggedRequest<RemoveAdmin>()('RemoveAdmin', {
  failure: S.Never,
  success: AdminAuthorizationRevokedMessage,
  payload: { webId: IRI, context: IRI },
}) {}

export class SaiService extends Context.Tag('SaiService')<
  SaiService,
  {
    readonly getWebId: () => Effect.Effect<S.Schema.Type<typeof S.String>>
    readonly checkHandle: (handle: string) => Effect.Effect<S.Schema.Type<typeof S.Boolean>>
    readonly bootstrapAccount: (handle: string) => Effect.Effect<S.Schema.Type<typeof S.String>>
    readonly registerPushSubscription: (
      subscription: PushSubscription
    ) => Effect.Effect<S.Schema.Type<typeof S.Void>>
    readonly getApplications: (context: IRI) => Effect.Effect<S.Schema.Type<typeof ApplicationList>>
    readonly getUnregisteredApplication: (
      id: IRI
    ) => Effect.Effect<S.Schema.Type<typeof UnregisteredApplication>>
    readonly getAuthorizationData: (
      agentId: IRI,
      lang: string,
      accessNeedGroupIri: IRI | undefined,
      accessRequestIri: IRI | undefined,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof AuthorizationData>>
    readonly getAuthorizations: (
      grantee: IRI,
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof AuthorizationList>>
    readonly getResource: (
      id: IRI,
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof Resource>>
    readonly getSocialAgents: (
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof SocialAgentList>>
    readonly getRoles: (lang: string, context: IRI) => Effect.Effect<S.Schema.Type<typeof RoleList>>
    readonly createRole: (
      label: string,
      members: readonly S.Schema.Type<typeof IRI>[],
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof RoleCreatedMessage>>
    readonly updateRole: (
      id: IRI,
      label: string,
      members: readonly S.Schema.Type<typeof IRI>[],
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof RoleMembershipChangedMessage>>
    readonly deleteRole: (
      id: IRI,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof RoleDeletedMessage>>
    readonly getSocialAgentInvitations: (
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof SocialAgentInvitationList>>
    readonly getDataRegistries: (
      agentId: IRI,
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof DataRegistryList>>
    readonly listDataInstances: (
      agentId: IRI,
      registrationId: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof DataInstanceList>>
    readonly requestAccessUsingApplicationNeeds: (
      applicationId: string,
      agentId: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof NeedBasedAccessRequestSentMessage>>
    readonly requestAccessUsingAccessNeeds: (
      dataOwner: string,
      hasAccessNeedGroup: unknown,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof NeedBasedAccessRequestSentMessage>>
    readonly archiveAccessRequest: (
      request: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof AccessRequestArchivedMessage>>
    readonly createInvitation: (
      label: string,
      note: string | undefined,
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof InvitationCreatedMessage>>
    readonly acceptInvitation: (
      capabilityUrl: string,
      label: string,
      note: string | undefined,
      lang: string,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof InvitationAcceptedMessage>>
    readonly shareResource: (
      authorization: S.Schema.Type<typeof ShareAuthorization>,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof ShareAuthorizationConfirmation>>
    readonly authorizeApp: (
      authorization: S.Schema.Type<typeof Authorization>,
      accessRequestIri: IRI | undefined,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof AuthorizationGrantedMessage>>
    readonly revokeAuthorizations: (
      authorizations: readonly S.Schema.Type<typeof IRI>[],
      context: IRI
    ) => Effect.Effect<
      S.Schema.Type<typeof AuthorizationRevokedMessage>,
      AuthorizationRevocationFailure
    >
    readonly addAdmin: (
      webId: IRI,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof AdminAuthorizationGrantedMessage>>
    readonly removeAdmin: (
      webId: IRI,
      context: IRI
    ) => Effect.Effect<S.Schema.Type<typeof AdminAuthorizationRevokedMessage>>
  }
>() {}

export const router = RpcRouter.make(
  Rpc.effect(GetWebId, () =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getWebId()
    })
  ),
  Rpc.effect(CheckHandle, ({ handle }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.checkHandle(handle)
    })
  ),
  Rpc.effect(BootstrapAccount, ({ handle }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.bootstrapAccount(handle)
    })
  ),
  Rpc.effect(RegisterPushSubscription, ({ subscription }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.registerPushSubscription(subscription)
    })
  ),
  Rpc.effect(ListApplications, ({ context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getApplications(context)
    })
  ),
  Rpc.effect(GetUnregisteredApplication, ({ id }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getUnregisteredApplication(id)
    })
  ),
  Rpc.effect(
    GetAuthoriaztionData,
    ({ agentId, lang, accessNeedGroupIri, accessRequestIri, context }) =>
      Effect.gen(function* () {
        const saiService = yield* SaiService
        return yield* saiService.getAuthorizationData(
          agentId,
          lang,
          accessNeedGroupIri,
          accessRequestIri,
          context
        )
      })
  ),
  Rpc.effect(ListAuthorizations, ({ grantee, lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getAuthorizations(grantee, lang, context)
    })
  ),
  Rpc.effect(GetResource, ({ id, lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getResource(id, lang, context)
    })
  ),
  Rpc.effect(ListSocialAgents, ({ lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getSocialAgents(lang, context)
    })
  ),
  Rpc.effect(ListSocialAgentInvitations, ({ lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getSocialAgentInvitations(lang, context)
    })
  ),
  Rpc.effect(ListRoles, ({ lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getRoles(lang, context)
    })
  ),
  Rpc.effect(CreateRole, ({ label, members, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.createRole(label, members, context)
    })
  ),
  Rpc.effect(UpdateRole, ({ id, label, members, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.updateRole(id, label, members, context)
    })
  ),
  Rpc.effect(DeleteRole, ({ id, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.deleteRole(id, context)
    })
  ),
  Rpc.effect(ListDataRegistries, ({ agentId, lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.getDataRegistries(agentId, lang, context)
    })
  ),
  Rpc.effect(ListDataInstances, ({ agentId, registrationId, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.listDataInstances(agentId, registrationId, context)
    })
  ),
  Rpc.effect(RequestAccessUsingApplicationNeeds, ({ applicationId, agentId, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.requestAccessUsingApplicationNeeds(applicationId, agentId, context)
    })
  ),
  Rpc.effect(RequestAccessUsingAccessNeeds, ({ dataOwner, hasAccessNeedGroup, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.requestAccessUsingAccessNeeds(dataOwner, hasAccessNeedGroup, context)
    })
  ),
  Rpc.effect(ArchiveAccessRequest, ({ request, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.archiveAccessRequest(request, context)
    })
  ),
  Rpc.effect(CreateInvitation, ({ label, note, lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.createInvitation(label, note, lang, context)
    })
  ),
  Rpc.effect(AcceptInvitation, ({ capabilityUrl, label, note, lang, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.acceptInvitation(capabilityUrl, label, note, lang, context)
    })
  ),
  Rpc.effect(ShareResource, ({ authorization, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.shareResource(authorization, context)
    })
  ),
  Rpc.effect(AuthorizeApp, ({ authorization, accessRequestIri, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.authorizeApp(authorization, accessRequestIri, context)
    })
  ),
  Rpc.effect(RevokeAuthorizations, ({ authorizations, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.revokeAuthorizations(authorizations, context)
    })
  ),
  Rpc.effect(AddAdmin, ({ webId, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.addAdmin(webId, context)
    })
  ),
  Rpc.effect(RemoveAdmin, ({ webId, context }) =>
    Effect.gen(function* () {
      const saiService = yield* SaiService
      return yield* saiService.removeAdmin(webId, context)
    })
  )
)

export type UiRpcRouter = typeof router
