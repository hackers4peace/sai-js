# Org admin — `AdminAuthorization` + `AdminGrant` (R1; supersedes the flag)

> **Status:** design; seed data **done** (§3.6, revised per R1). Models who is
> an **admin** of the organization owning the Agent Registry as an
> `AdminAuthorization` (+ generated `AdminGrant`s) instead of the original
> `interop:AdminRegistration` rdf:type — see **Revision R1** below. This is the
> **marking** layer only — it records *who* is an admin. Granting admins Write
> on the org's registries (ACP `fullAdminAccess` + permission engine via
> Read-only data-registry grants) is the enforcement half (§6 / R1).

## Revision R1 — `AdminAuthorization` + `AdminGrant` (supersedes the flag)

R1 replaces the `interop:AdminRegistration` rdf:type on the registration with a
grant/authorization pair mirroring the data model. Decisions recorded with the
maintainer (see `openwiki/services/activity-lifecycle.md` for the event model, `openwiki/architecture/federation.md` for the
single-store assumptions the engine path relies on):

- **Model.** `AdminAuthorization` in the org's AuthorizationRegistry (like
  `DataAuthorization`): `grantee` (the admin webId), `grantedBy` (the org),
  `scopeOfAuthorization interop:All` for now. The org's `SocialAgentRegistration`
  of the admin links `interop:hasAdminGrant` (array) to `AdminGrant`s in the
  org's GrantRegistry. The reciprocal registration stays plain (same asymmetry
  as data grants).
- **AdminGrant scopes** — `scopeOfAdminGrant` is `interop:RegistrySet` or
  `interop:DataRegistry` for now:
  - one **RegistrySet**-scoped grant per admin = the *admin marker* (status /
    discovery / context switcher). For now **only this grant is linked** via
    `hasAdminGrant`; data registries are reached through the RegistrySet
    (`hasDataRegistry`), not by linking every grant;
  - one **DataRegistry**-scoped grant per data registry (storage) in the
    RegistrySet, with `hasStorage` <data registry> and **`accessMode` `acl:Read`
    only** — consumed by `SaiPermissionsEngine` solely to iterate and gather
    labels (e.g. DataRegistry views). Pickup is nearly free: the engine's
    `getAuthorizationData` (`?s <interop:hasStorage> <storage>`) already
    collects them; the engine adds an admin lookup branch for
    Registry/Registration/Resource targets under that storage.
- **Registry storage stays ACP.** `fullAdminAccess` (Read+Write+Control)
  matchers remain the enforcement for structural registries. Matchers become a
  **derived artifact**: rewritten from the admin list by the ACR workflow
  (idempotent rewrite, not incremental patch) — **Phase 5**: the rewrite also
  wires the control into the `.acr` `#root` (`acp:accessControl`/
  `acp:memberAccessControl`) and, for an EMPTY admin list (personal-context
  last-admin demotion), removes it entirely. The data server's
  `AdminPermissionReader` owner fast-path is unchanged — admins are not owners,
  they fall through to the engine.
- **Pipeline.** `AddAdmin`/`RemoveAdmin` (RPC from the UI) synchronously
  create/delete the `AdminAuthorization` in the org's AuthorizationRegistry
  (erroring on already-admin / non-admin — decided) and write a domain activity
  to the org's Activity
  Registry — **distinct shapes**: `AdminAuthorizationGranted` on add,
  `AdminAuthorizationRevoked` on remove (mirroring the typed activity
  precedent — `AuthorizationGranted`/`AuthorizationDenied`, with revocation as
  `AuthorizationRevoked`; no `granted: false` reuse). `ActivityWebhookHandler` starts **parallel workflows** from the
  trigger — on add `createAdminGrants` (generate the RegistrySet +
  per-data-registry grants) / on remove `revokeAdminGrants` (drop grants, link,
  ACRs), plus `syncAdminAcr` (rewrite `#fullAdminAccess`) on both — diverging
  after the trigger; the activity payload feeds both.
- **No delegation or inheritance** for admin grants — no `delegationOfGrant`, no
  `inheritsFromGrant`, no delegation-endpoint involvement.
- **Admin-authorization iteration is deferred** until the consuming
  functionality is planned. Meanwhile the authorization-registry data iterators
  are **type-filtered** (`interop:DataAuthorization`) so admin resources never
  leak into data flows (the workspace `authorization-agent` package calls the
  same crud functions, so a central filter covers it).
- **Vocabulary.** `interop:` namespace may be modified as needed:
  `AdminAuthorization`, `AdminGrant`, `hasAdminGrant`, `scopeOfAdminGrant`,
  with `interop:RegistrySet` / `interop:DataRegistry` reused as scope values.
- **Seed (§3.6) revised** to the new model (below); `#fullAdminAccess` stays
  hand-written in the seed for now (the matcher workflow supersedes it at
  runtime).
- **TODO (not Phase 1):** a new data registry added to a RegistrySet must expand
  the All-scope authorization into a new DataRegistry grant — future domain
  event (`openwiki/services/activity-lifecycle.md`).

## Phase map & verification

Three phases, each ending in a **checkpoint**. The repo is turbo-based; the
checkpoint after **every phase and every step** is:

```bash
npm run build && npm run test   # turbo, serial; whole tree must stay green
```

Every step below is a small, **independently mergeable** unit — it must leave
the tree compiling and all existing tests green before moving on. There is no
default-not-green step; if a step cannot land green, it is too big and should be
split.

| Phase | Scope | Steps | Checkpoint
|---|---|---|---|
| **1 — Marking layer** (§R1 + §3.6–3.9) | vocab · data model · RPC · handler · workflows · seed | 1.1 R1 vocabulary — `AdminAuthorization`/`AdminGrant`/`hasAdminGrant`/`scopeOfAdminGrant` (§3.9); 1.2 §3.8 type-filtered authorization iterators (replaces the superseded §3.2 flag model); 1.3 R1 RPC service — record `AdminAuthorization` + write activity (§3.9); 1.4 §3.4 API messages; 1.5 §3.5 handler wiring; 1.6 §3.6 seed *(done, revised)*; 1.7 §3.7 admin workflows (add: `createAdminGrants` + `syncAdminAcr`; remove: `revokeAdminGrants` + `syncAdminAcr`) | build+test after each; UI not required yet
| **2 — Operating in context** (§2 below) | context model · discovery · RPC context · backend registry-set map · UI switcher/toggle · e2e | 2.1 `SocialAgent.admin` + discovery; 2.2 `context` field + context struct + context authn; 2.3 registry-set map + `AgentIdHandler` `hasRegistrySet` link; 2.4 service owner/target refactor; 2.5 admin events forwarding (→ Phase 3); 2.6 UI switcher + toggle-admin; 2.7 e2e; 2.8 org data access — `SaiPermissionsEngine` admin branch (§2.10) *(done)* | build+test after each; e2e scaffolding may be needed before 2.6; 2.8 needs the admin-credentialed data-read e2e
| **3 — Admin events forwarding** (§3 below) | **reuse `ActivityWebhookHandler`** (R3 — Option A): admin channels forward-only, owner channels keep dispatching; events keyed to admin webId | 3.1 extract forwarding half; 3.2 subscription recognition + event keying; 3.3 wire admin events into UI | build+test after each; kv.json seeds both dan channels (personal + YoYo admin)
| **4 — Docs update** (below) | `peer.md` · `social-graph.md` | edit both docs to reflect the implemented org-context + forwarding behavior | build+test; review diffs of both docs

Phase 1 (steps 1.1–1.5) needs **no UI**; it is a backend-only vertical slice.
Steps 1.1–1.5 were originally mapped to §3.1–§3.5, which Revision R1 supersedes —
execute the R1 versions (§R1 + §3.6–§3.9, step table above), not the history
sections.
Phase 2 is the largest and is the one most likely to need steps split further
while implementing (each §2.x section maps to roughly one step above).

If a step's tests depend on infrastructure not yet present (e.g. Temporal or a
running CSS for the e2e), note that dependency *inside* the step rather than
carrying an unverifiable step — and flag it in the checkpoint so it is explicit
what is and isn't covered.

Sections 1–6 below are the **Phase 1** working notes (problem, current state,
the change, design decisions, tests, out-of-scope); this and the phase labels
make the numbering concrete: top-level §1–§6 = Phase 1, `## Phase 2 (2.x)` =
Phase 2, `## Phase 3` = Phase 3, `## Phase 4` = Phase 4.

## 1. Problem

Today there is exactly one principal per RegistrySet: the **owner** (`https://id/acme`).
Only the owner holds Write/Control on the org's registries (every registry ACR
and registration ACR in `environments/data/registry.trig` matches
`agent <owner>` + the owner's UAS client). There is **no way to represent** a
second person who should act on the org's behalf.

The plans already assume such people exist but never define them:
`workflow-temporal-decupling.md` repeatedly refers to **"admin agents"** — the
producers who Write the Activity Registry and grant registries — without saying
what makes an agent an admin. The permission engine has explicit holes for it:

