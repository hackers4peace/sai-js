# Revoking access — workstream

> **Status:** 🔶 in progress — the delegation-boundary operation is landed; the
> authorization-revocation leg (C2), chain closure (C1), projection
> reconciliation (C3), and the sweep backstop (C5) are open. The old
> `revoke-delegation-chain-follow-ups.md` (absorbed here as C0–C5) and
> `authorization-revoked.md` (absorbed into the detailed design) were deleted.
> **Last verified:** `d7c89f43` (2026-10-21) — code anchors, package tests, and
> `/test` files checked against the tree.
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
| Owner revocation core | ✅ landed | `AuthorizationAgent.revokeGrants` (`packages/authorization-agent/src/authorization-agent.ts`); `getGrantsAuthority` / `findInheritingChildren` (`sparql.ts`) | `packages/authorization-agent/test/authorization-agent.test.ts` (`revokeGrants core`) | Validate-all-first; authority grantor/owner; closure = listed + `inheritsFromGrant` children only |
| HTTP revocation handler | ✅ landed (acceptance user-run) | `packages/components/src/GrantRevocationHandler.ts` | `/test/delegation-endpoint.test.ts` | Idempotent echo; all-or-nothing over **loaded** grants; see B2 |
| Owner UI RPC | 🔶 landed with gaps (acceptance user-run) | `packages/components/src/services/Revocation.ts`; `ApiHandler.ts`; `RevokeGrants` in `api-messages/src/effect.ts` | `/test/revocation-rpc.test.ts` | UI binding is dead code; org-context no-op (B1); `failure: S.Never` (B6) |
| Grant ACR owner-only write | ✅ landed (acceptance user-run) | `packages/data-model/src/acr.ts` (grantor `ACL.Read` only) | `/test/delegation-endpoint.test.ts` (direct DELETE → 403) | The grantor cannot delete a grant resource |
| Authorization read model + UI | ⬜ C0 | — | — | `RecordedDataAuthorization` exists but is unused; no listing RPC/view |
| Chain predicate + full closure | ⬜ C1 | current closure only: `findInheritingChildren` | AA `revokeGrants core` test | Rooted reachability + coverage lattice |
| Authorization revocation end-to-end | ⬜ C2 | type + routing exist: `activities.ts` (`AuthorizationRevoked`), `ActivityWebhookHandler.ts`, `workflows/grants.ts:527`, `ui/authorization/src/events.ts:97` | no producer test | No producer; consumer regenerates but does not delete DAs (B4); carrier is not retry-safe (B3) |
| Projection reconciliation (reuse / replace / revoke) | ⬜ C3 | `checkEquivalence`, `getExistingGrantBodies`, `storeGrantReplica`; commented deletes in `workflows/grants.ts` | `packages/components/test/check-equivalence.test.ts` | Replacement deletion disabled; requester hop absent; replica graphs never dropped |
| Grantee self-revocation + typed errors | ⬜ C4 | AA authority checks grantor/owner only; handler maps by message substring | AA test | No grantee branch; no machine-readable failure shape |
| Sweep backstop | ⬜ C5 | `reconcileActivities` (`workflows/grants.ts`); `getPendingActivities` | `packages/components/test/delegated-grants.test.ts`; `/test/reconciliation.test.ts` | No caller/schedule; validation shape/rate undecided |
| `delegationOfGrant` | ✅ retired | removed from model/generation/context | `check-equivalence` tests | Vocabulary term stays valid |
| `authorizationRecorded` / deny-as-revoke | ✅ retired | deny is `AuthorizationDenied` (pure decline) | `/test/authorization.test.ts` | Do not reintroduce revoke-on-deny |
| `grantsRevoked` / `processGrantsRevocation` | ✅ retired | no code references | OpenWiki `services/activity-lifecycle.md` | The typed carrier is `AuthorizationRevoked`; no revival |

## 2. Decision log

**D1 — Authorizations are the source of truth; the UI only works with
authorizations.** UI revocation targets DataAuthorizations, never grants. The
`RevokeGrants` RPC is no longer a UI operation; decide later whether it survives
as an internal escape hatch or is deleted. **Pinned.**

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
handler and the Effect RPC map it (`unknown`, `wrong data owner`,
`unauthorized`, `not delegable`, `mixed owner`). No message-substring matching.
**Pinned; details in C4.**

