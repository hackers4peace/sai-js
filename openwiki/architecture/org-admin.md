---
type: architecture
title: Organization admin model
description: How SAI marks an organization admin with AdminAuthorization/AdminGrant, resolves personal and org contexts, exposes the registry-set link, forwards org events to admin channels, and enforces admin access on the data plane.
tags: [org-admin, authorization, grants, contexts, acp, webhooks]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-c18acf0c50387f2e5ea026d1
    resource: repo://packages/components/src/ActivityWebhookHandler.ts
  - id: openwiki-source-90c157df451973113a63b968
    resource: repo://packages/components/src/AdminImpersonationAuthority.ts
  - id: openwiki-source-7b94b7d1bbbc76b34b554505
    resource: repo://packages/components/src/AgentIdHandler.ts
  - id: openwiki-source-e8d4b9864d3ab4faffa47974
    resource: repo://packages/components/src/services/Admin.ts
  - id: openwiki-source-d1409b74f54faf54952386b2
    resource: repo://packages/components/src/services/adminGate.ts
  - id: openwiki-source-452244fad48fe4fdb39195dd
    resource: repo://packages/components/src/services/Context.ts
  - id: openwiki-source-431ff780c51bd57ac5545ec1
    resource: repo://packages/components/src/StorageExchangeAccessPolicy.ts
  - id: openwiki-source-5dc3965aa1f801077859e52f
    resource: repo://packages/components/src/temporal/activities/admin.ts
  - id: openwiki-source-8234a6e736dae0174b21a1ec
    resource: repo://packages/components/src/temporal/workflows/admin.ts
  - id: openwiki-source-5f3a5827ade0bebc11f29499
    resource: repo://packages/data-model/src/context.ts
  - id: openwiki-source-2efbd3f6886bb62ccfb8efaf
    resource: repo://packages/data-model/src/social-agent-registration.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# Organization admin model

An organization is a RegistrySet owned by the org WebID. An **admin** is another
agent allowed to operate on that RegistrySet. The model has three parts: a
marking layer (`AdminAuthorization` + `AdminGrant`), a context layer (personal
vs organization), and an enforcement layer (ACP for structural registries,
token-carried grants for data, and forward-only admin event channels).

## 1. Marking layer (R1)

An admin is recorded like any other grant pair:

- **`AdminAuthorization`** in the org's AuthorizationRegistry: `grantee` = admin
  WebID, `grantedBy` = org, `scopeOfAuthorization interop:All`.
- **`AdminGrant`** generated from it:
  - one `interop:RegistrySet`-scoped grant — the **marker**, linked from the
    org's `SocialAgentRegistration` of the admin via `interop:hasAdminGrant`;
  - one **Read-only** `interop:DataRegistry`-scoped grant per data registry
    (`hasStorage`, `accessMode [acl:Read]`) for listing/labels.

The R1 vocabulary (`AdminAuthorization`, `AdminGrant`, `hasAdminGrant`,
`scopeOfAdminGrant`) supersedes the old `interop:AdminRegistration` rdf:type
flag ([`data-model/src/context.ts`](../../packages/data-model/src/context.ts)).
`buildAdminGrants` constructs the marker and the read-only DataRegistry grants
([`temporal/activities/admin.ts`](../../packages/components/src/temporal/activities/admin.ts)).

The marker rule is "a registration with a non-empty `hasAdminGrant` is an
admin"; `getAdminGrantIris` is the predicate extractor
([`data-model/src/social-agent-registration.ts`](../../packages/data-model/src/social-agent-registration.ts)).
The rule itself is currently implemented in four components call sites; see
[Domain-logic placement](domain-logic-placement.md).

## 2. Personal and organization contexts

The user always acts in a context:

- **personal** — the user's own WebID and RegistrySet;
- **organization** — a RegistrySet the user administers.

`resolveContext` allows the personal context unconditionally. An org context is
allowed only when the caller holds a non-empty `hasAdminGrant` on the org's
registration of the caller. It resolves the org's RegistrySet through the org's
agent-id document (`Link: rel="interop:hasRegistrySet"`, served only to admins)
and does **not** build a second session: the admin's own AA performs operations
with the org as context owner ([`services/Context.ts`](../../packages/components/src/services/Context.ts)).
`AgentIdHandler` adds the admin-only registry-set link; the body remains public
([`AgentIdHandler.ts`](../../packages/components/src/AgentIdHandler.ts)).

`requireOrgAdmin` is the shared gate for the org-context read endpoints: it reads
the org's session, finds the caller's registration, and requires a non-empty
marker; an unknown org is indistinguishable from "not an admin"
([`services/adminGate.ts`](../../packages/components/src/services/adminGate.ts)).