- `SaiPermissionsEngine.ts:42` — the `TargetType.Registry` case is an empty
  `break` with `// TODO: use extra data to check if it is an admin using their UAS`.
- `SaiAuthorizationManager.ts:62` — `// TODO: add statements about admins/trusted grants`.

This plan establishes the **data-model + RPC** vocabulary for "this registered
Social Agent is an org admin", so the enforcement phase has something to read.

## 2. Current state (as-is)

- `SocialAgentRegistrationData` has `type: string[]`, captured from framing on
  read (`fromJsonLd` in `packages/data-model/src/crud/social-agent-registration.ts`).
  Today every registration is typed only `interop:SocialAgentRegistration`.
- Writes are centralized: `createSocialAgentRegistration` **hardcodes**
  `quad(node, RDF.terms.type, INTEROP.terms.SocialAgentRegistration)` and
  `addSocialAgentRegistration` seeds `type: [INTEROP.SocialAgentRegistration]`.
- RPC services live in `packages/components/src/services/*` and are dispatched
  from `ApiHandler.ts` via `@effect/rpc` (`RpcRouter.toHandlerNoStream(router)`),
  with request types + the `SaiService` interface + `router` defined in
  `packages/api-messages/src/effect.ts`.
- There are **no admin terms** in the `INTEROP` vocabulary
  (`packages/utils/src/namespaces.ts`): neither the superseded
  `AdminRegistration` flag nor the R1 `AdminAuthorization`/`AdminGrant`/
  `hasAdminGrant`/`scopeOfAdminGrant`.
- Registration CRUD mutation primitives already exist:
  `addStatement`/`removeStatement` (`packages/data-model/src/crud/container.ts`,
  SPARQL PATCH on the registration resource).

## 3. Change

> **Superseded by Revision R1** for the marking model — the flag-based §3.1–§3.5
> below are kept as history. §3.6 reflects R1; §3.7 and §3.8 are new (R1).
> The phase-map steps 1.1–1.5 map to **R1 content** (§R1 + §3.6–§3.9), not to
> these history sections — see §3.9 for the per-step R1 spec.

### 3.1 Vocabulary

Add `AdminRegistration` to the `INTEROP` vocabulary in
`packages/utils/src/namespaces.ts`.

### 3.2 Data model — `packages/data-model/src/crud/social-agent-registration.ts`

Add three functions. `isAdmin` is a pure read; `addAdmin`/`removeAdmin` mutate
the registration resource and the in-memory `type[]` array. `create`/`add` are
**not** touched — they never produce the admin type.

```ts
/** True when the registration also carries interop:AdminRegistration. */
export function isAdmin(data: SocialAgentRegistrationData): boolean {
  return data.type.includes(INTEROP.AdminRegistration)
}

/** Mark a registered agent as an org admin (idempotent). */
export async function addAdmin(
  data: SocialAgentRegistrationData,
  factory: AuthorizationAgentFactory
): Promise<void> {
  if (isAdmin(data)) return
  const quad = DataFactory.quad(
    DataFactory.namedNode(data.id),
    RDF.terms.type,
    INTEROP.terms.AdminRegistration
  )
  await addStatement(data.id, factory, quad)
  data.type = [...data.type, INTEROP.AdminRegistration]
}

/** Unmark a registered agent as an org admin (idempotent). */
export async function removeAdmin(
  data: SocialAgentRegistrationData,
  factory: AuthorizationAgentFactory
): Promise<void> {
  if (!isAdmin(data)) return
  const quad = DataFactory.quad(
    DataFactory.namedNode(data.id),
    RDF.terms.type,
    INTEROP.terms.AdminRegistration
  )
  await removeStatement(data.id, factory, quad)
  data.type = data.type.filter((t) => t !== INTEROP.AdminRegistration)
}
```

- `addStatement`/`removeStatement` are already imported/exported from
  `./container` (used elsewhere in the same module for `reciprocalRegistration`).
- Export `isAdmin`, `addAdmin`, `removeAdmin` from `packages/data-model/src/crud/index.ts`.

> **Why `type[]`, not a new field?** The rdf:type is already round-tripped by
> framing, and the container link (`interop:hasSocialAgentRegistration`) already
> points at the registration. Admin-ness is therefore just an extra rdf:type on
> the same resource — no new predicate, no new container, no reciprocal changes.
> Generic readers that fetch by IRI (`factory.socialAgentRegistration`) see it
> for free; only callers that care to distinguish admins call `isAdmin`.

### 3.3 RPC service — `packages/components/src/services/Admin.ts`

New service following the `RoleRegistry.ts` pattern. It resolves the
registration by webId (fresh from the wire), mutates it, and returns the
updated `SocialAgent` profile so the UI can reflect the change immediately.

