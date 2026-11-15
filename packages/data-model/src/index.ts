import type { ApplicationId } from './application-registration.ts'
import type { RoleId } from './role.ts'
import type { SocialAgentId } from './social-agent-registration.ts'

export * from './agent-registration.ts'
export type {
  ApplicationRegistrationData,
  ApplicationRegistrationId,
  ApplicationId,
} from './application-registration.ts'
export {
  type SocialAgentRegistrationData,
  type SocialAgentRegistrationId,
  type SocialAgentId,
  getAdminGrantIris,
} from './social-agent-registration.ts'
export type {
  SocialAgentInvitationData,
  SocialAgentInvitationId,
} from './social-agent-invitation.ts'
export * as SocialAgentInvitation from './social-agent-invitation.ts'
export type { RoleData, RoleId } from './role.ts'
export * as Role from './role.ts'
export * as SocialAgentRegistration from './social-agent-registration.ts'
// registries exported as namespaces to avoid colliding names
export type {
  SocialAgentRegistryData,
  ApplicationRegistryData,
  InvitationRegistryData,
} from './agent-registry.ts'
export type { RoleRegistryData } from './role-registry.ts'
export type { DataRegistryData } from './data-registry.ts'
export type { AuthorizationRegistryData } from './authorization-registry.ts'
export type { GrantRegistryData } from './grant-registry.ts'
export type { ActivityRegistryData } from './activity-registry.ts'
export * from './activities.ts'
export * from './authorization-structures.ts'
export * as RegistrySet from './registry-set.ts'
export type { RegistrySetData } from './registry-set.ts'
export * from './templates/index.ts'
export * from './acr.ts'
export type { DataInstanceData, ChildInfo } from './data-instance.ts'
export {
  childIris,
  frameDataInstance,
  frameDataInstanceFromDoc,
  isBlob,
  labelFromNode,
} from './data-instance.ts'
export { fromJsonLd as DataAuthorizationFromJsonLd } from './data-authorization.ts'
export type { AdminAuthorizationData } from './admin-authorization.ts'
export * as AdminAuthorization from './admin-authorization.ts'
export type { ShapeTreeData, ShapeTreeId, ShapeTreeReference } from './shape-tree.ts'
export * as ShapeTree from './shape-tree.ts'
export type { AccessNeedData, AccessNeedId } from './access-need.ts'
export * as AccessNeed from './access-need.ts'
export type { AccessNeedGroupData, AccessNeedGroupId } from './access-need-group.ts'
export * as AccessNeedGroup from './access-need-group.ts'
export { acrContext, dataModelContext, grantContext, lwsGrantContext } from './context.ts'
export type {
  GrantData,
  GrantId,
  FinalGrantData,
  GeneratedGrants,
  GrantTargetInput,
  GrantPermissionInput,
  OdrlPolicy,
  OdrlPermission,
  OdrlTarget,
} from './grant.ts'
export * as Grant from './grant.ts'
export {
  dataRegistryIri,
  grantAccess,
  grantAccessModes,
  grantDataOwner,
  grantGrantee,
  grantAssigner,
  grantStorage,
  grantTargets,
  toJsonLd,
} from './grant.ts'
export type { NeedBasedAccessRequestData, NeedBasedAccessRequestGroup } from './access-request.ts'
export * as AccessRequest from './access-request.ts'
export { fromJsonLd as AccessRequestFromJsonLd } from './access-request.ts'
export type { AccessRevocationMessage } from './access-revocation.ts'
export * as AccessRevocation from './access-revocation.ts'
export type {
  DataAuthorizationData,
  DataAuthorizationId,
  FinalDataAuthorizationData,
} from './data-authorization.ts'
export * as DataAuthorization from './data-authorization.ts'
export type { WebIdProfileData, WebIdProfileId } from './web-id-profile.ts'
export * as WebIdProfile from './web-id-profile.ts'
export type { ClientIdDocumentData, ClientIdDocumentId } from './client-id-document.ts'
export * as ClientIdDocument from './client-id-document.ts'
export type { ShapeTreeDescriptionData, ShapeTreeDescriptionId } from './shape-tree-description.ts'
export * as ShapeTreeDescription from './shape-tree-description.ts'
export type { AccessDescriptionData, AccessDescriptionId } from './access-description.ts'
export type {
  AccessNeedDescriptionData,
  AccessNeedDescriptionId,
} from './access-need-description.ts'
export * as AccessNeedDescription from './access-need-description.ts'
export type {
  AccessNeedGroupDescriptionData,
  AccessNeedGroupDescriptionId,
} from './access-need-group-description.ts'
export * as AccessNeedGroupDescription from './access-need-group-description.ts'
export type { DataRegistrationData, DataRegistrationId } from './data-registration.ts'
export * as DataRegistration from './data-registration.ts'
export * as ApplicationRegistration from './application-registration.ts'
export type { DataOwnerData } from './data-owner.ts'

// ──────────────────────────
// Boundary-facing identities
// ──────────────────────────

/** An agent identity: a social agent or an application. */
export type AgentId = SocialAgentId | ApplicationId

/** An agent or role identity (workflow boundaries route on `type`). */
export type AgentOrRoleId = AgentId | RoleId