**D12 — `/test` acceptance is user-run.** A slice is `landed (acceptance
user-run)` until the user confirms the dagger run. **Pinned.** See CONVENTIONS
§7.

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
| **P1 Authorization reader** | C0 | AA `authorizationsForGrantee(grantee)` over the authorization registry; flat `DataAuthorizationData[]` with inheritance links |
| **P2 Chain predicate / closure** | C1 (then C2/C3/C5) | AA `isValidGrant` / `invalidGrantsAfterRemoval` over the grant registry; visited-set rooted reachability + coverage lattice |
| **P3 `requestRevocations`** | C2 | Temporal activity: group grant IRIs by `dataOwner`, local delete or POST `AccessRevocation`, await echo |
| **P4 `reconcileGrantsForGrantee`** | C2 | Workflow helper: existing vs desired via equivalence; remove set by dataOwner; issue new; patch registration; drop replicas |
| **P5 Batch validation** | C5 | Boundary validate request (`valid`/`invalid`/`unknown`) for suspected stale grants; no mutation |

## 4. Capability ladder

| # | Capability / Done when | Depends | Package gate | `/test` acceptance (user) |
|---|---|---|---|---|
| **C0** | **Authorization view (read-only).** A peer/app opens a list of all recorded authorizations, inherited ones nested under their parent, labels resolved. No mutation. | — | AA reader test; components service test; UI typecheck | list seeded acme authorizations for a grantee |
| **C1** | **Chain validity + coverage.** AA decides validity and the invalid set for arbitrary delegation depth; issuance and revocation use the same predicate; no semantic cycles. | — (parallel with C0) | AA unit tests (SPARQL mock): multi-hop, cycle, scope/mode reduction, root termination | multi-hop endpoint case |
| **C2** | **Revoke authorizations end-to-end.** Multi-select/select-all → `RevokeAuthorizations` RPC → refs+grantee carrier → `processAuthorizationRevoked` deletes the DAs, reconciles the affected grantees' grants (grouped by dataOwner), runs the chain closure, completes; a later regeneration does not resurrect access. | C0, C1 | components producer/workflow tests; data-model activity test; AA tests | grant → revoke → grants gone; reconcile stays empty; delegated descendant removed |
| **C3** | **Reconciliation for every trigger.** Any authorization change (grant, role change, delegated update, regeneration) reconciles grants: reuse / replace / revoke, delete-before-create, requester hop, replica cleanup. No stale grant confers access. | C2 | components workflow + equivalence tests | `check-equivalence.test.ts`, `services.test.ts` |
| **C4** | **Self-revocation + typed errors.** A grantee can remove its own access; every revocation failure is machine-readable at HTTP and RPC; no string matching. | C1 | AA + api-messages tests | endpoint/RPC error-shape assertions |
| **C5** | **Sweep backstop.** A missed webhook/revocation is corrected within one interval; owner-unreachable retries without false revocation; pending revoked activities cannot strand. | C2, C1 | workflow tests (mock time/condition) | `reconciliation.test.ts` |

**Recommended order:** C0 → C1 → C2 → C3 → C4/C5. C0 and C1 can run in parallel
(different files). C2 is the first mutating slice and needs both. C4 and C5 are
independent of the UI; C5 needs C2's carrier and C1's predicate.

## 5. C0 — Authorization view (read-only)

**Done when:** from `SocialAgentList` or `ApplicationList`, a peer or
application opens a view listing every recorded `DataAuthorization` for that
grantee, grouped by data owner, with inherited authorizations nested under their
parent and human labels (shape tree, registration, scope, access modes). Nothing
is mutated.

**RPC.** New `ListAuthorizations` (naming open):

```ts
payload: { grantee: IRI, context: IRI }
success: Array<RecordedDataAuthorization & { shapeTreeLabel: string }>
```

`RecordedDataAuthorization` already exists in `packages/api-messages/src/effect.ts`
but is unused; extend it with the label field (or a `shapeTree: { id, label }`
struct) rather than inventing a second shape.

**AA.** Add `authorizationsForGrantee(grantee)` — a SPARQL scan of the
authorization registry (reuse `getDataAuthorizationFromSparql`,
`findInheritingAuthorizations`). Return **flat**; keep
`inheritsFromAuthorization` and `hasInheritingAuthorization` so the UI can nest.
The service resolves shape-tree labels the same way `getDescriptions` does.

