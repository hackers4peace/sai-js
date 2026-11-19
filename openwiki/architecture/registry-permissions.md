---
type: architecture
title: Registry permissions and admin scoping
description: How ACP/ACRs protect the org's structural registries today, the blanket fullAdminAccess seed, who actually writes each registry, and the per-registry scoping design that remains open.
tags: [acp, acr, registries, admin, permissions, security]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-6028df227cf0c5e36d839191
    resource: repo://environments/data/registry.trig
  - id: openwiki-source-82daddf07d8ad3efedbe52d2
    resource: repo://packages/authorization-agent/src/activity-registry.ts
  - id: openwiki-source-0e27aa8e897f26683c4de317
    resource: repo://packages/components/src/SaiAuthorizationManager.ts
  - id: openwiki-source-431ff780c51bd57ac5545ec1
    resource: repo://packages/components/src/StorageExchangeAccessPolicy.ts
  - id: openwiki-source-5dc3965aa1f801077859e52f
    resource: repo://packages/components/src/temporal/activities/admin.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# Registry permissions and admin scoping

The org's RegistrySet is protected by **ACP/ACRs** on the registry containers.
The current seed grants admins a blanket `#fullAdminAccess` over the whole
RegistrySet; most of that reach is unused, and narrowing it per registry is an
open design (issue #134). This page records the current enforcement, the
writes/reads each registry actually needs, and the target shape.

## 1. Current seed

`https://registry/yoyo/.acr` is wired under both `acp:accessControl` and
`acp:memberAccessControl`, so the matchers cover every sub-registry container
and its members. `#fullAdminAccess` allows Read+Write+Control to the org's
admins ([`environments/data/registry.trig`](../../environments/data/registry.trig)):

```trig
<https://registry/yoyo/.acr#root>
    acp:accessControl <...#fullOwnerAccess>, <...#fullAdminAccess>;
    acp:memberAccessControl <...#fullOwnerAccess>, <...#fullAdminAccess>.
```

The seed's per-grant ACRs are present: the YoYo DataGrants `p7n2vx` /
`t5m8qr` now have their own `.acr` with `fullOwnerAccess` +
`peerReadAccess` (previously they relied on inheritance). The remaining gap is
the **per-registry** scoping, not the grant ACRs.

## 2. Who touches each registry

| Registry | Who writes | Who reads | Admin reach needed |
|---|---|---|---|
| Agent | owner via org session; **admin** (`addSocialAgent`, `AddAdmin` PATCHes registration) | peers via per-registration `.acr` `peerReadAccess`; admin/owner via inheritance | **Read+Write** |
| Authorization | org AA / admin RPC (`recordAuthorization`, `AddAdmin` records the AdminAuthorization) | UI views; workflows (iterators, SPARQL) | **Read+Write** |
| Grant | **org AA only** (`storeAccessGrant`, `createAcr`, revocation — owner session) | grantee via per-grant `.acr`; engine via SPARQL, not HTTP | **none** |
| Role | org AA / owner (`roles` service) | UI role views | Read+Write (unchanged) |
| Activity | org AA workflows; **admin RPC** (`AddAdmin` writes `adminAuthorizationGranted`) | UI events stream; `ActivityWebhookHandler` (org AA) | **Read + create/append** |

The deciding facts:

- The org's authorization agent generates **all** grants (and their ACRs) with
  the owner session; the admin never writes a grant resource
  ([`temporal/activities/admin.ts`](../../packages/components/src/temporal/activities/admin.ts)).
- Grant reads the admin (or any grantee) needs go through each grant's own
  `.acr` (`peerReadAccess`), which is the ACR-per-grant pattern.
- The data-registry enforcement path is **SPARQL/token**, never an admin HTTP
  fetch of grants: `SaiAuthorizationManager` reads the storage owner's
  registry-pod dataset, and `StorageExchangeAccessPolicy` mints
  `scope: owner`/`admin` at exchange time
  ([`SaiAuthorizationManager.ts`](../../packages/components/src/SaiAuthorizationManager.ts),
  [`StorageExchangeAccessPolicy.ts`](../../packages/components/src/StorageExchangeAccessPolicy.ts)).
- The Activity Registry is an **append-only log of immutable activities**;
  actors should be able to create activities, not arbitrarily
  Read+Write+Control them.

## 3. Target: per-registry scoping

1. **GrantRegistry: no admin access.** Owner-only (the org AA does all writes;
   grantees use per-grant ACRs). This is also the hook for future per-registry
   admin scoping.
2. **ActivityRegistry: Read + create/append, not blanket Write.** Verify whether
   creating a member needs container `acl:Write` or `acl:Append` in the CSS ACP
   implementation, and how that maps to the engine's `PERMISSIONS`. The
   `AddAdmin`/`RemoveAdmin` RPC writes the activity from the admin's UAS, so
   admins must hold the chosen mode.
3. **Agent / Authorization / Role:** admin Read+Write (+ Control for the owner)
   stays.

Mechanics:

- **Per-container ACRs.** The blanket matcher cannot be scoped per registry
  from `yoyo/.acr` alone; the sub-registry containers need their own `.acr`
  files (e.g. `grant/.acr`, `activity/.acr`) with owner controls + scoped admin
  controls, while `yoyo/.acr` keeps `fullOwnerAccess` (and `fullAdminAccess`
  only where needed, or drops it in favor of the per-container controls).
- **Seed hygiene** is already fixed for the grant ACRs; keep the runtime
  `createAcr` output and the seed aligned.
- **AdminPermissionReader is gone** (C6); the data-plane mechanisms are the
  claim engine, the exchange-minted `scope: owner`/`admin`, and the separate
  public reader.

## 4. Constraint

If a future workflow ever writes **grants** with the admin's UAS instead of the
org's (all current grant writes run with the org's session), the GrantRegistry
needs admin Write again. Keep the owner-session rule; revisit this design if it
changes.

## 5. Open questions

- Does the admin need any GrantRegistry **read** in phase-2 views? Today no:
  the UI reads registrations + per-grant ACRs; the engine uses SPARQL.
- Exact ACP modes for append-only activity creation (Read + Append vs
  Read + Write-on-container), and the engine's mode map.
- Replace `#fullAdminAccess` entirely or let the two mechanisms coexist
  (recommended: replace, one mechanism).

The design is tracked as issue #134. The new-data-registry admin-grant expansion
is a separate issue (#130).

## 6. Tests

- `test/org-context.test.ts` — admin flows against the seeded ACRs.
- `test/personal-admin.test.ts` — owner promotion/demotion and the ACR rewrite.
- `packages/components/test/authorization-revocation-workflow.test.ts` and
  `grants-workflow.test.ts` — grant ACR lifecycle.
- `packages/components/test/storage-exchange-access-policy.test.ts` — the
  exchange-minted owner/admin scopes.

## 7. Related pages

- [Organization admin model](org-admin.md)
- [Per-pod storage and isolation](storage-isolation.md)
- [Federation constraints](federation.md)
- [ID-JAG access claims and impersonation](id-jag-access-claims.md)