## 3. AddAdmin and RemoveAdmin

Both are activity-first:

1. The RPC validates the admin target, the last-admin guard, and writes the
   `AdminAuthorizationGranted` / `AdminAuthorizationRevoked` activity with the
   pre-minted / existing `AdminAuthorization` embedded
   ([`services/Admin.ts`](../../packages/components/src/services/Admin.ts)).
2. The webhook handler (or the sweep) starts
   `processAdminAuthorizationGranted` / `processAdminAuthorizationRevoked`.
3. The granted workflow PUTs the `AdminAuthorization` at the pre-minted id,
   materializes the admin grants, runs the ACR rewrite, then marks the activity
   done. The revoked workflow DELETEs the authorization, revokes the grants,
   runs the ACR rewrite, then completes. Children never mark done, so a failed
   ACR rewrite cannot be masked by a successful grant write
   ([`temporal/workflows/admin.ts`](../../packages/components/src/temporal/workflows/admin.ts)).

The last-admin guard applies in **org** contexts (the org must never end up
adminless). The **personal** context skips it: the owner remains the operator of
their own RegistrySet, so demoting the only admin is legitimate. `syncAdminAcr`
derives the `#fullAdminAccess` matcher set from the current admin list; an empty
list removes the control and its wiring entirely
([`temporal/activities/admin.ts`](../../packages/components/src/temporal/activities/admin.ts)).

`SocialAgent.admin` is the **direct** marker in the current context;
`SocialAgent.adminOf` is the **reciprocal** marker (orgs the user administers)
used by the context switcher. Promoting the user's own admin does not change
`adminOf`; the reciprocal marker changes through the peer registration path.

## 4. Admin events

The org processes its own activities, so their `pending`/`done` events land in
the **org's** stream. Each admin gets a **separate webhook channel per
(admin, org)**:

- `webId` = the admin (events land in the admin's UI stream),
  `topic` = the org's Activity Registry, `accountId` = the admin's account;
- created on `AddAdmin`, removed on `RemoveAdmin`, healed by the channel sweep;
- the owner channel keeps dispatching workflows; admin channels are
  **forward-only**, so they never take over dispatch
  ([`ActivityWebhookHandler.ts`](../../packages/components/src/ActivityWebhookHandler.ts)).

Channel provisioning for real deployments is **not implemented yet**: dev/test
pre-seeds the channels, and the bootstrap/healing design is issue #113.

## 5. Data-plane admin access

- **Structural registries** (agent, authorization, grant, role, activity): ACP.
  `syncAdminAcr` keeps the `#fullAdminAccess` matcher list in step with the
  current admins. The seed currently grants a blanket Read+Write+Control over
  the whole RegistrySet; per-registry scoping is
  [Registry permissions and admin scoping](registry-permissions.md) and issue
  #134.
- **Data registries / instances:** admins get read-only `DataRegistry` grants
  for listing/labels; storage reads use the token `scope: admin` (read-only)
  path minted at the exchange only when the subject holds a `DataRegistry`
  AdminGrant and the client is the subject's own UAS
  ([`StorageExchangeAccessPolicy.ts`](../../packages/components/src/StorageExchangeAccessPolicy.ts)).
- **Peer data:** read-only org impersonation derives a narrowed `odrl:read`
  claim from the org's grants and presents the org to the peer; no document
  proxy ([`AdminImpersonationAuthority.ts`](../../packages/components/src/AdminImpersonationAuthority.ts)).

## 6. Open item

Adding a **new data registry** to a RegistrySet must expand the admin's
All-scope authorization into a fresh `DataRegistry` `AdminGrant` (future domain
event). Tracked as issue #130.

## 7. Tests

- `test/org-context.test.ts` — discovery, context authorization, owner identity,
  admin gating, last-admin guard, org own/peer data reads.
- `test/personal-admin.test.ts` — owner promotes/demotes an admin in the
  personal context.
- `test/admin-events.test.ts` — admin channel forwarding and event keying.
- `packages/components/test/admin-impersonation.test.ts` — the read-only
  impersonation authority.
- `packages/components/test/authorization-revocation-workflow.test.ts` and
  `grants-workflow.test.ts` — activity/workflow ordering for the admin legs.

## 8. Related pages

- [Registry permissions and admin scoping](registry-permissions.md)
- [Social graph and trust edges](social-graph.md)
- [Org-context data plane](../services/org-context.md)
- [RPC contract and service layer](../services/rpc-and-services.md)
- [ID-JAG access claims and impersonation](id-jag-access-claims.md)