- **Gating.** Only **admins of the org** may call `addAdmin`/`removeAdmin`; a
  non-admin gets an error (the org's Agent Registry is admin-only).
- **`removeAdmin` last-admin guard.** Since an org ends up adminless otherwise,
  `removeAdmin` validates that it is not removing the **last admin** and refuses
  if so (the UI also disables the toggle when only one admin remains).
- **ACR matchers must stay in sync.** `addAdmin`/`removeAdmin` must also add/remove
  the admin **and their authorization agent** in `acp:anyOf` of the org's
  `fullAdminAccess` access control in `environments/data/registry.trig` (currently
  matching `<https://id/dan>` + `acp:client <.../aHR0cHM6Ly9pZC9kYW4>` — see the
  `#fullAdminAccess` policy), so the marking and the enforcement never drift.
  This is the enforcement hook that makes the flag actually grant Write/Control
  (see §6).

```ts
import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { addAdmin, removeAdmin } from '@janeirodigital/interop-data-model'
import { IRI, SocialAgent } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { buildSocialAgentProfile } from './AgentRegistry.js'

export const addAdmin = async (
  saiSession: AuthorizationAgent,
  webId: S.Schema.Type<typeof IRI>
): Promise<S.Schema.Type<typeof SocialAgent>> => {
  const registration = await saiSession.findSocialAgentRegistration(webId)
  if (!registration) throw new Error(`Social Agent Registration for ${webId} not found`)
  await addAdmin(registration, saiSession.factory)
  return buildSocialAgentProfile(registration, saiSession)
}

export const removeAdmin = async (
  saiSession: AuthorizationAgent,
  webId: S.Schema.Type<typeof IRI>
): Promise<S.Schema.Type<typeof SocialAgent>> => {
  const registration = await saiSession.findSocialAgentRegistration(webId)
  if (!registration) throw new Error(`Social Agent Registration for ${webId} not found`)
  await removeAdmin(registration, saiSession.factory)
  return buildSocialAgentProfile(registration, saiSession)
}
```

### 3.4 API messages — `packages/api-messages/src/effect.ts`

- Add `AddAdmin` / `RemoveAdmin` `TaggedRequest`s:
  ```ts
  export class AddAdmin extends S.TaggedRequest<AddAdmin>()('AddAdmin', {
    failure: S.Never,
    success: SocialAgent,
    payload: { webId: IRI },
  }) {}
  export class RemoveAdmin extends S.TaggedRequest<RemoveAdmin>()('RemoveAdmin', {
    failure: S.Never,
    success: SocialAgent,
    payload: { webId: IRI },
  }) {}
  ```
- Add both to the `SaiService` interface and to the `router`
  (`Rpc.effect(AddAdmin, ...)` / `Rpc.effect(RemoveAdmin, ...)`).

### 3.5 API handler — `packages/components/src/ApiHandler.ts`

Import `addAdmin`/`removeAdmin` from `./services/Admin.js` and wire them into
the `SaiService.of({...})` alongside the other RPC handlers.

### 3.6 Seed data — `environments/data/registry.trig` ✅ *done* (revised per R1)

Added Dan as an admin of YoYo (IDs generated with `npx @paralleldrive/cuid2 --length 6`):

- **YoYo's Agent Registry** (`https://registry/yoyo/agent/`) lists two social
  agent registrations: the existing `z3k7wm` (Bob) and the admin registration
  `ph8e70` (Dan).
- **Admin registration** `https://registry/yoyo/agent/ph8e70/` — **no**
  `AdminRegistration` type; admin-ness is expressed by links:
  ```turtle
  a interop:SocialAgentRegistration, ldp:Resource;
  interop:registeredAgent <https://id/dan> ;
  interop:reciprocalRegistration <https://registry/dan/agent/zdujx0/> ;
  interop:hasAdminGrant <https://registry/yoyo/grant/vbg74v/> ;   # RegistrySet-scoped
  skos:prefLabel "Dan" ;
  skos:note "An administrator of Yoyodyne." .
  ```
  plus its `.acr` (YoYo `fullOwnerAccess`, Dan `peerReadAccess`).
- **Reciprocal registration** `https://registry/dan/agent/zdujx0/` (Dan's own
  registry, plain `SocialAgentRegistration`) — unchanged: no admin markers on
  the reciprocal, matching the "admin belongs to the owning registry"
  semantics.
- **New `AdminAuthorization`** in the authorization registry
  (`https://registry/yoyo/authorization/<id>`, in `ldp:contains`):
  ```turtle
  a interop:AdminAuthorization;
  interop:grantee <https://id/dan> ;
  interop:grantedBy <https://id/yoyo> ;
  interop:scopeOfAuthorization interop:All .
  ```
  plus its `.acr` (YoYo `fullOwnerAccess`, Dan `peerReadAccess`).
- **New `AdminGrant`s** in the grant registry (`https://registry/yoyo/grant/`):
  one **RegistrySet**-scoped `vbg74v` (linked above via `hasAdminGrant`), plus
  one **DataRegistry**-scoped per YoYo data registry — `ds0emv` → `yoyo-eu`,
  `f76tbp` → `yoyo-na` — each with `interop:hasStorage <data registry>`;
  `interop:scopeOfAdminGrant interop:DataRegistry`;
  `interop:accessMode acl:Read`, and its own `.acr` (YoYo `fullOwnerAccess`,
  Dan `peerReadAccess`). The Read-only data grants are the engine's source for
  org-context data-registry iteration/labels (see R1).
- **`registry/yoyo/.acr`** keeps `#fullAdminAccess` (Read+Write+Control) with
  the matcher for `id/dan` + Dan's authorization agent, under both
  `acp:accessControl` and `acp:memberAccessControl`, inherited by all of YoYo's
  sub-registries and their members. Hand-written in the seed; at runtime the
  `syncAdminAcr` workflow derives it from the admin list (§3.7).

### 3.7 Admin workflows (grants + ACR) — new

`AddAdmin`/`RemoveAdmin` (RPC) synchronously create/delete the
`AdminAuthorization` in the org's AuthorizationRegistry — mirroring the
data-authorization and `deleteRole` paths — then write a domain activity to the
org's Activity Registry (`openwiki/services/activity-lifecycle.md`) — **distinct shapes** for add and remove,
no `granted: false` reuse:
`AdminAuthorizationGranted` on `AddAdmin`, `AdminAuthorizationRevoked` on
`RemoveAdmin` (mirroring the typed activity precedent —
`AuthorizationGranted`/`AuthorizationDenied`, with revocation as
`AuthorizationRevoked`). `ActivityWebhookHandler` starts **parallel workflows** from the
trigger, diverging on the activity type:

**Add — `adminAuthorizationGranted`:**

1. **`createAdminGrants`** — generate the RegistrySet-scoped AdminGrant (and
   link it on the registration) plus one Read-only DataRegistry-scoped grant
   per data registry found via the RegistrySet (`hasDataRegistry`), each with
   its own ACR;
2. **`syncAdminAcr`** — rewrite `#fullAdminAccess` in the org's `.acr` from the
   current admin list (idempotent).

**Remove — `adminAuthorizationRevoked`:** the RPC has already deleted the
`AdminAuthorization` synchronously (decided, mirroring `deleteRole`); the
workflows clean up the generated artifacts:

1. **`revokeAdminGrants`** — delete the admin's RegistrySet- and
   DataRegistry-scoped AdminGrants, unlink `hasAdminGrant` from the
   registration, and remove their ACRs (mirroring `revokeGrants`);
2. **`syncAdminAcr`** — same idempotent rewrite; the last-admin guard reads the
   AuthorizationRegistry as the single source of truth and refuses to leave the
   org adminless.

The activity payload (org `webId` + `admin` webId) feeds both paths; the
workflows diverge on the activity `activityType`. No delegation or inheritance
for admin grants.

**Last-admin guard (decided — both, [Q2]; amended by Phase 5):** at RPC time
`RemoveAdmin` refuses when an ORG's AuthorizationRegistry holds exactly one
`AdminAuthorization`; at workflow time `syncAdminAcr` refuses to produce an
adminless `#fullAdminAccess` (AuthorizationRegistry as single source of truth).
**Phase 5:** in the PERSONAL context (`ctx.webId === ctx.userWebId`) the owner
remains the operator — the RPC guard is skipped, and `syncAdminAcr` with an
EMPTY admin list removes the `#fullAdminAccess` access control entirely
(derived rewrite: zero admins → zero admin access) instead of refusing.

**Workflow specs — outcome / producer / test verification (decided [Q4];
revisit after implementation).**

`createAdminGrants` (trigger `adminAuthorizationGranted`):
- **Outcome.** The admin's RegistrySet-scoped `AdminGrant` exists in the org's
  GrantRegistry and is linked on the registration via `hasAdminGrant` (single
  PATCH replace, mirroring §4.0 of `workflow-temporal-decupling.md` → one
  `Update`), plus one Read-only `DataRegistry`-scoped grant per data registry
  from the RegistrySet (`hasStorage`, `acl:Read`), each with its own `.acr`
  (org `fullOwnerAccess`, admin `peerReadAccess`).
- **Producer.** The `ActivityWebhookHandler` branch starts it on
  `adminAuthorizationGranted`, payload org `webId` + `admin`.
- **Verification.** Listen on the admin's registration in the org's agent
  registry (e.g. `yoyoSession.findSocialAgentRegistration('https://id/dan')`)
  before the RPC; await `AS.Update`; re-read → assert the RegistrySet grant
  plus one DataRegistry grant per `hasDataRegistry` member (`grantee`,
  `grantedBy`, `dataOwner`, `scopeOfAdminGrant`, `hasStorage`, `accessMode`).
  Idempotency: the workflow is idempotent against re-delivery (rewrites, does
  not duplicate grants); the RPC itself rejects a duplicate `AddAdmin` before
  any activity is written.

`revokeAdminGrants` (trigger `adminAuthorizationRevoked`):
- **Outcome.** The admin's RegistrySet- and DataRegistry-scoped AdminGrants are
  deleted (resources + ACRs); `hasAdminGrant` unlinked from the registration
  (single PATCH → one `Update`).
- **Producer.** The handler branch on `adminAuthorizationRevoked`.
- **Verification.** Same listen-await-re-read pattern; assert the link is gone
  and grant resources 404 for the org session.

`syncAdminAcr` (trigger either):
- **Outcome.** The org's `.acr` `#fullAdminAccess` matchers equal the current
  admin list — idempotent derived rewrite; refuses to drop the last admin.
- **Producer.** The handler starts it in parallel with the grants workflow
  (both activity types).
- **Verification.** No registration notification — fetch
  `https://registry/<org>/.acr` fresh (`waitFor` poll; org session) and assert
  the `acp:anyOf` matcher set matches the admin list.

**Test infra dependency (flag in the checkpoint):** the workflow tests ride the
real-CSS-delivery path, so `environments/data/kv.json` needs the **yoyo**
`**activityWebhook**` pre-seed (app store + CSS-side `notifications/…` keys),
mirroring the existing alice/bob/kim entries — dan/yoyo have accounts and
reciprocal channels today but no Activity-Registry channel.

**TODO (not Phase 1):** on a new data registry added to the RegistrySet, expand
the All-scope authorization into a fresh DataRegistry grant — future domain
event (`openwiki/services/activity-lifecycle.md`).

### 3.8 Type-filtered authorization iterators (R1)

`AdminAuthorization`s co-exist with `DataAuthorization`s in the
AuthorizationRegistry, but every existing consumer iterates the registry
*unfiltered* — which would misbehave (crash on an unknown scope in
`findAgentsWithAccess`, feed garbage into grant generation, spuriously match
`findAuthorizationsDelegatingFromOwner`).

Fix centrally at the crud level (`crud/authorization-registry.ts`):
`dataAuthorizations` / `getDataAuthorizations` / `findDataAuthorizations` /
`findAuthorizationsDelegatingFromOwner` skip resources whose `type` lacks
`interop:DataAuthorization` (load-then-filter — framing tolerates extra types,
so loading an admin resource is safe and the check is just
`type.includes(INTEROP.DataAuthorization)`). One change covers all consumers:
the workspace `authorization-agent` package (`findAuthorizationsForAgent`,
`findAgentsWithAccess`, `generateDataGrants`) and the Temporal authorizations
`activities` all call these same crud functions.

One extra spot: `authorization-agent/src/authorization.ts` reads existing
authorizations directly for the reuse/equivalence logic in
`recordAccessAuthorization` — filter there too so an `AdminAuthorization` is
never reused as a data authorization.

Admin-side iteration is **deferred** (R1): when needed, a parallel
`adminAuthorizations()` will filter `type.includes(INTEROP.AdminAuthorization)`.
The **public** listing API stays deferred; the *internal* type-filtered admin
read is now needed in Phase 1 — the RPC last-admin guard, `syncAdminAcr`, and
the workflow inputs all read it via the [Q3]-chosen crud (§3.9).

### 3.9 Phase-1 step specs (R1) — new

Re-maps steps 1.1–1.5 of the phase table onto the R1 model. The other live
Phase-1 sections are §3.6 (seed), §3.7 (workflows) and §3.8 (type filter);
§3.1–§3.5 are history.

- **1.1 Vocabulary** — add to `packages/utils/src/namespaces.ts` (INTEROP):
  `AdminAuthorization`, `AdminGrant`, `hasAdminGrant`, `scopeOfAdminGrant`.
  Scope values reuse existing terms — `interop:RegistrySet` /
  `interop:DataRegistry` for `scopeOfAdminGrant`, `interop:All` for the
  authorization's `scopeOfAuthorization`. **Do not add `AdminRegistration`**
  (that was the superseded §3.1 flag term).
- **1.2 Data model — type filter (§3.8)** — in
  `packages/data-model/src/crud/authorization-registry.ts`, make
  `dataAuthorizations`, `getDataAuthorizations`, `findDataAuthorizations` and
  `findAuthorizationsDelegatingFromOwner` skip resources whose `type` lacks
  `INTEROP.DataAuthorization`; mirror the same filter in
  `packages/authorization-agent/src/authorization.ts`
  (`recordAccessAuthorization` reuse/equivalence). One change covers the
  workspace `authorization-agent` consumers and the Temporal authorizations
  activities. The §3.2 registration-flag functions are history — do not
  implement. The [Q3]-chosen admin crud (write + internal read, below) lives in
  this same module.
- **1.3 RPC service (`packages/components/src/services/Admin.ts`)** — runs on
  the **org's own AA session** (decided [Q1]): `saiSession` *is* the org's
  AuthorizationAgent, so the org is just `saiSession.registrySet` —
  `hasAuthorizationRegistry` for the `AdminAuthorization`, `hasActivityRegistry`
  for the activity — exactly like every existing service. For the admin webId:
  record an `AdminAuthorization` (`grantee`, `grantedBy` the org,
  `scopeOfAuthorization interop:All`, `iriForContained` + PUT as with
  authorizations/activities), then PUT the domain activity via
  `ActivityRegistry.createActivity` (`adminAuthorizationGranted` on add /
  `adminAuthorizationRevoked` on remove, openwiki/services/activity-lifecycle.md). **Synchronous
  AuthorizationRegistry change + error semantics (decided):** the RPC changes
  the registry first — create the `AdminAuthorization` on add, delete it on
  remove (mirroring `recordAuthorization` / `deleteRole`) — and only then
  writes the activity; `ActivityWebhookHandler` starts the workflows from it to
  generate/remove grants and rewrite the ACR (§3.7). `AddAdmin` on an agent who
  already holds an `AdminAuthorization` → error (no write, no activity);
  `RemoveAdmin` on an agent who holds none → error. **Admin gate:** with the
  org's own AA the caller is the owner — allowed by the gate and by ACR
  `fullOwnerAccess`; the non-owner gate (caller holds an `AdminAuthorization`)
  lands with Phase-2 context authz (§2.4). **Last-admin guard (decided both,
  [Q2]):** RPC time — `RemoveAdmin` refuses when the org's AuthorizationRegistry
  holds exactly one `AdminAuthorization`; workflow time — `syncAdminAcr`
  enforces the same (§3.7). **`AdminAuthorization` write mechanism (decided
  [Q3]):** data-model crud in `crud/authorization-registry.ts` —
  `recordAdminAuthorization` writes via `iriForContained` + PUT (incl. the
  container-link update); an internal type-filtered admin read serves the RPC
  guard and `syncAdminAcr` (only the public iteration surface is deferred,
  §3.8). The service calls it with the factory, like `RoleRegistry.createRole`;
  the AA stays untouched.
- **1.4 API messages** — `AddAdmin`/`RemoveAdmin` `TaggedRequest`s exactly as
  §3.4 (R1-neutral), registered on `SaiService` and the `router` in
  `packages/api-messages/src/effect.ts`.
- **1.5 Handler wiring** — `packages/components/src/ApiHandler.ts`: add the
  service to `SaiService.of({...})`; add an `ActivityWebhookHandler` branch
  routing `adminAuthorizationGranted` → `createAdminGrants` + `syncAdminAcr`
  and `adminAuthorizationRevoked` → `revokeAdminGrants` + `syncAdminAcr` (two
  starts per activity or one fan-out via `executeChild` — settle in
  implementation, openwiki/services/activity-lifecycle.md).

**Decided:** [Q1] org's own AA session (owner acts for the org; the non-owner
admin gate lands in Phase 2). [Q2] last-admin guard both at RPC time and in
`syncAdminAcr`. [Q3] data-model crud in `crud/authorization-registry.ts` (AA
surface stays unchanged). [Q4] §3.7 now carries outcome/producer/verification
specs for the three workflows — revisit after implementation. Plus: synchronous
AuthorizationRegistry changes in the RPC (create/delete) with **error** on
already-admin / non-admin (no no-op), the activity written only after the
registry change — mirroring `recordAuthorization` / `deleteRole`.

