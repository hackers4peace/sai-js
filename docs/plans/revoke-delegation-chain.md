# Revoking access — workstream

> **Status:** 🔶 in progress — **C0 (authorization view), C1 (chain validity +
> closure), C2 (authorization revocation end-to-end), C3 (projection + GC
> reconciliation), and C4 (typed revocation errors + owner projection cleanup)
> are landed, package-tested, and `/test`-accepted (dagger green 2026-10-21).**
> C3 landed with C2: `reconcileGrantsForGrantee` is the `createGrantsForAgent`
> body, so every regeneration trigger gets it. **Grantee self-revocation is
> removed by design review (D17)** — grants are projections of authorizations;
> the future options are grantee-side **shadowing** and a **need-based-style
> revocation request** to the owner. **C5 (sweep backstop) is the last open
> slice.** The old `revoke-delegation-chain-follow-ups.md` (absorbed here as
> C0–C5) and `authorization-revoked.md` (absorbed into the detailed design)
> were deleted.
> **Last verified:** `2381ecd2` (2026-10-21) — C0–C4 landed and committed,
> package-tested, and `/test`-accepted (dagger green); D17/D18 removals
> (grantee self-revocation, owner `RevokeGrants` RPC) are included.
> **Green gate:** [§13 Verification](#13-verification). **Session protocol:**
> [CONVENTIONS.md](CONVENTIONS.md).
> **Detailed design for C0/C2:**
> [`authorization-revocation.md`](authorization-revocation.md). **Landed design
> references:** OpenWiki `services/activity-lifecycle.md`,
> `architecture/grant-reuse.md`, `data-model/entities.md`.

This is the single entry point for revoking access. The workstream has two
kinds of state: **authorizations** (the mutable source of truth, owned by the
authorization agent) and **grants** (derived projections, stored in the data
owner's grant registry). Every capability below follows from that split.

## 0. Invariant

1. **Authorizations are the mutable source of truth.** Grants are projections
   derived from the authorization registry state. The UI authors authorizations
   and never grants.
2. **Grants are revoked only by** (a) the data owner's delegation boundary
   (`AccessRevocation`) or (b) a workflow running with the owner/context
   session. There is no UI grant-revoke action and no cross-peer DELETE.
3. **Enforcement is the grant registry.** `SaiPermissionsEngine` →
   `SaiAuthorizationManager` collects every grant resource with `hasStorage`
   pointing at the pod. A grant that still exists still confers access, even if
   no registration links it. Removing a grant from the projection is not
   revocation.
4. **Registration `hasDataGrant` links are projections**, not enforcement. They
   are eventually consistent (webhook cascade + sweep); enforcement is fixed
   immediately by the registry delete.
5. **Chain validity is match-based**, not a `delegationOfGrant` link. A grant
   is valid iff it is rooted at a source grant (`grantedBy == dataOwner`) or has
   a valid upstream grant that covers its grantee/shape tree/registration/
   scope/modes (C1).
6. **Grants are immutable; replacement = delete old + create new.** A leftover
   old grant keeps conferring access. Replacement is not propagation: an
   upstream replacement with covering semantics re-anchors downstream grants by
   the predicate; only semantic weakening needs downstream removal.
7. **Revocation is idempotent.** Revoking an already-removed grant or
   authorization is a no-op success; the response echoes the request.
8. **Sweep signals are 200-semantics projections**, never status probes of
   deleted resources (403/410 ambiguity). Owner-unreachable is `stale — retry`,
   never revocation.
9. **Every slice leaves the repo green**: package tests + typecheck. Root
   `/test` acceptance is user-run (CONVENTIONS §7).

## 1. State map

| Capability / primitive | Status | Code anchors | Verified by | Notes |
|---|---|---|---|---|
| Boundary contract + endpoint dispatch | ✅ landed | `packages/data-model/src/access-revocation.ts`, `packages/data-model/src/access-request.ts`; `packages/components/src/messages.ts`; `GrantIssuanceHandler.ts` (`isAccessRevocationMessage`) | `packages/components/test/messages.test.ts`; `/test/delegation-endpoint.test.ts` | `AccessRevocation.grants` = grant IRIs only; `AccessRequest.grants` = full objects; `type` is an array |
| Owner revocation core | ✅ landed (superseded by C1/C4) | `AuthorizationAgent.revokeGrants` (`packages/authorization-agent/src/authorization-agent.ts`); `getGrantsAuthority` (`sparql.ts`); typed refusals (`revocation.ts`) | `packages/authorization-agent/test/authorization-agent.test.ts` (`revokeGrants core`) | Validate-all-first; authority grantor/owner only (grantee self-revocation removed — D17); the pre-C1 closure was listed + `inheritsFromGrant` children only — C1 replaced it with the chain closure; C4 typed every refusal |
| HTTP revocation handler | ✅ landed (acceptance confirmed 2026-10-21) | `packages/components/src/GrantRevocationHandler.ts` | `/test/delegation-endpoint.test.ts` | Idempotent echo; all-or-nothing over the **requested** set (B2 fixed); typed code + JSON body on refusal |
| Owner UI RPC | ✅ retired (D18) | deleted: `services/Revocation.ts`, `RevokeGrants` (`api-messages`); the boundary handler stays | `/test/delegation-endpoint.test.ts` (boundary) | B1 fixed (owner-endpoint-bound closure core) and B2/B6 fixed in C4; the RPC was an internal escape hatch with no UI caller and was deleted — the boundary is projection transport only |
| Grant ACR owner-only write | ✅ landed (acceptance confirmed 2026-10-21) | `packages/data-model/src/acr.ts` (grantor `ACL.Read` only) | `/test/delegation-endpoint.test.ts` (direct DELETE → 403) | The grantor cannot delete a grant resource |
| Authorization read model + UI | ✅ C0 landed (acceptance confirmed 2026-10-21) | `findAuthorizationsForGrantee` (`authorization-agent/src/sparql.ts`, context-aware) + class method `findAuthorizationsForAgent`; `listAuthorizations` (`services/Authorization.ts`, `sparqlTransportFor(ctx)`); `ListAuthorizations` (`api-messages/src/effect.ts`); `ui/authorization/src/views/Authorizations.vue` | `packages/components/test/authorizations.test.ts`; AA `findAuthorizationsForAgent` test; `test/authorizations.test.ts` (user-run); `npx vite build` | Read-only; shape-tree labels fall back to the IRI; the UI `vue-tsc` baseline is red, so the UI gate is `vite build` |
| Chain predicate + full closure | ✅ C1 landed (acceptance confirmed 2026-10-21) | `grant-chain.ts` (`grantChainValidity`, `invalidGrantsAfterRemoval`, coverage lattice); `getRegistryGrants` (`sparql.ts`); `AuthorizationAgent.revokeGrants`; `GrantIssuanceHandler.validateDelegable` | `packages/authorization-agent/test/grant-chain.test.ts`; AA `revokeGrants core` test; `/test/delegation-endpoint.test.ts` (user-run) | Rooted reachability (fixed point, no cycle bootstrap); same predicate for issuance and revocation; `findDelegableGrant`/`findInheritingChildren` removed |
| Authorization revocation end-to-end | ✅ C2 landed (acceptance confirmed 2026-10-21) | `revokeAuthorizations` (`services/Authorization.ts`); `AuthorizationRevoked` carrier (`data-model/activities.ts`, `activity-registry.ts`, `api-messages`); `processAuthorizationRevoked` + `reconcileGrantsForGrantee` (`workflows/grants.ts`); handler/sweep routing; UI selection + revoke (`Authorizations.vue`) | `authorization-revocation-workflow.test.ts`; activity-registry carrier test; `test/authorization-revocation.test.ts` (user-run) | One activity per grantee with refs + grantee; the per-grantee consumer/signal is removed; DA deletion + projection GC + C1 closure |
| Projection reconciliation (reuse / replace / revoke) | ✅ C3 landed (acceptance confirmed 2026-10-21) | `reconcileGrantsForGrantee` (`workflows/grants.ts`); `getRegistryGrantsForGrantee`, `revokeGrantClosure`, `requestRevocations`, `dropGrantReplicas` (`activities/grants.ts`); ACR delete in `deleteDataGrants`; `dropGrantReplicas` (`GrantReplica.ts`) | `packages/components/test/grants-workflow.test.ts`; `check-equivalence.test.ts` | Delete-before-create; deny = empty desired set; own-registry orphan scan; peer-side orphan scan remains (C5) |
| Typed revocation errors + requested-set check | ✅ C4 landed (acceptance confirmed 2026-10-21) | `revocation.ts` (`RevocationError` + `grantRegistryOf`); `revokeGrantsClosure` (mixed-owner/wrong-data-owner on the **requested** set, authority grantor/owner); `GrantRevocationHandler` (`revocationFailureDescription`, per-requested-grant endpoint check); `AuthorizationRevocationFailure` + `toAuthorizationRevocationFailure` (authorization leg); AA codes → HTTP for the boundary | AA `revokeGrants core` (unauthorized/mixed-owner/wrong-data-owner/idempotent); `packages/components/test/revocation-errors.test.ts`; `/test/delegation-endpoint.test.ts` (error shapes) | B2 (mixed-owner all-or-nothing) and B6 (`S.Never`) fixed; no message matching. The boundary has no RPC schema (D18); `not-delegable` stays reserved for the issuance predicate. No grantee branch (D17) |
| Boundary-path owner projection cleanup | ✅ C4 landed (acceptance confirmed 2026-10-21) | `removeGrantsFromRegistrations` (`activities/grants.ts`); `revokeGrants` workflow (delete first, registration PATCH last) | `packages/components/test/grants-workflow.test.ts` | The owner's registration is what the grantee mirrors, so this PATCH is the grantee-mirror refresh signal; a role grantee has no registration (healed by reconcile/sweep). A projection sync, not a source-of-truth change (D14) |
| Grantee self-revocation | ⬜ removed (D17) | removed: AA grantee branch, `RevokeMyAccess` RPC, `revokeMyAccess` service, UI "Remove my access" | AA test that the grantee branch is unauthorized | Grants are projections; future options are grantee-side **shadowing** or a **need-based-style revocation request** to the owner (authorization leg) |
| Sweep backstop | 🔶 C5 (partial) | `reconcileActivities`, `reconcilePeerMirrors`, `forceMirrorSync` (`workflows/grants.ts`); `listGranteeRegistrations`, `listReciprocalRegistrations`, `findIncompleteReciprocalMirrors` (`activities/grants.ts`); `updateReciprocalMirror` no-op guard (`services/ReciprocalMirror.ts`); `replaceDataGrants` no-op guard | `packages/components/test/delegated-grants.test.ts`; `reciprocal-mirror.test.ts`; `/test/reconciliation.test.ts` | Pending drain + authorization-vs-projection drift + reciprocal-mirror repair/freshness landed; remaining: batch validation, peer-side orphan scan, stranded end-state check; **scheduling/cadence in `update-deployment.md` §F** |
| `delegationOfGrant` | ✅ retired | removed from model/generation/context | `check-equivalence` tests | Vocabulary term stays valid |
| `authorizationRecorded` / deny-as-revoke | ✅ retired | deny is `AuthorizationDenied` (pure decline) | `/test/authorization.test.ts` | Do not reintroduce revoke-on-deny |
| `grantsRevoked` / `processGrantsRevocation` | ✅ retired | no code references | OpenWiki `services/activity-lifecycle.md` | The typed carrier is `AuthorizationRevoked`; no revival |

## 2. Decision log

**D1 — Authorizations are the source of truth; the UI only works with
authorizations.** UI revocation targets DataAuthorizations, never grants. The
`RevokeGrants` RPC is no longer a UI operation. **Superseded by:** D18 — the
internal escape hatch was deleted (no UI caller, not a projection workflow).

**D2 — Revocation granularity: per grantee first.** The UI lists a peer/app's
authorizations and selects any subset (plus select-all). The producer writes one
activity per grantee; inherited authorizations are expanded into the activity at
write time. Roles use the same reader/RPC with the role as grantee (UI later).
**Pinned.**

**D3 — Carrier: refs `id + type` plus `grantee`.** `AuthorizationRevoked.object`
is an array of `{ id, type }` refs; `grantee` is an activity-level routing key.
`target` is dropped (admin precedent). The producer expands the inheritance
closure before writing, so the workflow never traverses after deletion. **Pinned.**

**D4 — Producer/consumer shape: RPC writes the activity; a dedicated workflow
materializes.** The RPC does validation reads and writes `AuthorizationRevoked`.
`processAuthorizationRevoked` deletes the authorizations, reconciles the grant
projections, and completes. The vestigial per-grantee consumer
(`processGranteeActivities` / `getPendingGranteeActivities`) is removed once
its last caller is gone. **Pinned.**

**D5 — `grantsRevoked` stays retired.** The grantor-side trigger is a direct
`requestRevocations` workflow activity (mirror of `requestDelegations`), not a
new outbox type. **Pinned.**

**D6 — Boundary operation (landed):** `interop:AccessRevocation` with grant IRIs,
authority branches (grantor by `grantedBy`, data owner), validate-all-first,
owner-session delete, idempotent echo, owner-only grant ACRs. **Pinned/landed.**
Details in §12.

**D7 — Chain predicate home and closure semantics:** one AA module; validity is
rooted reachability with visited-set termination; revocation removes every grant
that fails the predicate after the operation, not only `inheritsFromGrant`
children. Issuance validation and the sweep reuse the same predicate. **Pinned;
details in C1.**

**D8 — Replacement ordering and owner grouping:** delete-before-create (fail
closed, not open); group removals by `dataOwner` — local owner-session delete,
peer-owned via `AccessRevocation`; never run the old `deleteDataGrants` calls
with the grantor's session. **Pinned; details in C3.**

**D9 — Replica cleanup shares the grant lifecycle:** drop the issuer-side
replica graphs (parent and children, with their `meta:` twins) in the same
reconciliation step that removes the grants; never touch own registry graphs.
**Pinned; details in C3.**

**D10 — Sweep:** projection re-derivation is the primary signal; a batched
boundary validation is only for grants that remain desired but may have been
removed by the owner; owner-unreachable = retry, never revocation. **Pinned;
details in C5.**

**D11 — Typed errors:** AA returns a typed revocation error union; the HTTP
boundary maps it (`unknown`, `wrong data owner`, `unauthorized`,
`not delegable`, `mixed owner`), and the authorization leg's RPC uses
`AuthorizationRevocationFailure`. No message-substring matching.
**Pinned; details in C4.**

**D12 — `/test` acceptance is user-run.** A slice is `landed (acceptance
user-run)` until the user confirms the dagger run. **Pinned.** See CONVENTIONS
§7.

**D13 — Grant generation is a projection of authorizations with garbage
collection.** Desired grants are generated from the **authorization registry
state** (not the activity payload); `checkEquivalence` decides reuse;
`existing − reused` is the GC set, removed before creating the new ones. The
deny/empty-authorization case is the same path with an empty desired set (no
special short-circuit). GC is **two-pass**: (1) the affected grantee's
projection GC — source and delegated trees, grouped by `dataOwner`; (2) the C1
chain closure for other grantees whose upstreams were removed. GC also drops
the grant's ACR and the issuer-side replica graphs; the registration
projection PATCH is last. **Pinned; details in C2/C3.**

**D14 — The boundary workflow also clears the owner's projection.** The data
owner's registration of each grantee is the document the grantee mirrors, so
the owner-side `revokeGrants` workflow removes the removed grant IRIs from
`hasDataGrant` **after** the deletes (PATCH last, same as D13). That PATCH
firing the grantee's reciprocal webhook is what drops the grants from the
grantee's local mirror. A role grantee has no agent registration; its members'
links heal via `reconcileGrantsForGrantee`/the C5 sweep. **Pinned; details in
C4.** *(The grantee-authority clause of the original D14 is superseded by
D17: grantee self-revocation was removed.)*

**D15 — Typed revocation errors are the contract; no message matching.** The AA
`revocation.ts` union is `unknown` | `wrong-data-owner` | `unauthorized` |
`not-delegable` | `mixed-owner` (`RevocationError` carries the offending
`grants`). The `mixed-owner` check runs on the **requested** IRIs
(`grantRegistryOf`), before anything loads, which closes B2 (no partial
apply); a requested IRI whose pod cannot be resolved is `unknown`, a request
outside the targeted registry is `wrong-data-owner`, and an already-removed
grant in the right registry stays an idempotent echo. HTTP maps codes to
`400`/`403`/`409` with a JSON `{ code, grants, message }` body; there is no
grant-level RPC (D18). The authorization leg's producer errors use
`AuthorizationRevocationFailure` (`empty-selection`,
`not-a-data-authorization`, `mixed-grantee`, `unauthorized`). `not-delegable`
is reserved for the issuance chain predicate — no revocation path produces
it. **Pinned; details in C4.**

**D16 — C4 stays grant-level; durable grantee self-revocation is a separate
slice (B8).** *Historical:* the grant-level C4 branch deleted grants without
deleting the owner's authorization, so any later owner-side regeneration
(including the C5 sweep) re-derived the grant. Options considered: (A) delete
the requester's authorizations at the owner, (B) a durable "revoked by grantee"
marker, (C) accept re-issuance. **Superseded by:** D17 — grantee
self-revocation was removed entirely, so the durability gap no longer exists.

**D17 — Grantee self-revocation is removed; grants are projections only.**
Design review: grants are derived from authorizations, so a user action must
never delete a grant directly. The only revocation is the **authorization leg**
(owner/grantor context, C2): deleting the `DataAuthorization` makes the grant
projection GC remove the grant. Removed: the grantee authority branch in
`revokeGrantsClosure` (the boundary is grantor/owner only), the `RevokeMyAccess`
RPC, the UI "Remove my access", and the AA tests for it. The C4 boundary
workflow's owner-projection cleanup (D14) stays — it is a projection sync, not
a source-of-truth change. Future options (not slices yet): (1) **shadowing** —
the grantee hides unwanted grants in its own view/mirror without touching the
owner's state; (2) a **need-based-style revocation request** — the grantee asks
the owner to revoke its authorizations, and the owner's workflow runs the C2
authorization leg. **Pinned.**

**D18 — No grant-level RPC; the boundary is projection transport only.** The
`RevokeGrants` RPC and `services/Revocation.ts` are deleted: they let an owner
delete grants without an authorization change and had no UI caller (only
tests). Grants are created and deleted solely by
`reconcileGrantsForGrantee`/`createGrantsForAgent`: source trees via
`storeGrantAndAcr` (from `getAuthorizations` → `generateGrants`), delegated
trees via `requestDelegations`, GC via `revokeGrantClosure` (own registry) or
`requestRevocations` (peer, through the `AccessRevocation` boundary). The
delegation endpoint remains the cross-peer transport for those two activities;
it is not a user-facing grant operation. The owner can still delete grants
directly at the storage level (owner ACR) — that is explicit owner authority,
not an SAI request path. **Pinned.**

**D19 — The sweep re-runs the idempotent reconciliation; no separate drift
comparison.** `reconcileActivities` enumerates the registered grantees
(social-agent + application registrations; role members are registered agents,
and an unregistered grantee has no projection to heal) and re-runs
`reconcileGrantsForGrantee`. If nothing changed, `checkEquivalence` reuses every
existing tree and `replaceDataGrants` (already a no-op when the `hasDataGrant`
set is unchanged) performs no PATCH — so a no-op sweep writes nothing and emits
no reciprocal webhook. This keeps the detector and the reconciler from drifting
apart (the reconciliation *is* the comparison). **Pinned.**

**D20 — Mirror drift is the same idempotent path; immutability makes it
writeless.** Grants are immutable (a replacement is a fresh IRI), so the
mirror's `hasDataGrant` link set is the existence oracle: a linked grant already
mirrored is never re-fetched or re-written, newly linked grants are fetched,
unlinked ones are dropped. **Only the `hasDataGrant` set is compared** (the same
rule as D19/`replaceDataGrants`): when it is unchanged and every linked body —
including the registration graph — is present, the sync performs zero writes.
Non-grant registration fields ride along when a grant changes and do not
trigger a write. The local completeness check runs inside the scheduled
`reconcileActivities` (no peer fetch); peer freshness runs on a slower
per-account schedule, serialized through the per-peer consumer's forced-sync.
`404`/`410` on the peer registration is terminal; everything else retries.
**Pinned.**

**Superseded decisions:**

- **"Deny writes a revocation activity"** (former `authorization-revoked.md`) —
  superseded by the activity-first split: deny is `AuthorizationDenied` (pure
  decline); revoke is `AuthorizationRevoked`.
- **"Revoke with the org session (`getSession(ctx.webId)`)"** — superseded by
  the org-context design: no org session is minted in the API
  (`services/Context.ts`); the worker mints the owner session for deletes.
- **"New terms go in both INTEROP vocab modules"** — superseded: only
  `packages/utils/src/namespaces.ts` remains.
- **"Requester hop landed"** (old §10 step 4) — not landed; C3.

## 3. Shared primitives

Each primitive lands with its first caller; there is no primitive-only slice.

| Primitive | First caller | Shape |
|---|---|---|
| **P1 Authorization reader** | C0 (landed) | AA `findAuthorizationsForGrantee(transport, registrySet, grantee)` over an explicit registry set (direct + via-role); the class method `findAuthorizationsForAgent` delegates with the session's own registry; service binds `sparqlTransportFor(ctx)` + `ctx.registrySet` |
| **P2 Chain predicate / closure** | C1 (then C2/C3/C5) | AA `grantChainValidity` / `invalidGrantsAfterRemoval` over the grant registry; fixed-point rooted reachability + coverage lattice |
| **P3 `requestRevocations`** | C2 | Temporal activity: group grant IRIs by `dataOwner`, local delete or POST `AccessRevocation`, await echo |
| **P4 `reconcileGrantsForGrantee`** | C2 | Workflow helper (projection + GC): desired = generate(remaining authorizations); `checkEquivalence` → keep set; remove `existing − reused` by dataOwner (local owner-session delete or boundary `AccessRevocation`); create new; drop ACRs + replicas; PATCH registration last |
| **P5 Batch validation** | C5 | Boundary validate request (`valid`/`invalid`/`unknown`) for suspected stale grants; no mutation |

## 4. Capability ladder

| # | Capability / Done when | Depends | Package gate | `/test` acceptance (user) |
|---|---|---|---|---|
| **C0 ✅** | **Authorization view (read-only). ✅ landed (acceptance confirmed 2026-10-21).** A peer/app opens a list of all recorded authorizations, inherited ones nested under their parent, labels resolved. No mutation. | — | `packages/components/test/authorizations.test.ts`; AA `findAuthorizationsForAgent`; `npx vite build` | `test/authorizations.test.ts` |
| **C1 ✅** | **Chain validity + coverage. ✅ landed (acceptance confirmed 2026-10-21).** AA decides validity and the invalid set for arbitrary delegation depth; issuance and revocation use the same predicate; no semantic cycles. | — | `packages/authorization-agent/test/grant-chain.test.ts` (15 tests); AA `revokeGrants core`; `npx tsc -p packages/components/tsconfig.json --noEmit` | `/test/delegation-endpoint.test.ts` (multi-hop + no-upstream cases) |
| **C2 ✅** | **Revoke authorizations end-to-end. ✅ landed (acceptance confirmed 2026-10-21).** Multi-select/select-all → `RevokeAuthorizations` RPC → refs+grantee carrier → `processAuthorizationRevoked` deletes the DAs, reconciles the affected grantees' grants (grouped by dataOwner), runs the chain closure, completes; a later regeneration does not resurrect access. | C0, C1 | `authorization-revocation-workflow.test.ts`; activity-registry carrier test; `npx tsc -p packages/components/tsconfig.json --noEmit`; UI `npx vite build` | `test/authorization-revocation.test.ts` |
| **C3 ✅** | **Reconciliation for every trigger. ✅ landed with C2 (acceptance confirmed 2026-10-21).** Any authorization change (grant, role change, delegated update, regeneration) reconciles grants: reuse / replace / revoke, delete-before-create, requester hop, replica cleanup. No stale grant confers access. | C2 | `grants-workflow.test.ts`; `check-equivalence.test.ts` | `check-equivalence.test.ts`, `services.test.ts` |
| **C4 ✅** | **Typed revocation errors + owner projection cleanup. ✅ landed (acceptance confirmed 2026-10-21).** Every revocation failure is machine-readable at the HTTP boundary and on the authorization RPC (B2/B6 fixed, no string matching); the owner's boundary workflow clears its registration projection. Grantee self-revocation was **removed by design review** (D17); the grant-level RPC was deleted (D18). | C1 | AA `revokeGrants core` (unauthorized/mixed/wrong/idempotent); `revocation-errors.test.ts`; `grants-workflow.test.ts`; UI `npx vite build` | `test/delegation-endpoint.test.ts` (mixed-owner, unknown, unauthorized body) |
| **C5** | **Sweep backstop.** A missed webhook/revocation is corrected within one interval; owner-unreachable retries without false revocation; pending revoked activities cannot strand. | C2, C1 | workflow tests (mock time/condition) | `reconciliation.test.ts` |

**Recommended order:** C5 (sweep) is the last open slice; it builds on the
landed C0–C4 and needs the peer-side orphan scan.

## 5. C0 — Authorization view (read-only)

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21).

**Done when:** from `SocialAgentList` or `ApplicationList`, a peer or
application opens a view listing every recorded `DataAuthorization` for that
grantee, grouped by data owner, with inherited authorizations nested under their
parent and human labels (shape tree, registration, scope, access modes). Nothing
is mutated.

**RPC (landed).** `ListAuthorizations`:

```ts
payload: { grantee: IRI, lang: string, context: IRI }
success: AuthorizationList // Array<RecordedDataAuthorization>
```

`RecordedDataAuthorization` (already in `packages/api-messages/src/effect.ts`)
now carries the resolved `shapeTreeLabel`. The RPC is wired through
`SaiService.getAuthorizations` → `ApiHandler` → `listAuthorizations`.

**AA (factored, context-aware).** The registry-plane read is the exported
`findAuthorizationsForGrantee(transport, registrySet, grantee)` in
`packages/authorization-agent/src/sparql.ts`: it lists the authorization
registry container, loads each `DataAuthorization`, includes direct and
via-role authorizations, and type-filters `interop:DataAuthorization`. The
existing class method `AuthorizationAgent.findAuthorizationsForAgent` delegates
to it with the session's own endpoint/registry (personal context). The service
binds the **context's** registry set and `sparqlTransportFor(ctx)` — personal
context reads the session's endpoint, org context reads the org's registry
through `/sparql-admin` — so an org admin lists the org's authorizations, not
their personal ones.

**Service (landed).** `listAuthorizations` in
`packages/components/src/services/Authorization.ts`: maps the AA rows to the RPC
shape, resolves each unique shape tree's label in the requested language
(`ShapeTree.getDescription`, falling back to the shape-tree IRI), keeps optional
fields omitted when absent, and sorts by `dataOwner` / shape tree / id.

**UI (landed).** A **“Manage access”** icon button on `SocialAgentList` and
`ApplicationList` opens the new `authorizations` route
(`ui/authorization/src/views/Authorizations.vue`): cards per data owner, the
authorization tree built globally from `inheritsFromAuthorization` (children
stay under their parent even when the child omits `dataOwner`), indentation for
depth, shape-tree label, scope / registration, access-mode chips, and a
`via role` note when the authorization is granted to a role. The view is
read-only — no checkboxes or revoke action yet (C2).

**Green (landed):** `packages/components/test/authorizations.test.ts` (mapping,
label resolution/fallback, optional-field omission, empty list, and the
context registry set + reader args); the AA `findAuthorizationsForAgent` tests
(including the inherited-child case, exercising the delegated function);
`npx tsc -p packages/components/tsconfig.json --noEmit`; `cd ui/authorization &&
npx vite build`. **Do not use `vue-tsc` as a gate yet:** the UI's `vue-tsc`
baseline is already red because the UI's own `node_modules` and the symlinked
packages resolve two different Effect type identities. `/test`:
`test/authorizations.test.ts` (user-run).

**Touchpoints:** `packages/api-messages/src/effect.ts`;
`packages/components/src/{ApiHandler,services/Authorization}.ts`;
`authorization-agent/src/{authorization-agent,sparql}.ts`
(`findAuthorizationsForGrantee` + the delegating class method);
`ui/authorization/src/{effect.ts,store/app.ts,router/index.ts,views,locales}`.

## 6. C1 — Chain validity + coverage

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21).