**UI.** Add a "Manage access" button to the `SocialAgentList` and
`ApplicationList` rows and a view/dialog (reuse the nested list +
`v-checkbox-btn` + expansion-panel patterns from `AuthorizeApp.vue`; extract a
small `AuthorizationTree.vue` if the duplication grows). The scope/registration/
instance selection machinery of `AuthorizeApp` is not needed here — this view
selects whole authorizations. Roles are supported by the same reader/RPC but can
get their UI entry later.

**C0 scope:** listing and nesting only. Selection state and the (disabled)
revoke action can be scaffolding, but no RPC writes.

**Touchpoints:** `api-messages/src/effect.ts`; `ApiHandler.ts`; a service
(`services/Authorization.ts` or new `services/Authorizations.ts`);
`authorization-agent/src/{authorization-agent,sparql}.ts`;
`ui/authorization/src/{effect.ts,store/app.ts,views,components,router}`.

**Green:** AA reader unit tests (SPARQL mock); components service test with a
mock session; `npx tsc -p packages/components/tsconfig.json --noEmit`; UI
typecheck. `/test`: list a seeded grantee's authorizations.

## 6. C1 — Chain validity + coverage

**Done when:** the AA can answer, from the grant registry alone, "is this grant
valid?" and "which grants become invalid if these grants are removed?" for an
arbitrary delegation depth; issuance and revocation use the same predicate.

**Predicate.** Grant g is valid iff:

- `g.grantedBy == g.dataOwner` (a source/root grant) and g exists in the
  registry; **or**
- ∃ grant g′ in the registry with `g′.grantee == g.grantedBy` ∧
  `g′.dataOwner == g.dataOwner` ∧ matching
  `registeredShapeTree` / `hasDataRegistration` ∧ `g′.scopeOfGrant` covers
  `g.scopeOfGrant` ∧ `g′.accessMode ⊇ g.accessMode` (instance coverage for
  `SelectedFromRegistry`) ∧ **g′ itself valid**.

Validity is **rooted reachability** (visited-set). A chain that never reaches a
source grant is invalid; the visited-set prevents mutual delegations from
bootstrapping a valid cycle. `hasInheritingGrant` / `inheritsFromGrant`
children stay part of the same-request tree; the predicate closure is the
superset (it also finds grants linked only by matching, which is what
`delegationOfGrant` used to do).

**Module.** One AA module (working name `grant-chain.ts`), pure predicate over
`GrantData` + a transport helper that loads the registry bodies. `getGrantsAuthority`
is not enough (it returns only `dataOwner`/`grantedBy`/`grantee`); load the full
grant bodies, as `getExistingGrantBodies` does. Formalize the scope lattice
(`All ⊃ AllFromRegistry ⊃ SelectedFromRegistry`, `Inherited` as a child scope)
and mode coverage in the same module; replace the informal SPARQL blocks in
`GrantIssuanceHandler.validateDelegable` (`findDelegableGrant`) with it.

**Closure.** `revokeGrants` uses `invalidGrantsAfterRemoval(transport, removed)`:
start from the listed/removed grants, remove them from the working set, then
walk every remaining grant whose validity depended on them. The boundary
handler's `revokeGrants` uses the same closure (owner-session delete). The
sweep's batch validation uses the singular predicate.

**Green:** AA unit tests with the SPARQL mock — multi-hop A→B→C, mutual
delegation non-termination, scope/mode reduction invalidating a downstream
grant, a chain that never reaches a source grant, and a replacement that
re-anchors unchanged downstream grants. Issuance/revocation behavior on today's
cases stays unchanged. `/test`: a multi-hop seeded chain.

## 7. C2 — Authorization revocation end-to-end

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
3. For each grantee, `reconcileGrantsForGrantee` (P4): load existing grants and
   bodies, generate the desired set from the remaining authorizations,
   `checkEquivalence`, group the remove set by `dataOwner` (local owner-session
   delete or `AccessRevocation` via `requestRevocations`), issue the new set,
   PATCH the registration projection, drop removed replicas.
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

**Done when:** after any authorization change (approve, deny, role membership,
delegated update, regeneration), both registries contain exactly the current
grants. Replaced grants are gone; no stale grant confers access; no replica is
left behind.

**`reconcileGrantsForGrantee`** becomes the single regeneration path. Apply it
to `createGrantsForAgent`, `updateDelegatedGrants`, role membership/deletion,
and the C2 workflow. For each existing tree:

