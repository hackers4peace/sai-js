# Plan: Registry-set permissions — per-registry ACP scoping

> **Status:** design — not started. Follow-up to `org-admin-feature.md` R1. The
> current seed grants admins **blanket** `#fullAdminAccess` (Read+Write+Control)
> over the whole RegistrySet via `memberAccessControl` inheritance. This plan
> scopes that per registry, motivated by *who actually touches each registry*.

## Context: who touches the org's registries

`#fullAdminAccess` on `registry/yoyo/.acr` is registered under both
`acp:accessControl` and `acp:memberAccessControl`, so it currently covers every
sub-registry container (agent, authorization, grant, role, activity) and their
members. Walking through the admin flows (R1 pipeline) shows most of that reach
is unused:

| Registry | Who writes (R1) | Who reads (R1) | Admin reach needed? |
|---|---|---|---|
| Agent | owner via org session; **admin** (org context, `addSocialAgent`, `AddAdmin` PATCHes registration) | peers via per-registration `.acr` `peerReadAccess`; admin/owner via inheritance | **Read+Write** |
| Authorization | org AA / admin RPC (`recordAuthorization`, `AddAdmin` records the AdminAuthorization) | UI authorization views; workflows (authorization iterators, SPARQL) | **Read+Write** |
| Grant | **org AA only** (Temporal: `storeGrant`, `createAcr`, revocation — owner session) | grantee via **per-grant `.acr`** (`peerReadAccess`); engine via SPARQL (`getAuthorizationData`), not HTTP | **none** |
| Role | org AA / owner (roles service) | UI role views | Read+Write (unchanged) |
| Activity | org AA workflows (`activityCompleted`); **admin RPC** (`AddAdmin` writes the `adminAuthorizationGranted` activity) | UI events stream (`ActivityEvents`); `ActivityWebhookHandler` (org AA) | **Read + create/append** |

The deciding facts:

- The org's authorization agent generates **all** grants (and their ACRs) with
  the owner session; the admin never writes a grant resource.
- Grant reads the admin (or any grantee) needs go through **each grant's own
  `.acr`** (`peerReadAccess`) — the ACR-per-grant pattern is precisely what
  makes grants available without registry-level access.
- The data-registry enforcement path is **SPARQL** (`SaiPermissionsEngine` /
  `SaiAuthorizationManager`), never an admin HTTP fetch of grants.
- The Activity Registry is an **append-only log of immutable activities**
  (`immutable-activities.md`): actors should be able to *create* activities,
  not arbitrarily Read+Write+Control them.

## Goal

Replace the blanket `#fullAdminAccess` with per-registry access controls:

1. **GrantRegistry: no admin access.** Owner-only (the org AA does all writes;
   grantees are served by per-grant ACRs). This is also the hook for future
   per-registry admin scoping (R1 currently assumes "admin of everything").
2. **ActivityRegistry: Read + create/append, not blanket Write.** Activities are
   immutable members appended to the log. Exact ACP mode to verify against the
   CSS ACP implementation: whether creating a new member under the container
   needs `acl:Write` on the container or `acl:Append` suffices (and how it maps
   to the engine's `PERMISSIONS`). The `AddAdmin`/`RemoveAdmin` RPC writes the
   `adminAuthorizationGranted` activity — in the admin context that write
   comes from the **admin's** UAS, so admins must hold the create/append mode
   for it to keep working.
3. **Agent / Authorization / Role:** admin Read+Write (+ Control for the owner)
   stays — unchanged from R1; these are where the admin actually operates.

## Mechanics

- **Per-container ACRs.** The blanket matcher can't be scoped per registry from
  `yoyo/.acr` alone — the sub-registry containers need their own `.acr` files
  (e.g. `grant/.acr`, `activity/.acr`) with owner controls + scoped admin
  controls, while `yoyo/.acr` keeps `fullOwnerAccess` (+ `fullAdminAccess` only
  for the registries that need it, or dropped in favor of per-container
  controls).
- **Seed hygiene required:**
  - YoYo's DataGrants `p7n2vx` / `t5m8qr` currently have **no ACRs** — they rely
    on `memberAccessControl` inheritance to be readable at all (a latent gap:
    Bob can't read his own yoyo grants via ACP today). Narrowing the GrantRegistry
    forces these to get proper `.acr`s (owner + `peerReadAccess`), matching what
    the runtime `createAcr` already produces.
  - The AdminGrant resources keep their own ACRs (owner + Dan `peerReadAccess`,
    already seeded) — unaffected.
- **AdminPermissionReader** (`AdminPermissionReader.ts`, data server) is an
  *owner* fast-path and unchanged — admins are not owners and fall through to the
  engine.

## Constraint to record

If a future Phase 2/3 admin-context workflow ever writes **grants** with the
admin's UAS instead of the org's (all current grant writes — generation,
revocation — run with the org's session), the GrantRegistry needs admin Write
again. Keep the owner-session rule for grant writes; revisit this plan if that
changes.

## Open questions

- Does the admin need any GrantRegistry **read** in Phase-2 views? (Today: no —
  the UI reads registrations + per-grant ACRs; the engine uses SPARQL.)
- Exact ACP modes for append-only activity creation (Read + Append vs Read +
  Write-on-container), and how the engine's mode map represents them.
- Whether the per-container ACRs should replace `#fullAdminAccess` entirely or
  coexist (recommended: replace, one mechanism).

## Related docs

- `org-admin-feature.md` (R1) — the admin grant/authorization model this scopes;
  `openwiki/services/activity-lifecycle.md` — the domain events written into the Activity Registry;
  `openwiki/architecture/federation.md` — cross-server notes this follows on; `immutable-activities.md`
  — append-only activity semantics.