**Done when:** the AA can answer, from the grant registry alone, "is this grant
valid?" and "which grants become invalid if these grants are removed?" for an
arbitrary delegation depth; issuance and revocation use the same predicate.

**Predicate (landed in `grant-chain.ts`).** Grant g is valid iff:

- `g.grantedBy == g.dataOwner` (a source/root grant) and g exists in the
  registry; **or**
- ∃ grant g′ in the registry with `g′.grantee == g.grantedBy` ∧
  `g′.dataOwner == g.dataOwner` ∧
  `g′.registeredShapeTree == g.registeredShapeTree` ∧
  `g′.hasDataRegistration == g.hasDataRegistration` ∧
  `g′.hasStorage == g.hasStorage` ∧ `g′.scopeOfGrant` covers
  `g.scopeOfGrant` ∧ `g′.accessMode ⊇ g.accessMode` ∧
  `g′.creatorAccessMode ⊇ g.creatorAccessMode` (instance coverage for
  `SelectedFromRegistry`) ∧ **g′ itself valid**.

A grant with `inheritsFromGrant` is a same-request child: it is valid iff its
parent is valid and the structural fields match (`scopeOfGrant == Inherited`,
same `dataOwner`/`grantedBy`/`grantee`/`hasStorage`). The parent is the
**lifecycle** link, not the child's authority: a source child is valid while
its parent is valid, and a delegated child additionally needs its own valid
match-based upstream (the source grant for its shape tree/registration). The
parent's access modes do not constrain the child's (different shape tree).