**Rationale ([Q3]):** the AA option would import the data-authorization
reuse/equivalence machinery, which admin authorizations don't need (no access
modes, no shape trees); the crud colocates admin read+write with the §3.8
type-filter so one module serves the RPC guard, `syncAdminAcr`, and step 1.2.

## 4. Design decisions

> **R1 supersedes the flag-based decisions below where they conflict** — see
> Revision R1. Kept for history.

- **Additional (optional) type, not a replacement.** A registration stays
  `interop:SocialAgentRegistration` and *additionally* carries
  `interop:AdminRegistration`. This keeps every existing iterator
  (`socialAgentRegistrations`, `findSocialAgentRegistration`, reciprocal
  handling, `getSocialAgents`) working unchanged — an admin is still just a
  social agent.
- **`create`/`add` never add it.** Admin-ness is a privilege granted
  explicitly, not at creation. `addSocialAgentRegistration`'s `type` stays
  `[INTEROP.SocialAgentRegistration]`; only the `Admin` service mutates it.
  This keeps the two concerns separate and avoids an accident where a new
  registration silently becomes an admin.
- **Why a service, not a field in `addSocialAgent`.** The `Admin` RPC is a
  small, explicit surface (`addAdmin`/`removeAdmin`) that mirrors the
  "grant/revoke a flag" semantics and leaves room to add enforcement
  (permission entry, ACR grants, activity write) inside the service later
  without disturbing the generic add.
- **Idempotent.** Adding/removing an admin for an agent who already is/isn't
  one is a no-op (guarded before the PATCH), so repeated calls are safe.
- **Loading fresh.** `findSocialAgentRegistration` reads from the wire, so
  `data.type` reflects current RDF — we don't trust a possibly-stale POJO.

## 5. Testing

> **R1:** the bullets below were written for the superseded flag model
> (registrations no longer carry `AdminRegistration`; §3.1–§3.5 are history).
> R1 testing targets: the type-filtered iterators (§3.8), the
> `AddAdmin`/`RemoveAdmin` RPC (records the `AdminAuthorization` + writes the
> activity; setup and write mechanism per the §3.9 decisions), and the §3.7
> workflows.

- **API messages**: schema compile (`AddAdmin`/`RemoveAdmin`). An end-to-end
  ApiHandler test (if the harness supports it) can call the RPC and assert the
  resulting `SocialAgent`.
- **Data model — type filter (§3.8)**
  (`packages/data-model/test/crud/authorization-registry.test.ts`): with both
  an `AdminAuthorization` and a `DataAuthorization` in one registry,
  `dataAuthorizations`, `getDataAuthorizations`, `findDataAuthorizations` and
  `findAuthorizationsDelegatingFromOwner` return only the data authorization; a
  registry holding only `AdminAuthorization`s yields empty results for all four
  (no crash on the unknown `scopeOfAuthorization`). `authorization-agent`'s
  `recordAccessAuthorization` reuse/equivalence also skips `AdminAuthorization`s.
- **Service (§3.9)** (`packages/components` test of `services/Admin.ts`):
  `AddAdmin` creates the `AdminAuthorization` and writes the
  `adminAuthorizationGranted` activity; `RemoveAdmin` deletes it and writes
  `adminAuthorizationRevoked`. Unknown webId → error; **`AddAdmin` on an
  existing admin → error (no write, no activity); `RemoveAdmin` on a non-admin
  → error**. Setup: the org's own AA session ([Q1]); assert the RPC-time
  last-admin guard ([Q2]) — `RemoveAdmin` on the last remaining admin errors
  and writes no activity. Write mechanism: data-model crud in
  `crud/authorization-registry.ts` ([Q3]).
- **Workflows (§3.7)**: outcome/producer/verification specs added ([Q4] —
  revisit after implementation); note the kv.json yoyo activity-webhook
  pre-seed dependency.

*(History — flag-model tests, superseded by R1:)*

- **Data model** (`packages/data-model/test/crud/social-agent-registration.test.ts`):
  - `isAdmin` is `false` for a freshly created registration, `true` after
    `addAdmin`.
  - `addAdmin` adds only the `AdminRegistration` rdf:type (assert via the
    PATCH/interop-utils test fetch), `removeAdmin` removes exactly that type,
    leaving `SocialAgentRegistration`.
  - Idempotence: `addAdmin` twice → single extra type; `removeAdmin` on a
    non-admin → no-op.
  - `createSocialAgentRegistration`/`addSocialAgentRegistration` **never**
    produce `AdminRegistration` (assert on the written dataset).