- reused → keep (no new IRI, no propagation);
- not reused → remove, grouped by `dataOwner`;
- generated new → issue.

**Ordering.** Delete the remove set **before** creating the new set. Enforcement
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

## 9. C4 — Grantee self-revocation + typed errors

**Self-revocation.** Add the third authority branch in
`AuthorizationAgent.revokeGrants` (the grant boundary; the authorization leg's
authority is the context owner): a requester whose WebID is the grant's
`grantee` may revoke it. UI: "Remove my access" for a peer app. The grantee's
projection is not the grantor's; decide whether the workflow clears the
grantee's own links or leaves them to the sweep (D10) — pin it in the
implementation, with a test that no one else's grants are touched.

**Typed errors.** Define an AA error union:

```ts
type RevocationError =
  | { code: 'unknown'; grant: string }
  | { code: 'wrong-data-owner'; grant: string }
  | { code: 'unauthorized'; grant: string }
  | { code: 'not-delegable'; grant: string }
  | { code: 'mixed-owner'; grants: string[] }
```

Map to HTTP (`400` for malformed/mixed/unknown-in-wrong-registry, `403` for
unauthorized, `404`/`409` where appropriate) and to the Effect RPC `failure`
schema. Replace the `err.message.includes('dataOwner' | 'grantor')` matching in
`GrantRevocationHandler`. The mixed-owner check must run on the **requested**
grants, not only on the ones that happened to load (B2).

**Green:** AA authority tests for all three branches; handler error mapping
tests; RPC failure-schema test. `/test`: endpoint and RPC error shapes.

## 10. C5 — Sweep backstop

**Done when:** a missed webhook/revocation is corrected within one configured
interval, and an owner outage produces retries, never a false revocation.

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

**Scheduling:** `reconcileActivities({ webId })` exists but has no caller. Use a
Temporal Schedule per account, created by the same account-bootstrap/healing
path as `webhook-subscription-bootstrap.md` (idempotent create-if-missing;
dev/test pre-seeded/healed). Per-account deterministic workflowId, jitter,
backoff on owner-unreachable; or a single `fanOutReconciliation` schedule that
lists accounts and fans out with a concurrency limit — pin whichever matches the
bootstrap hook. Interval is a config knob.

**Green:** workflow tests with mocked time/condition (detect a missed delivery,
no revocation on unreachable owner, stranded activity completes). `/test`:
`reconciliation.test.ts` extended.

## 11. Known bugs / gaps in the current code

These are covered by the slices above; they are listed here so a session does
not rediscover them as "new".