Validity is **rooted reachability**, implemented as a monotonic fixed point
(false → true). A chain that never reaches a source grant is invalid; mutual
delegations never bootstrap a valid cycle, and a grant reachable from both a
cycle and a valid root resolves correctly. The scope lattice is
`All ⊃ AllFromAgent/AllFromRole ⊃ AllFromRegistry ⊃ SelectedFromRegistry`, with
`Inherited` covered by a same-registration `AllFromRegistry` (or broader).

**Module.** `packages/authorization-agent/src/grant-chain.ts` — pure functions
over `GrantData` (`scopeCovers`, `accessModesCover`, `creatorModesCover`,
`instancesCover`, `grantCovers`, `parentCoversChild`, `grantChainValidity`,
`invalidGrantsAfterRemoval`, `isGrantValid`). The registry bodies come from
`getRegistryGrants(transport, grantRegistryIri)` in `sparql.ts`
(`listContained` + one `getDataGrant` per graph, skipping unframable graphs).
The pre-C1 `findDelegableGrant` and `findInheritingChildren` helpers were
removed.

**Closure.** `AuthorizationAgent.revokeGrants` keeps the listed-grant authority
check (`getGrantsAuthority`) and then loads the whole registry and returns
`invalidGrantsAfterRemoval(registryGrants, listed)` — the listed grants, their
`inheritsFromGrant` descendants, and every grant that was valid before the
operation and whose match-based chain no longer reaches a source grant. Grants
that were already invalid before the operation are **not** swept (they are
unrelated to this revocation and belong to the sweep); a grant with an
alternative valid upstream stays valid (replacement re-anchoring). A listed
grant that raced out of the registry keeps its authority echo for the caller's
projection cleanup.