- **Service** (`packages/components` test of `services/Admin.ts`):
  - `addAdmin`/`removeAdmin` return the updated `SocialAgent` profile and the
    registration reflects the flag on the next read.
  - Unknown webId → error.

## 6. Out of scope / follow-ups

> **R1 re-shapes part of this section:** admin data-registry access is now a
> Read-only grant for iteration/labels; registry-storage enforcement stays ACP.
> See Revision R1 and §3.7.

- **Enforcement — the actual admin privilege.** This plan only *marks* admins.
  Making an admin able to *do* things splits along two different enforcement
  paths:
  - **Structural registries (agent/auth/grant/role/activity) — ACP.** Access is
    controlled by the org's `.acr` files; granting an admin means the
    `fullAdminAccess` matchers in `environments/data/registry.trig` (§R1/§3.6),
    aligned by the `syncAdminAcr` workflow (§3.7). **Administrative Write/Control on the
    structural registries is fully covered this way.**
  - **Data registries / data instances — permission engine (open).** These are
    served by the **data service** and gated by the `SaiPermissionsEngine`
    (`TargetType.Registry` TODO at `SaiPermissionsEngine.ts:42`,
    `SaiAuthorizationManager.ts:62`). How admins list/read/share the org's data
    registries and instances is **not yet designed** — including how
    `listDataRegistries` / `listDataInstances` behave in an org context and
    whether `shareResource` needs a data instance (for a label) to work (see
    §2.8).
- **Activity write.** Decided (R1): `AddAdmin`/`RemoveAdmin` append a domain
  activity to the org's Activity Registry — `adminAuthorizationGranted` on
  add, distinct `adminAuthorizationRevoked` on remove (own shape; no
  `granted: false` reuse) — driving the grant/ACR workflows (`openwiki/services/activity-lifecycle.md`,
  §3.7).
- **Admin of *which* registry — ✅ confirmed: placement is sufficient, no
  explicit link needed.**
  - One RegistrySet per webId/org (derived deterministically via
    `registryId(webId)`); the owner's RegistrySet links to its Agent Registry
    via `hasAgentRegistry`, and the registration is a member of that registry —
    so admin scope is reachable by following `hasAgentRegistry` from the
    RegistrySet; nothing needs to be written on the registration.
  - Admin means admin of **everything** (the whole RegistrySet); no per-registry
    scoping at this time.
  - A single agent may admin multiple orgs; admin-ness is scoped by the org
    **context** (the RegistrySet/Agent Registry being operated on), not by the
    registration itself.
- **Seed lifetime.** The Dan-as-YoYo-admin seed (§3.6) is bootstrap data; the
  runtime `AddAdmin`/`RemoveAdmin` path (Phase 1, §3.7–§3.9) is what
  grants/revokes admins once implemented, superseding the hand-written seed.

---

## Phase 2 (major) — operating in context

> This is the main refactor the org-admin feature unlocks. The user always acts
> in a **context**; by default their **personal context** (their own webId), or
> an **organization context** the user administers. In an org context the user
> operates on *that org's* registries with the org as the owner.

### 2.1 Model

A **context** is identified by a webId:
- **Personal context** — the signed-in user's own webId (default).
- **Organization (admin) context** — a webId the user administers, i.e. an org
  whose Agent Registry holds the user's registration with an **admin marker** (a
  `hasAdminGrant` link to the RegistrySet-scoped `AdminGrant`, recorded as an
  `AdminAuthorization` in the org's AuthorizationRegistry); reached from the
  user's own registration via `reciprocalRegistration`.

The backend **keeps the user's own AuthorizationAgent** (their UAS as the OIDC
client — this is exactly what `fullAdminAccess` on the org's `.acr` matches) and
redirects which registries it operates on. In an admin context:

- **Owner identity = the org.** Recorded as `dataOwner` and `grantedBy` on
  grants/authorizations, as the ACR `fullOwnerAccess` creator on new
  registrations, and as the `webId` actor in activities. The user (admin) only
  *authenticates*; they are not the data owner. *(C1 — decided)*
- **Target registries = the org's.** Reads and writes hit the org's
  agent/authorization/grant/activity/data registries, not the user's.

Today services derive *both* the target and the owner from `saiSession.webId` +
`saiSession.registrySet` (e.g. `addSocialAgent` → `creator: { agent: saiSession.webId, client: saiSession.agentId }`, `recordAuthorization` → `grantedBy: saiSession.webId`, reads → `saiSession.registrySet`). The core refactor is replacing those two with **context-derived** values.

### 2.2 Context discovery (switchable contexts)

- **`SocialAgent.admin` boolean (moved up from the §6 UI follow-up).** Extend
  the `SocialAgent` message with an **`admin` boolean** and populate it in
  `buildSocialAgentProfile` (from the registration's admin marker — a non-empty
  `hasAdminGrant` link — applying the asymmetry below) so the UI can flag
  admins of the context org. *(Q6 — decided)*
- **Asymmetry (where the flag is read from).** The admin marking lives on the
  **org's registration of the user** (the reciprocal). So deciding which side to
  read depends on the context:
  - if `context === user's webId` (personal context): `admin` is read from the
    **org's registration** of the user, reached via `reciprocalRegistration`
    (the admin marker lives there, not on the user's own registration);
  - if `context` is an org other than the user: `admin` is read from **that
    org's registration** of the agent directly.
  Check `context === webId` to select which side applies.

  > **Phase 5 amendment (landed).** The reciprocal read moved to a NEW
  > `SocialAgent.adminOf` field — "the signed-in user is an admin of this
  > agent" (the switcher source). `admin` is now the **direct** marker in BOTH
  > contexts — the context owner's registration of the agent carries a non-empty
  > `hasAdminGrant` — so a regular user's personal-context list also drives the
  > toggle-admin button (their OWN admins, Phase 5).
- The UI derives the **switcher list** from that personal-context list: personal
  context (own webId) + each agent where `adminOf === true`. The **label** shown
  in the switcher is the same `label` as the social agent's. *(Q6 — decided)*
- `ListSocialAgents` in the personal context is therefore the discovery call. It
  also lets the UI re-validate that a chosen context is still allowed.

### 2.3 Context on the RPC layer (`packages/api-messages`)

- Add a **required `context` field** (`IRI`) to each request that operates on a
  registry. The client sets it; when the user has not switched context it **defaults
  to the user's own webId**. Services use it to select the target org and owner
  identity.
- **Personal-only requests (no `context`)** — start with: `BootstrapAccount`,
  `CheckHandle`, `GetWebId`, `RegisterPushSubscription`, and the discovery call
  (personal-context `ListSocialAgents` used to compute contexts). *(C3 —
  starting list, refine in next iteration.)*
- `ListSocialAgents` returns `SocialAgent[]` with the `admin` boolean (direct
  marker, both contexts) and the `adminOf` boolean (reciprocal marker — the
  switcher source, Phase 5).

### 2.4 Backend / service refactor (`packages/components/src/services/*`, `ApiHandler`)

- Introduce a **context struct** for services, e.g.
  `{ webId /* owner */, registrySet }`, resolved from the request's `context`.
  **`session.webId` stays unchanged** — the owner identity for writes comes from
  the context, not by mutating the session.
- **Registry sets as a map keyed by webId.** Instead of a single `registrySet`
  on the session, hold a `Map<webId, RegistrySet>`. To stay consistent with the
  current implementation, the **user's own registry set is eager-loaded** into
  the map; every other context's registry set is **lazy-loaded on demand** when
  first used.
  **Sessions are short-lived** (one per request or per temporal activity), so
  this map lives for the lifetime of a single session — there is **no
  cross-request cache to invalidate** when an admin is added/removed; the UI
  refresh (2.5) covers user-visible staleness.
- Replace uses of `saiSession.webId` (as *owner*) and `saiSession.registrySet`
  (as *target*) with context values when outside the personal context; in the
  personal context they collapse back to the user. This also applies to
  peer-scoped services such as `getDataRegistries`/`getAuthorizationData`: they
  take the `context` and use it **instead of `saiSession.webId`**, because the
  read is from the perspective of the **context org**, not the admin user.
- **Context authorization.** Every service method called from `ApiHandler`
  *validates first* that the requested context is allowed for the user — the
  personal context always; an org context only if the user is an admin of it
  (reciprocal registration `isAdmin`) — otherwise respond with an error before
  touching any registry. *(Q1/Q4 — decided)*
- **Registry-set resolution (proposed mechanism — iterate).** The org's registry
  set is currently stored in CSS internal storage and reached through
  CSS-specific handlers; the user's own session reaches it via `registryId(webId)`.
  Proposed concrete mechanism: **add a second `Link` response header to
  `AgentIdHandler`** when the requesting agent is an admin of the org whose
  agent-id document is requested.
  - `AgentIdHandler` already builds the org's session and — for a requesting
    agent who is not the owner — lands in the `findSocialAgentRegistration`
    branch (YoYo's registration of Dan). After that lookup, if the registration
    carries the admin marker (`hasAdminGrant`), add
    `<${sai.registrySet.id}>; rel="${INTEROP.hasRegistrySet}"` alongside the
    existing `registeredAgent` link. Only admins get this second link.
  - Requires a new `hasRegistrySet` rel term in `packages/utils/src/namespaces.ts`
    (the vocab has no predicate pointing at a RegistrySet from an agent doc).
  - The admin client fetches the org's agent-id doc (already reachable via
    authorization-agent discovery), reads the header, and lazy-loads the
    RegistrySet into the webId-keyed map using its own (ACR-authorized) fetch.
  - **Federated nuance:** this is a federated system — the **org's authorization
    agent may live on a different server than the admin's**. The org's AA is the
    one that responds from `AgentIdHandler` (serving the org's agent-id doc /
    registry-set link) and the one that subscribes to the org's Activity Registry
    and runs the required temporal workflows. Our UI interactions mostly go
    through the **admin's** AA; the registry-set link comes from the **org's**
    AA. The header therefore carries the authoritative registry-set IRI across
    servers.
  - This complements context discovery: `listSocialAgents.admin` (which
    contexts) + the header (how to load one).
  This part is expected to change through implementation. *(C2 — iterate)*

### 2.5 UI refactor (`ui/authorization/`)

- Add a **context switcher** to the default layout: "Personal context (my
  webId)" plus one entry per administered org (from `ListSocialAgents.admin` +
  label).
