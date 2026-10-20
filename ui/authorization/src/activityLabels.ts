/**
 * Activity class → fluent message key — the label map for the activity
 * indicator (see the OpenWiki `ui/authorization-ui.md`). One row per class the UI
 * claims: each step that adds an activity-first RPC adds its row here (the
 * "add their row to stay exhaustive" rule, like events.ts dispatch rows).
 * Fallback is the class name itself, so a missing row is visible in dev.
 */
export const ACTIVITY_LABELS: Record<string, string> = {
  InvitationCreated: 'create-invitation',
  InvitationAccepted: 'accept-invitation',
  RoleMembershipChanged: 'update-role',
  RoleDeleted: 'delete-role',
  RoleCreated: 'create-role',
  AuthorizationGranted: 'authorize-app',
  AuthorizationDenied: 'authorize-app-denied',
  AdminAuthorizationGranted: 'add-admin',
  NeedBasedAccessRequestSent: 'request-access-sent',
  NeedBasedAccessRequestReceived: 'request-access-received',
  AccessRequestGranted: 'access-request-granted',
  AccessRequestArchived: 'access-request-archived',
}