**Issuance.** `GrantIssuanceHandler.validateDelegable` validates the whole
request at once against `existing registry + request grants` with the same
`grantChainValidity` (the parent/child tree is not stored yet). Source grants
are rejected (`grantedBy == dataOwner`); a request with no covering upstream
fails with no mutation.

**Green (landed):** `packages/authorization-agent/test/grant-chain.test.ts`
(15 tests: lattice, mode/instance coverage, multi-hop, cycle, mode expansion,
selected instances, replacement re-anchor, source/delegated children, closure)
and the AA `revokeGrants core` test (multi-hop + child + root + idempotent).
`/test/delegation-endpoint.test.ts` adds the multi-hop and no-upstream cases
(user-run). Issuance/revocation behavior on today's one-hop cases is unchanged.

## 7. C2 — Authorization revocation end-to-end

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21).

Detailed design: [`authorization-revocation.md`](authorization-revocation.md).
Summary:

**Producer.** `RevokeAuthorizations` RPC (`{ authorizations: IRI[], context }`)
loads the selected DAs, validates type/grantee/ownership, expands descendants
via `inheritsFromAuthorization`, and writes one `AuthorizationRevoked` per
grantee:

```ts
type AuthorizationRevoked = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AuthorizationRevoked']
  actor: string
  object: Array<{ id: string; type: string[] }>   // refs, closure expanded
  grantee: string                                   // routing key, survives delete
}
```