- **B1 — Org-context owner RPC is a silent no-op.** `services/Revocation.ts`
  shims `getSession` to `ctx.session` (the signed-in user's AA). The handler
  loads the grants from the owner's endpoint, then the AA core re-reads from
  `session.sparqlEndpoint`; for an org context (session = user's personal AA)
  that is the wrong endpoint, so the core sees zero grants and the RPC returns
  success without deleting. Same for the grantor branch through the RPC.
  **Fix:** bind the core to the resolved owner endpoint (the worker already
  mints `getSession(dataOwner)` for the deletes) or pass the transport/endpoint
  into the AA core. Add an org-admin regression test. C2.
- **B2 — Mixed-owner all-or-nothing hole.** `GrantRevocationHandler` resolves
  one endpoint from `grants[0]` and checks `dataOwners` only over **loaded**
  grants; a request mixing owner A and owner B partially applies and echoes
  both. Check the requested set; typed `mixed-owner` error. C4.
- **B3 — `AuthorizationRevoked` carrier is not retry-safe.** `object` is a
  live-link set; after the workflow deletes the DAs, a retry/sweep cannot
  resolve the grantee and the sweep `continue`s, leaving the activity pending
  forever. Use refs + `grantee` (D3). C2.
- **B4 — The revoked consumer does not revoke.** `processGranteeActivities`
  drains `AuthorizationRevoked` and only regenerates; it never deletes the
  DataAuthorizations (`data-model/activities.ts` says "the workflow DELETEs
  them", but no such step exists). Replace with `processAuthorizationRevoked`.
  C2.
- **B5 — The landed UI revoke is dead and non-durable.**
  `ui/authorization/src/store/app.ts` exposes `revokeGrants`, but no view calls
  it; the RPC deletes grants and leaves the DataAuthorizations, so any later
  regeneration re-issues access. The authorization leg is the fix. C0/C2.
- **B6 — RPC errors are `S.Never`.** `RevokeGrants` throws strings; the UI gets
  a defect/500. Typed errors. C4.
- **B7 — `npm test` does not run the components suite.** `packages/components`
  has no `test` script; use `npx vitest run --project @elfpavlik/sai-components`.
  CONVENTIONS §7.

## 12. Reference — landed boundary design

These contracts are settled; keep them stable while working the slices.

**Messages.** Revocation: `interop:AccessRevocation`, `grants` = grant IRIs,
`type` is an array (`["http://www.w3.org/ns/solid/interop#AccessRevocation"]`).
Issuance: `interop:AccessRequest`, `grants` = full grant objects (the mirror
envelope). The delegation endpoint dispatches on `type` and requires
`content-type: application/ld+json`. Models live in
`packages/data-model/src/access-{request,revocation}.ts`; terms in
`packages/utils/src/namespaces.ts`.

**Authority.** The requester's client is the UA of the grant's `grantedBy`
(grantor branch) or the requester is the data owner (owner branch). Grantee
self-revocation is C4.

**Validation/deletion.** The whole request is validated before any mutation:
load each listed grant from the owner's registry, authority-check; then delete
the listed grants plus their `inheritsFromGrant` children with the owner's own
session (owner rights; grant ACRs give the grantor `acl:Read` only). Idempotent:
already-removed entries are echoed; the response equals the requested IRIs on
success. Full predicate closure and replace-vs-delete ordering are C1/C3.

**Wiring.** `CSS_SPARQL_ENDPOINT` is already passed to the auth/registry/data
services; `GrantRevocationHandler` takes the same `sparqlEndpoint` as
`GrantIssuanceHandler`. No new env vars.

**Retired.** `delegationOfGrant`, `authorizationRecorded` (deny is
`AuthorizationDenied`), `grantsRevoked`, `processGrantsRevocation`. Do not
reintroduce them.

## 13. Verification

Package gate (agent, from the repo root):

```bash
npm run typecheck
npx tsc -p packages/components/tsconfig.json --noEmit
npx vitest run --project @janeirodigital/interop-authorization-agent
npx vitest run --project @elfpavlik/sai-components
```

Baseline at `d7c89f43`: typecheck green; components 24 files / 184 tests (~4 s);
authorization-agent 17 files / 111 passed / 20 skipped (~2 s).

`/test` acceptance (user, dagger-managed; data from `/environments/data`):

- `test/delegation-endpoint.test.ts` — boundary issue/revoke, idempotency,
  read-only grant ACR.
- `test/revocation-rpc.test.ts` — owner RPC (keep green; update if the RPC
  becomes internal/deleted).
- `test/authorization.test.ts` — authorization leg and activity completion.
- `test/authorization-revocation.test.ts` (new, C2) — UI-shaped revoke path.
- `test/reconciliation.test.ts` — sweep backstop (C5).
- `test/check-equivalence.test.ts` / `test/services.test.ts` — C3.

The agent adds/updates these files in the same change set; a slice is marked
`landed (acceptance user-run)` until the user confirms the run.

## 14. Mapping from the former follow-ups

The old `revoke-delegation-chain-follow-ups.md` is absorbed as follows:

| Old item | Now |
|---|---|
| 1 full dependent-chain calculation | C1 |
| 2 scope/mode coverage ordering | C1 |
| 3 replace-vs-delete race | C3 |
| 4 trigger integration / grantor revocation | C3 (+ P3 from C2) |
| 5 grantee self-revocation | C4 |
| 6 revocation error-detail schema | C4 |
| 7 drop `delegationOfGrant` | ✅ done |
| 8 validate-request shape/rate | C5 |
| 9 `reconcileActivities` scheduling | C5 |
| 10 issuer-side replica cleanup | C3 |

Former `authorization-revoked.md` (deny → typed activity) is superseded: deny is
a pure decline (`AuthorizationDenied`); the revocation carrier is
`AuthorizationRevoked`, designed in
[`authorization-revocation.md`](authorization-revocation.md). Former
`authorization-revocation.md` §2–3 ("org session", "`Revoked` re-pin with target
dropped") are corrected by D3 and the org-context note in §11/B1.