- **`effect.ts` sends the selected `context`** (defaulting to the user's webId) with
  every applicable RPC.
- **All registry-backed views become context-aware** — social agents, roles,
  applications, data registries, authorizations — so switching context re-targets
  them to the org's registries. During implementation, identify which views make
  no sense in an admin context and exclude them. *(Q5 — decided, iterate)*
- **Toggle-admin button (moved up from the §6 UI follow-up).** On each social
  agent in the org's context, a toggle-admin button calls the `AddAdmin`/
  `RemoveAdmin` RPC methods (§3.4) to promote/demote the agent, then refreshes
  the list from the returned `SocialAgent` (and the badge from the new `admin`
  field).
- **Context switcher and the toggle-admin button are separate UI concepts.** The
  **context switcher** changes the current context the whole UI operates in. The
  **toggle-admin button** (on a social agent in the org's context) lets one admin
  add/remove *other* admins. They are **not** mixed or reused: the toggle manages
  the admin flag on another agent; the switcher selects which context the UI is
  currently operating in.
- **Keeping the switcher/admin list fresh (event-driven).** The UI already
  subscribes to activity-registry events. When a reciprocal registration is
  updated (e.g. the org's registration of the user gains/loses its admin marker,
  `hasAdminGrant`), `ReciprocalWebhookHandler` writes a `delegatedGrantsUpdated`
  activity to
  the admin's Activity Registry. After that activity completes, the resulting
  event is **forwarded to the UI**, which re-runs `loadSocialAgents` to recompute
  the switchable contexts and `admin` flags. Combined with short-lived sessions
  (§2.4), this keeps the switcher in sync without a long-lived cache.
  **Dual cause — acceptable for now.** A reciprocal-registration `Update` covers
  both grant changes and admin-flag changes; we deliberately reuse the same
  `delegatedGrantsUpdated` activity for both rather than distinguishing them.
  This is fine for now — the re-run is cheap and idempotent. It may need further
  optimization later (see §2.8) via caching/diffing to know the actual change,
  e.g. so the UI refreshes only the switcher on an admin-flag change instead of a
  full `loadSocialAgents`.

### 2.6 Decisions recorded

- **(C1)** In an admin context the org is `dataOwner`/`grantedBy` and the ACR
  owner; the admin only authenticates.
- **(C2)** Keep the user's AuthorizationAgent; `session.webId` is unchanged and
  owner identity comes from the context. Registry sets are held in a **map keyed
  by webId** — the user's own is eager-loaded, others lazy-loaded on demand.
  Resolution mechanism: a second `Link` header on `AgentIdHandler` exposing the
  org's RegistrySet IRI to admins (needs a `hasRegistrySet` rel). The org's AA may
  be on a **different server** than the admin's — the org's AA serves the
  registry-set link and runs the Activity Registry workflows. — **iterate** on
  this.
- **(C3)** Personal-only RPC starting set: `BootstrapAccount`, `CheckHandle`,
  `GetWebId`, `RegisterPushSubscription`, + discovery — **refine**.
- **Context is required** on applicable requests, defaulting to the user's own
  webId.
- **Toggle-admin and context switcher are separate UI concepts** and are not
  mixed or reused.
- Discovery of switchable contexts via `ListSocialAgents` `admin` bool + reuse
  of the agent's `label`; `admin` is read from the org's registration of the
  agent (reached via `reciprocalRegistration` in the personal context, directly
  in an org context) — the marker is the `hasAdminGrant` link.
- **`AddAdmin`/`RemoveAdmin` are admin-only**, and `removeAdmin`/the UI refuse
  to remove the last admin.
- **Peer-scoped services use `context`, not `saiSession.webId`**, since reads are
  from the perspective of the context org.
- **Short-lived sessions** (per request / per temporal activity): the webId-keyed
  registry-set map needs no cross-request invalidation.
- **UI freshness is event-driven**: a reciprocal-registration update →
  `ReciprocalWebhookHandler` `delegatedGrantsUpdated` activity → forwarded to the
  UI after completion → re-run `loadSocialAgents` to recompute admin flags and
  switchable contexts.

### 2.7 Testing

- **Context authorization:** a user cannot target a context they don't admin
  (RPC returns an error); the personal context is always allowed.
- **Owner identity:** acting in an org context creates grants/authorizations
  with `dataOwner`/`grantedBy` = the org, and registration ACR `fullOwnerAccess`
  = the org, while the write is authenticated by the admin's UAS (matched by
  `fullAdminAccess`).
- **Discovery/UI:** personal-context `ListSocialAgents` flags admins; the
  switcher offers exactly personal + administered orgs.
- **Admin gating:** `AddAdmin`/`RemoveAdmin` succeed only when the caller is an
  admin of the context org; a non-admin is rejected before any mutation.
- **Last-admin guard:** `removeAdmin` (and the UI toggle) refuse to remove the
  last admin; the org never ends up adminless.
- **Context perspective:** in an org context, `getDataRegistries`/peer reads use
  the context org, not the admin's webId, as the perspective.
- **Event-driven refresh:** when the org updates the user's reciprocal
  registration admin marker, `ReciprocalWebhookHandler` emits a `delegatedGrantsUpdated`
  activity that is forwarded to the UI after completion, re-running
  `loadSocialAgents` and updating the switcher/admin flags.
- **Seed-driven e2e:** Dan logs in, switches to YoYo context, and can operate on
  YoYo's registries (the `ph8e70` + `fullAdminAccess` seed already enables the
  ACR path).

### 2.8 Open items to resolve during implementation