Ack `{ activityId, authorizations: IRI[] }` so the UI claims the activity and
shows what is revoked. This is a coordinated break: data model, api-messages
schema (currently `target` + `object: string[]`), producer, handler, sweep,
tests.

**Workflow `processAuthorizationRevoked`** (task queue `create-grants`):

1. `deleteAuthorizations` (existing activity; owner session, 404-tolerant) for
   the activity's refs — this is the source-of-truth mutation.
2. Resolve the affected grantees (the `grantee`, expanded across roles via
   `getGrantees`).
3. For each grantee, `reconcileGrantsForGrantee` (P4, projection + GC):
   desired = `generateGrants(remaining authorizations)`; existing = the
   grantee's registry grants (projection links + registry orphan scan);
   `checkEquivalence` → keep = `reusedExisting`; remove =
   `existing − keep`, grouped by `dataOwner` (local owner-session delete or
   `AccessRevocation` via `requestRevocations`); create the unmatched desired
   trees; drop the removed grants' ACRs + issuer-side replicas; PATCH the
   registration projection to `[...keep, ...new]` **last**.
4. Run the chain closure (C1) for the affected data owners so downstream
   delegated grants invalidated by the removed authorizations disappear.
5. `markActivitiesDone` only after all children/operations succeed.

The old per-grantee consumer (`processGranteeActivities`) is removed; the
handler and the sweep start `processAuthorizationRevoked` instead. The DA refs
make deletion idempotent; `grantee` makes retries/sweep safe after the DA
resources are gone (B3).

**Fixes folded in:** B1 (org-context RPC no-op), B3 (carrier), B4 (consumer
deletion), B5 (dead UI surface / non-durable revoke). B2 (mixed-owner
all-or-nothing) is fixed with the typed errors in C4.

**Green:** data-model activity test; components producer + workflow tests
(mocked activities, assert delete-then-reconcile order, local vs peer-owned
grouping, idempotent re-run); AA closure test. `/test`: grant → revoke → grant
registry empty; re-revoke idempotent; a later regeneration does not resurrect
access; a delegated descendant is removed.

## 8. C3 — Reconciliation for every trigger

**Status:** ✅ landed with C2 (package-tested; `/test` acceptance confirmed 2026-10-21) —
2026-10-21. `createGrantsForAgent` delegates to `reconcileGrantsForGrantee`,
so every existing trigger (authorization granted, role change, delegated
update, deny, regeneration) runs the projection + GC path. Remaining: the
peer-side orphan scan (C5).

**Done when:** after any authorization change (approve, deny, role membership,
delegated update, regeneration), both registries contain exactly the current
grants. Replaced grants are gone; no stale grant confers access; no replica is
left behind.

**`reconcileGrantsForGrantee`** becomes the single regeneration path. Apply it
to `createGrantsForAgent`, `updateDelegatedGrants`, role membership/deletion,
and the C2 workflow. The model is **projection + garbage collection** (D13):

1. **Desired** = `generateGrants` from the remaining authorizations (an empty
   authorization set yields an empty desired set — the deny case is not
   special-cased; the current short-circuit in `createGrantsForAgent` is
   removed).
2. **Existing** = the grantee's grant resources: the registration projection
   (`hasDataGrant`) **plus a registry orphan scan** (grants whose `grantee` is
   the grantee and whose bodies exist but are no longer linked). The orphan
   scan is what makes GC recover after a crash between delete and PATCH.
3. **Equivalence** (`checkEquivalence`): generated trees pair with existing
   trees as whole subtrees (value-based; ids and structural links are not
   compared). `reusedExisting` is the keep set; a replacement with identical
   semantics reuses the same IRIs (no churn).
4. **GC** = `existing − reusedExisting`, grouped by `dataOwner`:
   - `dataOwner == actor`: delete locally with the owner session (Temporal
     activity, 404-tolerant);
   - otherwise: `requestRevocations` (P3) — the boundary `AccessRevocation`
     makes the owner delete with its own session and run its C1 closure.
   Delete the grant resource **and its ACR**; drop the issuer-side replica
   graphs (parent + children, `meta:` twins).
   - A **peer-owned grant with no issuer-side replica body** cannot be
     owner-grouped; it is left to the data owner's sweep/closure (it is
     already excluded from the projection). Own-registry grants are removed by
     IRI even without a body — the owner-session closure loads the registry
     itself.
5. **Create** the unmatched desired trees: source grants locally, delegated
   grants via `requestDelegations`.
6. **PATCH the registration projection** to `[...keep, ...new]` last. A crash
   before this leaves a stale projection; enforcement is already correct and
   the next reconciliation/sweep heals it.

**Two passes.** The projection GC above handles the affected grantee's own
trees. It cannot see grants for **other** grantees whose validity depended on a
removed upstream (multi-hop delegated chains) — those are removed by the C1
chain closure at each affected data owner (`invalidGrantsAfterRemoval`). The C2
workflow runs the projection GC for the affected grantees and then the chain
closure for the affected data owners; both passes are idempotent.

**Ordering.** Delete the GC set **before** creating the new set. Enforcement
collects all grants with `hasStorage`; create-first leaves a fail-open window
(the old, possibly broader grant still grants). Delete-first leaves a short
fail-closed window that Temporal retries. On a replacement with covering
semantics, downstream grants re-anchor via C1; a crash after delete is retried,
a crash after create already has the old grants gone.

**Owner grouping.** Source grants (`dataOwner == actor`) are deleted locally.
Delegated grants live in each `dataOwner`'s registry; the actor is not the owner
and cannot DELETE them (ACR) — POST `AccessRevocation` to that owner's endpoint
(P3), await the echo. Do **not** uncomment the old `deleteDataGrants` calls in
`createGrantsForAgent` (they run after creation and with the grantor's session).

**Requester hop.** After a successful `AccessRevocation`, clear the actor's
registration projection for the returned grant IRIs
(`replaceDataGrantsOnRegistration` / `removeDataGrants`). The old plan claimed
this landed; it did not (only a dangling docstring above `createRole`). The
workflow that performs the hop is part of this slice; no `grantsRevoked`
activity is introduced (D5).

**Replica cleanup.** Drop the issuer-side replica graphs (`GRAPH <grantIri>` +
its `meta:` twin) for removed delegated grants, parent and children, in the
same step. The replica is written by `storeGrantReplica` at issuance (OpenWiki
`architecture/grant-reuse.md`); `GrantReplica.ts` currently has "no drops".
Never touch own grant-registry graphs.

**Green:** components workflow tests for reuse/replace/revoke and ordering;
components equivalence and replica tests. `/test`: regeneration leaves no orphan
grant or replica; a denied/reduced delegation removes the resources at the
owner; the projection matches the registry afterwards.

## 9. C4 — Typed revocation errors + owner projection cleanup

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21;
self-revocation removed afterwards — D17).

**Done when:** every revocation refusal is machine-readable at HTTP and RPC (no
message matching), the requested-set owner check is all-or-nothing (B2), and
the owner's boundary workflow leaves no stale projection links (D14). Grantee
self-revocation is **out of scope by design** (D17).

**Typed errors (landed, D11/D15).** The AA union lives in
`packages/authorization-agent/src/revocation.ts` (`RevocationError` with `code`
+ `grants`, plus `grantRegistryOf`/`normalizeRegistryIri`):

```ts
type RevocationErrorCode =
  | 'unknown'
  | 'wrong-data-owner'
  | 'unauthorized'
  | 'not-delegable'
  | 'mixed-owner'
```

- `mixed-owner` is checked on the **requested** IRIs before anything loads
  (`grantRegistryOf` container compare) — B2 closed, no partial apply. The
  handler additionally resolves every requested grant's registry pod and fails
  on differing endpoints; a grant from no known pod is `unknown`.
- `wrong-data-owner`: the requested registry is not the targeted registry (the
  AA class method's own-registry binding) — a typed refusal instead of a silent
  no-op echo.
- `unauthorized`: no grantor/owner branch.
- `unknown`: unresolvable grant pod / malformed request; an already-removed
  grant in the right registry remains the idempotent echo.
- `not-delegable`: reserved for the issuance chain predicate; no revocation
  path produces it.

HTTP mapping (`revocationFailureDescription` in `GrantRevocationHandler.ts`):
`unknown`/`wrong-data-owner`/`mixed-owner` → 400, `unauthorized` → 403,
`not-delegable` → 409, body `{ code, grants, message }`. The
`err.message.includes(...)` matching is gone. There is no grant-level RPC
(D18); the authorization leg uses `failure: AuthorizationRevocationFailure`
(`empty-selection`, `not-a-data-authorization`, `mixed-grantee`,
`unauthorized`). The UI catches the typed failure and shows the code
(`revocation-failed-code`).

**Owner projection cleanup (landed, D14).** The boundary/owner `revokeGrants`
workflow clears the data owner's registration projection for the removed
grants, grouped by `grantee`, **after** the deletes
(`removeGrantsFromRegistrations`). The owner's registration is the document the
grantee mirrors, so its Update lets the grantee's reciprocal webhook drop the
revoked grants. This is a projection sync of the authorization-driven state,
not a source-of-truth change. A role grantee has no agent registration; its
members' links are healed by `reconcileGrantsForGrantee`/the C5 sweep. The
owner RPC was deleted (D18), so the boundary workflow is the single owner of
the cleanup.

**Removed (D17).** The grantee authority branch in `revokeGrantsClosure`, the
`RevokeMyAccess` RPC/service, and the UI "Remove my access". Reason: grants are
projections; a user action must not delete a grant directly. Future options
(not slices yet):

- **Shadowing** — the grantee hides unwanted grants in its own view/mirror
  without touching the owner's state (purely local presentation; the grant
  still confers access).
- **Need-based-style revocation request** — the grantee asks the owner to
  revoke its authorizations (a request like the access-request flow); the
  owner's workflow runs the C2 authorization leg, and the grants disappear via
  the projection GC.

**Green (landed):** AA `revokeGrants core` tests (unauthorized
grantor/owner-only, mixed-owner on the requested set, wrong-data-owner,
idempotent empty closure, grantee branch rejected); `packages/components/test/revocation-errors.test.ts`
(schema round-trips, HTTP status/body per code, RPC request schema);
`packages/components/test/grants-workflow.test.ts` (`revokeGrants` delete →
projection PATCH order, no-projection payload); `npx tsc -p
packages/components/tsconfig.json --noEmit`; UI `npx vite build`.

**`/test` acceptance (confirmed green 2026-10-21):** `test/delegation-endpoint.test.ts`
— mixed-owner 400 with no partial apply, unknown-grant 400, 403 body code. (The
grantee self-revocation cases and the owner `RevokeGrants` RPC suite were
removed with their features — D17/D18.)

**Touchpoints:** `authorization-agent/src/{revocation.ts,authorization-agent.ts,index.ts}`;
`components/src/{GrantRevocationHandler.ts,ApiHandler.ts,services/Revocation.ts,services/Authorization.ts}`;
`components/src/temporal/{activities,workflows}/grants.ts`;
`api-messages/src/effect.ts`; `ui/authorization/src/views/Authorizations.vue` + locales.

## 10. C5 — Sweep backstop

**Done when:** a missed webhook/revocation is corrected within one configured
interval, and an owner outage produces retries, never a false revocation.

**No C4 blocker (D17).** Grantee self-revocation was removed, so the sweep's
re-derive cannot undo a grantee action; it only restores authorization-driven
state. The peer-side orphan scan remains.

**Detection, in order of cost:**

| Signal | Catches | Notes |
|---|---|---|
| Own authorization registry vs grant projection | authorization changed, reconciliation missed | primary; local/SPARQL read |
| Own registration projection vs reciprocal mirror | peer registration changed, `DelegatedGrantsUpdated` missed | 200-semantics |
| Reciprocal mirror of the peer's registration | upstream grant revoked, webhook missed | mirror sync is the existing replication path |
| Batched boundary validation at the data owner | owner removed a grant unilaterally; projection still links it and the authorization state still wants it | `valid` / `invalid` / `unknown`; only this case needs a validate |

**Actions:** re-derive the desired grant set; if it differs, run
`reconcileGrantsForGrantee` (idempotent). For still-desired but suspected
grants, send one batch validation per data owner: `invalid` → drop the link and
reconcile; `unknown`/unreachable → leave and retry. Never treat HTTP status of a
grant GET as a signal.

**Stranded activities:** a pending `AuthorizationRevoked` whose refs are
already gone is completed by the sweep after verifying the end state (no grants
remain for the carried `grantee`); the carrier field from D3 makes this
possible.