- Exact shape of the `context` field on each request and the context struct
  (required, defaults to user's webId).
- How to resolve a non-user context's registry set (C2): proposed `AgentIdHandler`
  second `Link` header (`<registrySet>; rel="interop:hasRegistrySet"`) for admins;
  needs the `hasRegistrySet` rel term; the org's AA (possibly another server)
  serves it and runs the Activity Registry workflows. Verify against CSS internal
  storage.
- Registry-set link goes in the **response `Link` header, not the body** — the
  header is evaluated against the request credentials (so the admin-only link can
  be gated on `isAdmin`), whereas the agent-id document body is currently public.
- Final list of personal-only RPCs (C3).
- Which views are excluded from admin context (Q5).
- **Admin access to data registries / data instances — moved to step 2.8** (design fixed by R1 pickup; implementation pending — §2.10).
  In an org context an admin reaches the org's *structural* registries via ACP
  (`fullAdminAccess`), but `listDataRegistries` / `listDataInstances` are served
  by the **data service** and gated by the `SaiPermissionsEngine` — admins
  currently have **no** permission there. The
  `TargetType.Registry` TODO in `SaiPermissionsEngine.ts:42` is the hook (R1:
  the Read-only `DataRegistry`-scoped AdminGrant consumed by the engine).
  `shareResource` may also be affected if it needs to read a data instance
  (e.g. to display a label) before it can share — a peer/org-context
  `shareResource` must resolve that instance through the same permission path.
- **Optimization (future):** distinguish the reason a reciprocal registration was
  updated (grant change vs. admin-flag change) instead of reusing
  `delegatedGrantsUpdated` for both — likely requires some **caching and diffing**
  of the registration to know the actual change, so the UI can refresh only what
  is affected (e.g. the switcher, not the whole social-agents list). Accepted as
  a known limitation for now.

### 2.9 Revision R2 — Phase-2 implementation notes (supersedes where they conflict)

Everything below is what **landed** in Phase 2; where it conflicts with §2.1–§2.8 above, R2 wins. Phase 4 must record the same model.

- **Org-context execution — the org's own AA runs the operations (C2 iterated).** `resolveContext` (`packages/components/src/services/Context.ts`, the single central gate called by `ApiHandler` for every context-bearing RPC) does three things in an org context: (1) validates the admin marker (reciprocal `hasAdminGrant`, from the *user's* session); (2) resolves the org's RegistrySet IRI via the admin-only `hasRegistrySet` header (`AuthorizationAgent.getRegistrySet`, per §2.3 — unchanged); (3) builds the **org's own session** (`SessionManager.getSession(org, registrySetId)`) — the org's UAS, the same identity the org's Temporal workflows and peer-facing reads use. The org is actor + data owner; the admin only *authorizes entry*. Rationale (proved by e2e): peer/reciprocal registrations grant read to the **org**, not the admin — executing as the admin 403s (e.g. `registry/bob/agent/n4m8qx/` from YoYo's registration of Bob). Consequences: `creator` on writes becomes `{ agent: org, client: org's UAS }`, matching how the org's workflows already write; the webId-keyed registry-set map serves only the *resolution* half; no per-service context struct `{webId, registrySet}` was introduced — services keep operating on a session (the org's), with a `personal` flag added only for the admin-marker asymmetry in `buildSocialAgentProfile` (§2.2).
- **C3 personal-only set corrected.** `ListSocialAgents` **is** context-aware (org-context lists feed the toggle-admin UI); the *personal invocation* is the discovery call. `GetUnregisteredApplication` stays context-less (no registry targeting). The rest of the C3 list is unchanged.
- **AddAdmin/RemoveAdmin are context-targeted (delivers the §3.9 gate).** Both take `context` and are gated by `resolveContext` — the Phase-1 "non-owner admin gate lands with Phase-2 context authz" hand-off is now in place.
- **Temporal worker registration — Phase-1 gap found in Phase 2.** The admin workflows (`createAdminGrants`/`revokeAdminGrants`/`syncAdminAcr`) were never registered on any worker, so `ActivityWebhookHandler` scheduled them into a queue nothing polled. The `create-grants` queue now bundles a combined module `temporal/workflows/create-grants.ts` (grants + admin) with the merged activities set. Extending §3.7's test-infra note: any workflow module used by the handler must be added to that bundle + activities.
- **Q5 — no views excluded.** All registry-backed views re-target the switched context; push-subscription/settings remain personal by design. Revisit per-view exclusions later if org-context data views need it.
- **§2.8 data-registry access — engine item moved to step 2.8 (§2.10).** The data service's `SaiPermissionsEngine` admin branch (`TargetType.Registry` TODO) is now its own step before Phase 3 — needed for *admin-credentialed* access to the org's data (org-context service reads already run as the org owner; validate that owner-side read in 2.8/Phase 4).
- **UI.** Switcher derives from personal-context `ListSocialAgents.adminOf` + label; toggle-admin lives in the org context with the last-admin disable — as planned (§2.5). **Phase 5 amendment:** the toggle also renders in the personal context (a regular user promotes/demotes their own admins); the last-admin disable stays org-only (`admin` is the direct marker there too).

### 2.10 Step 2.8 spec — org data access via the permission engine (R1 pickup)  *(implemented)*

Moves the §2.8 "admin access to data registries / data instances" item out of
*open* into an executable step **before Phase 3**, on the R1 design: the
Read-only `DataRegistry`-scoped AdminGrant is the engine's input, and
`getAuthorizationData` already collects grants by `?s <interop:hasStorage>
<storage>`, so the pickup is local to the engine.

- **Goal.** An admin holding a Read-only `DataRegistry`-scoped AdminGrant for an
  org's storage can read (and list) that org's data-registry /
  data-registration / data-instance resources **with their own UAS credentials**
  through the data service. Structural registries stay on ACP (`fullAdminAccess`).
- **Engine changes.** In `SaiPermissionsEngine.getPermissions`, after the owner
  fast-path (`AdminPermissionReader` — admins are not owners, they fall through
  to the engine): when the target resolves to a storage the requester holds an
  AdminGrant for (`TargetType.Registry`, plus the matching Registration/Resource
  targets under that storage), grant `acl:Read` only. Replace the empty
  `TargetType.Registry` `break` (`SaiPermissionsEngine.ts:42`) and mirror in
  `SaiAuthorizationManager.ts:62` (`// TODO: add statements about
  admins/trusted grants`). No Write/Create/Delete for admins via this path.
- **Scope boundary.** The Phase-2 org-context *service* path already runs as the
  org (owner) — this step covers **admin-credentialed** access: direct data-
  service calls with the admin's own UAS, `shareResource` label resolution in an
  org context, and future engine-driven flows.
- **Verification (e2e).** With the seed's Dan-as-YoYo-admin + the `ds0emv`/
  `f76tbp` Read-only AdminGrants (per data registry): Dan, with his own UAS
  session (`buildOidcSession(danId)`), GETs `https://data/yoyo-eu/` and a data
  registration under it → 200 (Read); a non-admin peer (e.g. Bob) → 403; no
  admin Write path (PATCH → 403).

---

## Phase 3 — admin events forwarding (WebhookHandler reuse)

Closes the Phase-2 events gap: the admin UI must learn about org-context
activity outcomes. `ActivityWebhookHandler`
(`packages/components/src/ActivityWebhookHandler.ts`) is currently the
**owner's** handler — it looks up the channel, loads the activity, forwards to
the events bus **and** runs the workflow for each `Add`. Admins watching the
org's Activity Registry only need the **forwarding** half; the org's owner
subscription keeps running workflows (per §2.6 C2 the org's AA runs the org's
workflows). The two halves are already cleanly separated in the handler:

- **forwarding (shared):** the block that calls
  `activityEvents.onActivityAdded(channel.webId, ...)` for both `pending` and
  `done` — currently keyed by `channel.webId`;
- **workflow dispatch (owner-only):** the `GRANTEE_ACTIVITY_TYPES` branch, the
  `ADMIN_ACTIVITY_TYPES` branch and the `activityWorkflows` branch after it.

> **R3 — decisions (supersede the open options below; Phase 4 must record the
> same model).** The admin's UI stream is **unchanged** — `EventsHandler` still
> subscribes the browser stream under the account's own webId
> (`webIdLinks[0]`, the admin). Org-context events reach that stream via
> **separate webhook channels per (admin, org)**: a CSS-side
> `WebhookChannel2023` on the org's Activity Registry container plus an
> `ActivityWebhookStore` record with `webId` = the admin (the `ActivityEvents`
> keying target), `topic` = the org's Activity Registry, `accountId` = the
> admin's account. The same `ActivityWebhookHandler` serves both channel kinds
> — an admin channel is recognized by the ownership check (§3.1) and forwards
> only. Dev/test seed the channels in `environments/data/kv.json` (both dan
> channels, §3.2); real deployments create/remove them with the admin-grant
> lifecycle (`AddAdmin`/`RemoveAdmin` — `webhook-subscription-bootstrap.md`
> §4.6).

### 3.1 Extract the forwarding half *(decided: Option A — reuse `ActivityWebhookHandler`)*

When the subscription is from an **admin** and not the registry owner, forward
only and skip workflow dispatch. The handler knows which scenario an incoming
webhook is for without a schema change or a second route: after
`findBySendTo` it builds the channel webId's session (already done to load the
activity) and compares that webId's **own** Activity Registry with the
subscribed topic —

```ts
const session = await this.sessionManager.getSession(channel.webId)
const isRegistryOwner = session.registrySet.hasActivityRegistry?.id === channel.topic
```

- **owner channel** (`isRegistryOwner` — e.g. alice/bob/kim/yoyo on their own
  registry): forward (keyed by `channel.webId`) **and** dispatch workflows —
  unchanged;
- **admin channel** (not owner — e.g. dan on `https://registry/yoyo/activity/`):
  forward (keyed by `channel.webId` = the admin, landing in the admin's UI
  stream) **only**, return 200 before any dispatch branch.

The forwarding block is extracted into a helper both paths share. Option B
(`AdminWebhookHandler` + shared module) is rejected: it would duplicate the
channel lookup / activity loading / forwarding and add a second route to convey
the same information the ownership check already provides.

### 3.2 Admin subscription recognition + event keying *(decided: separate channel per (admin, org); supplements §2.5)*

An admin subscription is a **separate webhook channel** — not a tag on the
owner's — stored in the same `ActivityWebhookStore` table as the owner channel
(schema unchanged; `findBySendTo` stays the lookup): `webId` = the **admin**,
`topic` = the org's Activity Registry container, `accountId` = the admin's
account. Recognition is the §3.1 ownership check — a channel whose webId is
not the topic's owner is an admin channel. Events are keyed by `channel.webId`,
i.e. the **admin's** webId, so they land in the admin's own UI stream
(`ActivityEvents` is keyed by webId).

This **supplements, does not replace**, the §2.5 reciprocal-observer refresh:
`delegatedGrantsUpdated` (the admin's personal registry channel, triggered by
the org's update of the admin's reciprocal registration) keeps covering the
admin's *own* admin-status changes; the org channels add live `pending`/`done`
for every org-context workflow outcome, closing the §2.6 events gap noted in
§2.8. The admin UI thus receives two event sources on one stream:
personal-registry activities (own channel) + org activities (one channel per
administered org).