**Scheduling (moved):** production schedule creation/backfill, the two
cadences (sweep vs peer-facing mirror freshness), interval/jitter, account
lifecycle, worker ops, and activity-webhook channel healing live in
[`update-deployment.md` §F](update-deployment.md#workstream-f--scheduled-reconciliation-c5--channel-healing).
This slice owns only the sweep's **detection/actions** and tests (they run with
mocked time/condition, independent of the production schedule).

**Still to implement here (after the schedule is moved):**

1. ✅ **Drift arm — authorization state vs grant projection (landed).** After
   the pending-activity drain, `reconcileActivities` lists the registered
   grantees (`listGranteeRegistrations`, `activities/grants.ts`) and re-runs
   `reconcileGrantsForGrantee` for each. No separate comparison (D19): unchanged
   trees are reused and `replaceDataGrants` (already a no-op when the link set
   is unchanged) writes nothing, so a no-op sweep is writeless. Covers missed
   authorization/grant/role deliveries with no pending activity. Tests:
   `delegated-grants.test.ts` (drift arm); `/test/reconciliation.test.ts`
   (cleared projection with no pending activity is restored).
2. ✅ **Drift arm — reciprocal mirror (local completeness + peer freshness).**
   Landed as workflow code; the **schedules/cadence are deferred to
   [`update-deployment.md` §F](update-deployment.md#workstream-f--scheduled-reconciliation-c5--channel-healing)**
   (the user's directive). Two checks, both reusing the existing idempotent
   path (no separate grant-set comparison):

   - **Local completeness (every sweep, no peer fetch).** For each
     social-agent registration with a `reciprocalRegistration`: the mirrored
     peer-registration graph exists and frames, and every grant body linked
     from it is present (`presentGraphs`, resource + `meta:` twin). Repairs a
     mirror that was never written or lost a graph, i.e. the case with **no**
     pending `DelegatedGrantsUpdated` at all. This is the same scan as
     [`pod-isolation-followup.md` A1](pod-isolation-followup.md) (A1 owns the
     cutover backfill; C5 owns the scheduled runtime arm).
   - **Peer freshness (slower cadence, peer-facing).** Re-fetch the peer's
     registration + linked grants (`syncReciprocalMirror`) and re-derive the
     delegated grants (`updateDelegatedGrants`) — the only way to see an
     upstream grant the peer replaced/revoked when its webhook was missed.
     Then the normal projection GC removes the delegated grants derived from
     it. Triggered by a separate mirror-freshness schedule (see
     [`update-deployment.md` §F](update-deployment.md#workstream-f--scheduled-reconciliation-c5--channel-healing)),
     not every sweep run.

   **Immutability is what makes this writeless when current.** Grants are
   immutable: a replacement is a new IRI, so the mirror's link set is the
   existence oracle — a linked grant already mirrored is never re-fetched or
   re-written; newly linked grants are fetched; unlinked ones are dropped.
   The **only** authoritative comparison is the `hasDataGrant` set, the same
   rule as the registration projection (`replaceDataGrants`): if the set is
   unchanged and every linked body (including the registration graph) is
   present, `updateReciprocalMirror` writes **nothing**. Non-grant fields
   (label/note) ride along when a grant changes and do not trigger a write on
   their own. `updateDelegatedGrants`/`reconcileGrantsForGrantee` only
   delete/reuse/create immutable grants — never content-rewrite.

   **Triggering + serialization.** The local scan runs inside the scheduled
   `reconcileActivities` (entries + local authorization/projection drift +
   local mirror completeness). The peer freshness pass needs its own, slower
   schedule. Both repair paths run through the **per-peer consumer** (same
   deterministic workflowId per `(webId, peerId)`) so they serialize with
   webhook-driven syncs; the consumer needs a forced-sync signal/flag to run one
   iteration with no pending activity (it currently idles out without syncing).
   `404`/`410` on the peer registration stays terminal (drop replica, no
   regeneration); `401`/`403`/`5xx`/network retries — never a revocation.

   **Landed runtime:** `listReciprocalRegistrations` +
   `findIncompleteReciprocalMirrors` (activities), `reconcileActivities`' mirror
   repair, `reconcilePeerMirrors` (freshness workflow), the consumer's
   `forceSync`/`reconcileMirrorSignal`, and the `updateReciprocalMirror` no-op
   guard. Tests: `delegated-grants.test.ts` (forced consumer, sweep repair,
   start-or-signal, freshness pass), `reciprocal-mirror.test.ts` (no-op guard),
   `/test/reconciliation.test.ts` (missing mirror body restored; missed-webhook
   upstream grant dropped). Scheduling only remains in `update-deployment.md` §F.
3. **Batch boundary validation (P5)** — not implemented: a read-only
   `valid` / `invalid` / `unknown` batch per data owner for still-desired but
   suspected grants, with rate/backoff; `invalid` → drop link + reconcile;
   `unknown`/unreachable → leave and retry. The message/activity does not exist
   yet (`AccessRevocation` is mutation-only).
4. **Peer-side orphan scan** — C3 scans only the actor's own grant registry;
   peer-owned grants with no issuer-side replica body are skipped there and
   deferred here. Decide and implement the scan/cleanup.
5. **Stranded `AuthorizationRevoked`** — the pending-activity arm already routes
   it to `processAuthorizationRevoked` (idempotent), so completion works; add
   the explicit end-state check (no grants remain for the carried `grantee`) and
   a test.
6. **Role-grantee projection healing** — the C4 note that role grantees have no
   registration and their members' links heal here; verify the drift arm covers
   it.
7. **Tests** — package tests for missed deliveries, unreachable owner = retry
   (never revoke), stranded completion; extend `/test/reconciliation.test.ts`.

**Green:** workflow tests with mocked time/condition (detect a missed delivery,
no revocation on unreachable owner, stranded activity completes). `/test`:
`reconciliation.test.ts` extended.

## 11. Known bugs / gaps in the current code

These are covered by the slices above; they are listed here so a session does
not rediscover them as "new".

- **B8 — Grantee self-revocation is not durable against owner regeneration.
  ✅ withdrawn (D17):** grantee self-revocation was removed — grants are
  projections, and the only revocation is the authorization leg. No
  durability gap remains. Future grantee options: shadowing or a
  need-based-style revocation request.
- **B1 — Org-context owner RPC is a silent no-op. ✅ fixed in C2:** the
  handler computes the closure with `revokeGrantsClosure` bound to the owner's
  endpoint (resolved from the grant IRI) instead of the signed-in user's
  session. Historical detail: `services/Revocation.ts`
  shims `getSession` to `ctx.session` (the signed-in user's AA). The handler
  loads the grants from the owner's endpoint, then the AA core re-reads from
  `session.sparqlEndpoint`; for an org context (session = user's personal AA)
  that is the wrong endpoint, so the core sees zero grants and the RPC returns
  success without deleting. Same for the grantor branch through the RPC.
  **Fix:** bind the core to the resolved owner endpoint (the worker already
  mints `getSession(dataOwner)` for the deletes) or pass the transport/endpoint
  into the AA core. Add an org-admin regression test. C2. *(The RPC itself was
  later deleted — D18; the boundary core keeps the owner-endpoint binding.)*
- **B2 — Mixed-owner all-or-nothing hole. ✅ fixed in C4:** the requested-set
  check runs before loading (`grantRegistryOf` per requested IRI → typed
  `mixed-owner` on the whole set); the handler also resolves every requested
  grant's registry pod and refuses differing endpoints. Historical detail:
  `GrantRevocationHandler` resolved one endpoint from `grants[0]` and checked
  `dataOwners` only over **loaded** grants; a request mixing owner A and owner
  B partially applied and echoed both.
- **B3 — `AuthorizationRevoked` carrier is not retry-safe. ✅ fixed in C2:**
  refs + `grantee`; the workflow/sweep never dereference the deleted DAs.
  Historical detail: `object` is a
  live-link set; after the workflow deletes the DAs, a retry/sweep cannot
  resolve the grantee and the sweep `continue`s, leaving the activity pending
  forever. Use refs + `grantee` (D3). C2.
- **B4 — The revoked consumer does not revoke. ✅ fixed in C2:** the
  per-grantee consumer/signal is removed; `processAuthorizationRevoked`
  deletes the DAs and reconciles the projections. Historical detail: `processGranteeActivities`
  drains `AuthorizationRevoked` and only regenerates; it never deletes the
  DataAuthorizations (`data-model/activities.ts` says "the workflow DELETEs
  them", but no such step exists). Replace with `processAuthorizationRevoked`.
  C2.
- **B5 — The landed UI revoke is dead and non-durable. ✅ fixed in C2:** the
  UI selects authorizations and calls `RevokeAuthorizations`; the grants are
  reconciled as projections. Historical detail:
  `ui/authorization/src/store/app.ts` exposes `revokeGrants`, but no view calls
  it; the RPC deletes grants and leaves the DataAuthorizations, so any later
  regeneration re-issues access. The authorization leg is the fix. C0/C2.
- **B6 — RPC errors are `S.Never`. ✅ fixed in C4:** the authorization leg
  declares `failure: AuthorizationRevocationFailure`; the grant boundary is
  HTTP-only now and returns typed codes + a JSON body. No string matching; the
  UI shows the machine-readable code. Historical detail: the owner
  `RevokeGrants` RPC threw strings and the UI got a defect/500; the RPC was
  deleted (D18).
- **B7 — `npm test` does not run the components suite. ✅ fixed:** `packages/components`
  now has a `test: vitest run` script, so the turbo `test` runs it. The scoped
  `npx vitest run --project @elfpavlik/sai-components` form stays the quick
  single-suite gate. CONVENTIONS §7.

## 12. Reference — landed boundary design

These contracts are settled; keep them stable while working the slices.

**Messages.** Revocation: `interop:AccessRevocation`, `grants` = grant IRIs,
`type` is an array (`["http://www.w3.org/ns/solid/interop#AccessRevocation"]`).
Issuance: `interop:AccessRequest`, `grants` = full grant objects (the mirror
envelope). The delegation endpoint dispatches on `type` and requires
`content-type: application/ld+json`. Models live in
`packages/data-model/src/access-{request,revocation}.ts`; terms in
`packages/utils/src/namespaces.ts`.

**Authority.** Per grant, before any mutation: the requester's client is the
UA of the grant's `grantedBy` (grantor branch) or the requester is the data
owner (owner branch). Grantee self-revocation is removed (D17): grants are
projections, so a grantee never deletes a grant directly; its future options
are shadowing or a need-based-style revocation request. Refusals are typed
(`RevocationError`); the mixed-owner check runs on the **requested** IRIs, not
the loaded subset (C4).

**Validation/deletion.** The whole request is validated before any mutation:
load each listed grant from the owner's registry, authority-check; then delete
the C1 closure with the owner's own session (owner rights; grant ACRs give the
grantor `acl:Read` only). The owner's registration projection is cleared after
the deletes (C4). Idempotent: already-removed entries are echoed; the response
equals the requested IRIs on success. Full predicate closure and
replace-vs-delete ordering are C1/C3.

**Wiring.** `CSS_SPARQL_ENDPOINT` is already passed to the auth/registry/data
services; `GrantRevocationHandler` takes the same `sparqlEndpoint` as
`GrantIssuanceHandler`. No new env vars.

**Retired.** `delegationOfGrant`, `authorizationRecorded` (deny is
`AuthorizationDenied`), `grantsRevoked`, `processGrantsRevocation`, the owner
`RevokeGrants` RPC + `services/Revocation.ts` (D18), grantee self-revocation
(D17), and the pre-C1 helpers `findDelegableGrant` / `findInheritingChildren`
(replaced by `grant-chain.ts` + `getRegistryGrants`). Do not reintroduce them.

## 13. Verification

Package gate (agent, from the repo root):

```bash
npm run typecheck
npx tsc -p packages/components/tsconfig.json --noEmit
npx vitest run --project @janeirodigital/interop-authorization-agent
npx vitest run --project @elfpavlik/sai-components
```

Baseline at `2381ecd2` (C0–C4; D17/D18 removal): typecheck green;
components 27 files / 208 tests (~4 s); authorization-agent 18 files / 135
passed / 20 skipped (~1.4 s, includes the C1–C4 working-tree tests). The UI
passes `cd ui/authorization && npx vite build`.

**Harness notes (learned during the C2 acceptance run):**

- Dev/test activity webhook channels are pre-seeded in
  `environments/data/kv.json`. **acme's channel was missing** until C2 (the
  first acme activity producer); it is now seeded
  (`webhook-subscription-bootstrap.md` §3). A missing channel makes every
  acme activity stay `pending` forever — the `/test` test times out at 25 s.
- `/test` resets the dataset per test, but **webhook-triggered workflows can
  outlive a test** and write into the next test's freshly reset dataset. When a
  test asserts on a projection after triggering a regeneration, wait for
  quiescence (`waitForQuiescence`) and read a stabilized projection (two
  consecutive equal reads) — see `test/check-equivalence.test.ts`.

`/test` acceptance (user, dagger-managed; data from `/environments/data`; the
full suite is **green as of 2026-10-21**):

- `test/delegation-endpoint.test.ts` — boundary issue/revoke, idempotency,
  read-only grant ACR; C4: mixed-owner 400 (no partial apply), unknown-grant
  400, 403 body code.
- `test/authorization.test.ts` — authorization leg and activity completion.
- `test/authorizations.test.ts` (new, C0) — read-only listing for a seeded
  grantee, including the inherited child and the empty case.
- `test/authorization-revocation.test.ts` (new, C2) — UI-shaped revoke path.
- `test/reconciliation.test.ts` — sweep backstop (C5): a never-delivered
  pending activity, a cleared projection with no pending activity restored by
  the drift arm, a missing mirror body restored by the local completeness arm,
  and a missed-webhook upstream grant dropped by the freshness workflow.
- `test/check-equivalence.test.ts` — C3; note the quiescence/stabilized-read
  waits (the registration PATCH fires a reciprocal webhook that starts a second
  regeneration; without the waits the test reads an intermediate projection).
- `test/services.test.ts` — C3.

The agent adds/updates these files in the same change set; a slice is marked
`landed (acceptance confirmed 2026-10-21)` until the user confirms the run.

## 14. Mapping from the former follow-ups

The old `revoke-delegation-chain-follow-ups.md` is absorbed as follows:

| Old item | Now |
|---|---|
| 1 full dependent-chain calculation | C1 ✅ |
| 2 scope/mode coverage ordering | C1 ✅ |
| 3 replace-vs-delete race | C3 ✅ |
| 4 trigger integration / grantor revocation | C3 ✅ (+ P3 from C2) |
| 5 grantee self-revocation | removed by design review (D17); future shadowing / need-based revocation request |
| 6 revocation error-detail schema | C4 ✅ |
| 7 drop `delegationOfGrant` | ✅ done |
| 8 validate-request shape/rate | C5 |
| 9 `reconcileActivities` scheduling | C5 |
| 10 issuer-side replica cleanup | C3 ✅ |

Former `authorization-revoked.md` (deny → typed activity) is superseded: deny is
a pure decline (`AuthorizationDenied`); the revocation carrier is
`AuthorizationRevoked`, designed in
[`authorization-revocation.md`](authorization-revocation.md). Former
`authorization-revocation.md` §2–3 ("org session", "`Revoked` re-pin with target
dropped") are corrected by D3 and the org-context note in §11/B1.