A newly promoted admin (no org channel yet — runtime channel creation is
`webhook-subscription-bootstrap.md` §4.6) still learns about the promotion via
the §2.5 reciprocal path: the `hasAdminGrant` PATCH on the org's registration
of them fires their **reciprocal webhook channel** → `delegatedGrantsUpdated`
in their own Activity Registry → their personal channel forwards it. The seed
therefore also includes **bob's reciprocal channel on YoYo's registration of
him** (`https://registry/yoyo/agent/z3k7wm/`, §2.5 infrastructure).

Seed (§3.6 addition): **both dan channels** land in `environments/data/kv.json`
— dan's **personal** channel (`webId` dan, `topic`
`https://registry/dan/activity/` — dan's registry set has its own Activity
Registry) and dan's **YoYo admin** channel (`webId` dan, `topic`
`https://registry/yoyo/activity/`), alongside the existing yoyo owner channel
on the same topic. Two channels on one topic → two `Add` deliveries; only the
owner one dispatches workflows.

### 3.3 Wire admin events into the UI *(decided: current-context refresh; full refresh on switch)*

The admin UI subscribes to the org's Activity Registry events through the
same `/.sai/events` stream — no new stream, the server emits under the admin's
webId (the channel's webId). Refresh behavior in `ui/authorization/src/events.ts`:

- **only the current context refreshes.** A `done` event refreshes views when
the event's registry owner (`payload.webId`) equals the current context —
organizational events refresh org-context views while the user operates in
that org; events for any other context are ignored (`switchContext` already
performs a full store refresh, so no cross-context refetch is needed);
- the done-mapping gains `adminAuthorizationGranted` /
  `adminAuthorizationRevoked` → `listSocialAgents` (admin flags in the
  org-context agent list — closes the toggle-admin follower);
- `pending` stays ignored (optional "applying…" indicator, out of scope).

Example: Dan promotes Bob in the YoYo context → the RPC writes
`adminAuthorizationGranted` → yoyo's owner channel dispatches the grants/ACR
workflows while dan's YoYo channel forwards `pending`/`done` into dan's stream
→ `listSocialAgents` reruns against the YoYo context and Bob's admin flag
appears without a manual refresh.

No new admin-side reachability work: the admin's UAS can already read the
org's Activity Registry via `#fullAdminAccess` (structural registries), and
the channels are pre-seeded (real deployments: runtime creation per
`webhook-subscription-bootstrap.md` §4.6).

---

## Phase 4 — update the architecture docs for org context

`peer.md` and `social-graph.md` both encode assumptions the org-context feature
(Phases 1–3) changes. Update them once the implementation has landed, reflecting
the **actual** Phase-3 forwarding approach rather than the options above. Most
of the org-admin behavior is consistent with the docs already; the changes below
reflect only what the feature *breaks* or leaves undefined.

### Already consistent — do not change

- Admin-marker change on the org's registration of the user is a reciprocal
  `Update` → `ReciprocalWebhookHandler` → `delegatedGrantsUpdated`
  (peer.md producer/consumer tables; social-graph §2 polarity). **No new
  activity type** — the producer/consumer tables in peer.md stay as-is except
  for the org-context notes below.
- The admin marking lives on the org's registration of the user (the
  `hasAdminGrant` admin marker), reachable via the `reciprocalRegistration`
  link from the user's own registration — matches the existing reciprocal
  convention in social-graph §5 and the §3.6 seed (`ph8e70` carries the
  `hasAdminGrant` marker to `vbg74v`, `zdujx0` does not).

### peer.md — "a single peer" must stop assuming one peer = one registry set

1. **Multi-registry-session org context.** Add a section: in an org context the
   admin (own UAS/AuthAgent) operates on the **org's** registries — owner =
   org (context, per C1), client = the admin's UAS (matched by
   `fullAdminAccess`). `session.webId` and the admin's own registry set are
   unchanged; the org's registry set is lazy-loaded into a webId-keyed map,
   per short-lived session (§2.4/2.6 C2).
2. **Outbox & events ownership in org context (implemented in Phase 3).**
   Layer diagram §1 and EventBus §5 key events by the **admin's** webId
   (`webIdLinks[0]`). Org-context activities land in the **org's** Activity
   Registry and are processed by the **org's** AA/workflows (§2.6 C2), so their
   `pending`/`done` events are keyed by the *org* webId — not the admin's
   stream. Document the Phase-3 solution for how the admin UI learns about
   org-context workflow outcomes — **R3: same-handler admin channels,
   forward-only, keyed by the admin's webId, supplementing (not replacing)
   the §2.5 `delegatedGrantsUpdated` refresh** (see R3 block under §3).
3. Update the layered-diagram actor label: a registered admin is a *client of
   another peer's registries*, not the owner of the registries it mutates (C1).
4. **Producer-table rows for the admin activities (Phase 1).** `AddAdmin`/
   `RemoveAdmin` *do* write org-context activities —
   `adminAuthorizationGranted` / `adminAuthorizationRevoked` (§3.7) —
   processed by the **org's** AA/workflows. Add those two rows to the peer.md
   producer/consumer tables (the earlier "write no activity" note no longer
   applies).

### social-graph.md — new org↔admin edges

1. **§3 `AgentIdHandler` extension.** Document the new admin-only `Link` response
   header (`<registrySet>; rel="interop:hasRegistrySet"`) on the **org's**
   agent-id doc when the requester is an admin (header-gated via `isAdmin`;
   body stays public), plus the new `hasRegistrySet` rel term. Note the org's
   AA — possibly on a **different server** than the admin's — serves it and
   runs the org's Activity Registry workflows (federated case).
2. **New relationship: org member (admin).** Add the org↔admin pair to the tier
   table / edge inventory: the admin performs Tier-3 reads/writes against the
   org's registries with its own UAS but the **org** as data owner; the org's
   AA is the peer whose handlers (`AgentIdHandler`, Activity Registry
   workflows) serve the org's registries. State explicitly it is federated
   when the two AAs are on different servers.

### Consistency checks to run before closing Phase 4

- Grep both docs for single-registry-set assumptions where the admin now acts
  for the org (owner = org, not the session's webId; one peer may touch multiple
  registry sets) and update each occurrence.
- Update doc tables/edge inventories that enumerate actors, activities, and
  endpoints to reflect org-context operation and the new `AgentIdHandler`
  admin link.
- Confirm the resolved events/outbox story (peer.md item 2) is reflected in
  both documents so they do not silently drift from the implementation.

---

## Phase 5 — personal-context add/remove (a regular user manages their own admins)  *(implemented)*

`AddAdmin`/`RemoveAdmin` now work for a **regular user** in their personal
context (features.md §4: the data owner runs them in the personal context —
`resolveContext` allows it without any admin marker). Kim promotes Alice
(registered agent `plp3a3` in Kim's registry) to admin of Kim's registry set;
the owner (Kim) remains the operator afterwards. E2e: `personal-admin.test.ts`.

- **RPC — the last-admin guard is owner-aware.** `removeAdmin`
  (`packages/components/src/services/Admin.ts`) keeps the guard for ORG
  contexts (`ctx.webId !== ctx.userWebId` — the org must never end up
  admin-less) and skips it in the personal context: the owner always remains
  the operator of their own registry set, so demoting the only admin is
  legitimate.
- **Workflow — `syncAdminAcr` handles the empty admin list**
  (`packages/components/src/temporal/activities/admin.ts`): an EMPTY list
  writes the ACR with the `#fullAdminAccess` access control removed entirely
  (derived rewrite: zero admins → zero admin access; a personal last-admin
  demotion must not leave the activity stuck `pending` by refusing). For orgs
  the RPC guard prevents reaching this state through the UI.
- **ACR wiring is now part of the derived rewrite.** The rewritten
  `#fullAdminAccess` is wired into the `.acr` `#root`
  (`acp:accessControl` + `acp:memberAccessControl`), remove-then-add
  idempotent — a context whose seed never wired it (e.g. Kim's personal `.acr`,
  which only holds `#fullOwnerAccess`) gets the enforcement on the first
  promotion; demotion removes both the control and its wiring.
- **`SocialAgent.admin` semantics changed; new `SocialAgent.adminOf` field.**
  `admin` is now the DIRECT marker in BOTH contexts (the context owner's
  registration of the agent carries a non-empty `hasAdminGrant`) — the
  toggle-admin state everywhere. The RECIPROCAL marker (the agent's
  registration of the user) moved to `adminOf` — the personal-context switcher
  source (orgs the user administers, §2.2). UI: `listSocialAgents` filters the
  switcher on `adminOf`; the toggle-admin button renders in the personal
  context too (its org-only last-admin disable stays).
- **ListSocialAgents-driven state.** After an `AdminAuthorizationGranted`/
  `Revoked` done-row refresh, the personal list shows the promoted/demoted
  agent with `admin` flipped. The reciprocal `adminOf` never flips on a
  promotion of the user's OWN admin — the switcher is untouched by it (no
  `delegatedGrantsUpdated` churn).
