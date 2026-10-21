# Authorization revocation — detailed design (workstream C0/C2)

> **Status:** ✅ C0 and C2 landed (package-tested; `/test` acceptance confirmed —
> dagger green 2026-10-21);
> the C3 projection + GC landed with C2 (`reconcileGrantsForGrantee` is the
> `createGrantsForAgent` body). C4 (typed revocation failures + the
> boundary-path owner projection cleanup) landed; grantee self-revocation was
> **removed by design review** (D17) and the owner `RevokeGrants` RPC was
> **deleted** (D18) — grants are projections, so revocation is only the
> authorization leg. The C4/C5 design lives in
> [`revoke-delegation-chain.md`](revoke-delegation-chain.md).
> **Last verified:** `2381ecd2` (2026-10-21) — C0–C4 landed and committed,
> package-tested, and `/test`-accepted (dagger green); D17/D18 removals
> included.
> **Green gate:** [§8](#8-green-gate--acceptance). **Absorbs:** the former
> `authorization-revoked.md` (deleted; its deny-as-revoke premise is
> superseded). **Workstream home:** [`revoke-delegation-chain.md`](revoke-delegation-chain.md).

## 1. Principle and scope

**Authorizations are the mutable source of truth; grants are projections.** The
UI only authors authorizations. Revoking access means deleting the selected
`DataAuthorization` resources; the workflow then reconciles the grant
projections from the remaining authorization state.

This file covers:

- **C0** — the authorization read model and the read-only UI view.
- **C2** — the authorization-level revoke RPC, the `AuthorizationRevoked`
  carrier, the `processAuthorizationRevoked` workflow, and the UI action.

The chain predicate (C1), reconciliation for every trigger (C3), typed errors +
owner projection cleanup (C4; grantee self-revocation removed — D17), and the
sweep (C5) live in the workstream plan. C2
consumes C1's closure and introduces P3/P4 (the first callers).

**Not in scope:** deny. `AuthorizeApp(granted: false)` writes
`AuthorizationDenied` — a pure, forward-only decline (no DataAuthorization is
created, no grant is cleared). Revocation is a separate, explicit operation.
Do not reintroduce revoke-on-deny.

## 2. Current state

| Piece | Status | Where |
|---|---|---|
| `AuthorizationRevoked` type | ✅ exists | `packages/data-model/src/activities.ts` (`object: string[]`, `target` retained) |
| RPC schema | ✅ exists | `packages/api-messages/src/effect.ts` (`AuthorizationRevoked`; `failure: AuthorizationRevocationFailure` — C4) |
| Webhook routing | ✅ landed | `ActivityWebhookHandler.ts` + `reconcileActivities` start `processAuthorizationRevoked`; the per-grantee consumer/signal was removed |
| Sweep grouping | ✅ exists | `workflows/grants.ts` (`reconcileActivities`) |
| UI done-row refresh | ✅ exists | `ui/authorization/src/events.ts` |
| Producer | ✅ landed | `revokeAuthorizations` (`services/Authorization.ts`); `RevokeAuthorizations` RPC |
| DA deletion | ✅ landed | `deleteAuthorizations` in `processAuthorizationRevoked` |
| Retry-safe carrier | ✅ landed | refs `{ id, type }` + `grantee` (no deref after deletion) |
| Authorization reader / UI | ✅ C0 landed (acceptance confirmed 2026-10-21) | `findAuthorizationsForGrantee` (`authorization-agent/src/sparql.ts`, context-aware); `listAuthorizations` (`services/Authorization.ts`); `ListAuthorizations` (`api-messages`); `ui/.../views/Authorizations.vue` |
| UI revoke action | ✅ landed | `Authorizations.vue` selection/select-all → `RevokeAuthorizations`; the old `revokeGrants` UI binding was removed |

The `RevokeGrants` RPC was **deleted** (D18): it was an internal owner escape
hatch with no UI caller and let the owner delete grants without an authorization
change. The grant boundary stays as the projection transport used by the
workstream's GC (`requestRevocations`).

## 3. C0 — authorization read model and view

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21).

### 3.1 RPC

`ListAuthorizations` (landed):

```ts
export const ListAuthorizations = S.TaggedRequest<ListAuthorizations>()(
  'ListAuthorizations',
  {
    failure: S.Never,
    success: AuthorizationList,
    payload: { grantee: IRI, lang: S.String, context: IRI },
  }
)
```

`RecordedDataAuthorization` already carried `id`, `grantee`, `grantedBy`,
`registeredShapeTree`, `scopeOfAuthorization`, `dataOwner`,
`hasDataRegistration`, `accessMode`, `creatorAccessMode`, `hasDataInstance`,
`inheritsFromAuthorization`, `hasInheritingAuthorization`,
`satisfiesAccessNeed`; C0 added the resolved `shapeTreeLabel: S.String` and
`AuthorizationList = S.Array(RecordedDataAuthorization)`. The service resolves
the label like `getDescriptions` does and falls back to the shape-tree IRI when
the description is unavailable.

Rules:

- The service reads the actor's **authorization registry** for `ctx.webId`;
  never trust a client-supplied list of resources.
- Return **flat**; the UI nests by `inheritsFromAuthorization`. The service
  includes every authorization whose `grantee` is the requested IRI,
  type-filtered to `interop:DataAuthorization` (admin authorizations are a
  different type and are excluded).
- A child whose parent is not in the result (or is missing) renders at the root
  with a warning; do not silently drop it.
- Roles: the same reader works with a role IRI as `grantee`; the UI can add the
  role entry later.

### 3.2 AA reader (context-aware)

The registry-plane read is the exported
`findAuthorizationsForGrantee(transport, registrySet, grantee)` in
`packages/authorization-agent/src/sparql.ts`:

- lists the authorization registry container (`listContained`);
- loads each `DataAuthorization` (`getDataAuthorization`);
- includes direct authorizations **and** authorizations granted to a role the
  grantee belongs to (`findRolesWithMember`), type-filtered to
  `interop:DataAuthorization`;
- returns `inheritsFromAuthorization` on the child rows, which the UI uses to
  nest.

The existing class method `AuthorizationAgent.findAuthorizationsForAgent`
delegates to it with the session's own endpoint/registry (personal context).
The service calls the function with `sparqlTransportFor(ctx)` and
`ctx.registrySet`, so an **org context** reads the org's registry through
`/sparql-admin` instead of the signed-in admin's personal registry. C0
deliberately did not add a second reader method.

### 3.3 UI (landed)

- Entry points: a **“Manage access”** icon button on `SocialAgentList` and
  `ApplicationList` rows; both route to `authorizations` with
  `grantee`, `label`, and `kind` query params.
- `ui/authorization/src/views/Authorizations.vue`: cards grouped by data owner,
  a globally built tree from `inheritsFromAuthorization` (children stay under
  their parent even when the child omits `dataOwner`), depth indentation,
  shape-tree label, scope/registration subtitle, access-mode chips, and a
  `via role` note when the authorization is granted to a role.
- Selection semantics remain C2: parent toggles descendants; indeterminate when
  partial; **select all** at the top; Revoke disabled when empty; confirmation
  dialog. C0 is read-only — no checkboxes and no writes.

## 4. C2 — producer and carrier

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21).

### 4.1 RPC

```ts
export class RevokeAuthorizations extends S.TaggedRequest<RevokeAuthorizations>()(
  'RevokeAuthorizations',
  {
    failure: AuthorizationRevocationFailure, // typed (C4) — not S.Never
    success: S.Struct({
      activityId: IRI,
      authorizations: S.Array(IRI), // the expanded closure
    }),
    payload: {
      authorizations: S.Array(IRI),
      context: IRI,
    },
  }
) {}
```

One grantee per call (the UI view is per grantee). If a future call needs to
span grantees, group in the service and change the success shape to
`activityIds: IRI[]`; do not invent a multi-grantee activity.

### 4.2 Service (`revokeAuthorizations`)

1. Resolve the context (`resolveContext`).
2. Reject an empty selection (`BadRequest`).
3. Load each selected authorization from `ctx.registrySet.hasAuthorizationRegistry`
   (SPARQL/AA reader), asserting:
   - it exists and is a `DataAuthorization` (not an `AdminAuthorization`);
   - it belongs to the actor's authorization registry;
   - all selected authorizations share one `grantee`.
4. Expand the closure: selected IDs **plus** every descendant via
   `inheritsFromAuthorization` (the forward link; union the stored reverse
   list). If a parent is selected, all descendants are included; if only a child
   is selected, only that child. Deduplicate.
5. Write **one** `AuthorizationRevoked` activity with the refs + `grantee`:

```ts
export interface DataAuthorizationRef {
  id: string
  type: string[]
}

export type AuthorizationRevoked = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AuthorizationRevoked']
  /** the registry owner */
  actor: string
  /** selected authorizations + expanded descendants — refs only */
  object: DataAuthorizationRef[]
  /** routing key; survives deletion of the referenced resources */
  grantee: string
}
```

6. Return `{ activityId, authorizations: closureIds }`.

**Why `grantee`:** the workflow deletes the referenced resources. If it crashes
after the delete but before completion, a retry or the sweep can no longer
dereference `object[0]` for the grantee; without it the activity is stranded
forever. The refs remain refs; `grantee` is the only added routing field.
**Why expand at write time:** after deletion the inheritance tree is gone; the
closure must be captured before it.

This is a coordinated break (data model, api-messages, producer, webhook
handler, sweep, tests). The seeded data contains no revoked activities, so no
seed migration is needed; existing resources with the old shape are inert and
never produced by the new code.

## 5. C2 — workflow `processAuthorizationRevoked`

**Status:** ✅ landed (package-tested; `/test` acceptance confirmed 2026-10-21).

Task queue `create-grants`; mirrors `processAuthorizationGranted` and
`processAdminAuthorizationRevoked`. No per-grantee coalescing — revocation is
rare and the parent owns completion.

```
processAuthorizationRevoked(
  webId: SocialAgentId,
  authorizations: DataAuthorizationRef[],
  grantee: string,
  activity: ActivityRef
)
  1. deleteAuthorizations({ webId, authorizations })      // existing activity
  2. grantees = getGrantees({ webId, grantee })            // roles → members
  3. for each grantee:
       reconcileGrantsForGrantee({ webId, grantee })       // P4
  4. for each affected dataOwner:
       run the chain closure (C1) over its registry        // local or via the
                                                          // boundary request
  5. markActivitiesDone({ webId, activities: [activity] })
```

Order matters:

- **Delete the authorizations first.** They are the source of truth; the grant
  reconciliation must read the remaining state. If the workflow crashes after
  step 1, a retry still has the refs and `grantee` and can finish (deletes are
  404-tolerant).
- **Reconcile per affected grantee, not per authorization.** Do not try to map
  authorization IRIs to grant IRIs; the desired grant set is derived from the
  remaining authorizations for that grantee. This is the "grants are
  projections" rule.
- **Chain closure after the projection reconciliation.** The directly affected
  grantee's reconciliation removes its own non-reused trees. Downstream
  delegated grants belong to other grantees and are removed by C1's closure at
  the data owner (the boundary handler runs it for peer-owned registries; the
  local owner workflow runs it for its own registry).
- **Complete last.** A `done` event must mean the authorizations are gone, the
  grants are reconciled, and the invalid downstream grants are gone. Children
  never mark the activity done.

`reconcileGrantsForGrantee` (P4, introduced here; reused by C3) is the
**projection + garbage collection** model (D13), not a revocation-specific
path:

1. **Desired** = generate from the remaining authorizations for the grantee
   (`getAuthorizations` → `generateGrants`). An empty authorization set is just
   an empty desired set — the deny case uses the same path (no short-circuit).
2. **Existing** = the grantee's grant resources: the registration projection
   (`getExistingGrants`) **plus an own-registry orphan scan** for grants whose
   `grantee` matches but are no longer linked (bodies from the own registry /
   issuer-side replica, `getExistingGrantBodies`). The orphan scan recovers
   after a crash between delete and projection PATCH. A peer-side orphan scan
   remains a C5 follow-up.
3. **Equivalence** (`checkEquivalence`): generated trees pair with existing
   trees as whole subtrees (value-based; ids/structural links not compared).
   `reusedExisting` is the keep set; an identical replacement reuses the same
   IRIs (no churn).
4. **GC** = `existing − reusedExisting`, grouped by `dataOwner`:
   - `dataOwner == webId`: delete locally with the owner session (Temporal,
     404-tolerant);
   - otherwise: `requestRevocations` (P3 — POST `AccessRevocation` to that
     owner, await the echo).
   Delete each removed grant **and its ACR**; drop the issuer-side replica
   graphs for removed delegated trees (parent + children, `meta:` twins).
   A peer-owned grant with **no replica body** cannot be owner-grouped: it is
   skipped here and left to the data owner's sweep/closure (already excluded
   from the projection). Own-registry grants are removed by IRI even without a
   body — `revokeGrantClosure` loads the registry itself.
5. **Create** the unmatched desired trees (source grants locally, delegated via
   `requestDelegations`).
6. **PATCH the registration projection** to `[...reusedExisting, ...new]` last;
   a crash before it leaves a stale projection that the next reconciliation /
   sweep heals (enforcement is already correct).

**Ordering:** delete the GC set before creating the new set. Enforcement
collects every grant with `hasStorage`; create-first leaves a fail-open window
where the old (possibly broader) grant still confers access, delete-first
leaves a short fail-closed window that Temporal retries.

The full C3 section covers the two-pass model (projection GC here, C1 chain GC
for other grantees), replacement ordering, the requester hop, and why the old
`deleteDataGrants` calls cannot simply be uncommented.

## 6. C2 — UI action

**Status:** ✅ landed (package-tested; UI `vite build` green).

1. The user selects authorizations (parent = descendants; select all).
2. `effect.revokeAuthorizations(selectedIds, context)` calls the RPC and gets
   `{ activityId, authorizations }`.
3. `claimActivity({ context, type: 'AuthorizationRevoked', activityId })` — the
   same uniform claim anchor as `authorizeApp`/`deleteRole`/`toggleAdmin`.
4. Eagerly refresh the view (and the peer/app lists) after the ack; the
   `AuthorizationRevoked` done-row in `events.ts` refreshes both lists again
   (cheap, idempotent).
5. Remove `revokeGrants` from `ui/authorization/src/store/app.ts` and
   `effect.ts`; the UI never imports `RevokeGrants` (the RPC was later deleted —
   D18).

The destructive action gets a confirmation dialog (the activity is async; the
snackbar shows pending → done). No grant IRIs are shown or sent.

## 7. Deletion, authority, idempotency

- **Deletion** uses the existing `deleteAuthorizations` activity
  (`packages/components/src/temporal/activities/grants.ts`): `session.fetch(iri,
  { method: 'DELETE' })`, 404-tolerant, with the owner/actor session. The worker
  mints the session via `buildSessionManager().getSession(actor)`; the API
  process does not mint an org session (`services/Context.ts`).
- **Typed failures (C4).** The producer throws `AuthorizationRevocationError`
  (`empty-selection`, `not-a-data-authorization`, `mixed-grantee`) plus the
  context refusal; the `RevokeAuthorizations` RPC declares
  `failure: AuthorizationRevocationFailure` and the UI shows the code instead
  of a defect/500. The grant boundary returns the AA's `RevocationError` codes
  as an HTTP status + JSON body (workstream §9); it has no RPC.
- **Authority** for the authorization leg is the context owner: the actor is
  the registry owner (`ctx.webId`), gated by `resolveContext` (personal or org
  admin). A grantor revoking authorizations it recorded for a peer's data uses
  the same leg; its grant reconciliation groups by `dataOwner` and uses the
  boundary for the peer-owned grants.
- **Idempotency:** a re-run deletes 404s, reconciles to the same desired set,
  and completes. Re-revoking an already-deleted authorization through the RPC
  is a no-op success (it may find nothing to write; decide whether to return
  the prior activity or a `no-op` result — pin in implementation).
- **`AuthorizationDenied` is untouched.** Deny remains a forward-only decline.

## 8. Green gate & acceptance

Package gate (root):

```bash
npm run typecheck
npx tsc -p packages/components/tsconfig.json --noEmit
npx vitest run --project @janeirodigital/interop-authorization-agent
npx vitest run --project @elfpavlik/sai-components
```

C0 tests (landed):

- `packages/components/test/authorizations.test.ts`: mapping to the RPC shape,
  shape-tree label resolution and IRI fallback, optional-field omission, empty
  list. The AA reader's direct/via-role and inherited-child cases are covered by
  the existing `findAuthorizationsForAgent` tests.
- `npx tsc -p packages/components/tsconfig.json --noEmit`.
- UI: `cd ui/authorization && npx vite build`. **Do not use `vue-tsc` as a gate
  yet** — the UI baseline is already red because the UI's own `node_modules`
  and the symlinked packages resolve two different Effect type identities.

C2 tests:

- data-model: `AuthorizationRevoked` framing/round-trip with refs + `grantee`.
- components producer: closure expansion, one activity per grantee, empty
  selection rejected, mixed grantee rejected, non-DA rejected, ack closure.
- components workflow (mocked activities): delete → reconcile per grantee →
  closure → complete; idempotent re-run; role expansion; retry after the DAs
  are gone (carrier `grantee`).
- AA: reconciliation/closure behavior (with C1); no mutation for unrelated
  grantees.

C4 additions (landed; see the workstream plan §9 for the full gate):

- `packages/components/test/revocation-errors.test.ts`: the authorization-leg
  RPC failure schema + the grant-boundary HTTP status/body per code.
- `packages/components/test/grants-workflow.test.ts`: `revokeGrants` deletes the
  closure before the owner-side registration PATCH (D14).
- AA `revokeGrants core`: grantor/owner authority only (a grantee request is
  rejected), mixed-owner on the requested set, wrong-data-owner, idempotent
  echo.

`/test` acceptance (confirmed green 2026-10-21):

- `test/delegation-endpoint.test.ts` (C4): mixed-owner typed failure with no
  partial apply, unknown-grant refusal, 403 body code. (Grantee self-revocation
  and the owner `RevokeGrants` RPC suite were removed — D17/D18.)
- `test/authorizations.test.ts` (new, C0): read-only listing for a seeded
  grantee (parent + inherited child) and the empty case.
- `test/authorization-revocation.test.ts` (new, C2): revoke the seeded
  authorizations for bob → DAs gone, the four derived grants gone, the
  registration projection empty, done event; re-revoking is a no-op success.
- parent+child selection: revoking the parent removes both.
- `test/authorization.test.ts` stays green (deny remains a pure decline).

## 9. Out of scope

- **C1** chain predicate and closure — [`revoke-delegation-chain.md` §6].
- **C3** reconciliation for every trigger, replacement ordering, requester hop,
  replica cleanup — [`revoke-delegation-chain.md` §8].
- **C4** typed errors + owner projection cleanup (grantee self-revocation
  removed — D17) — [`revoke-delegation-chain.md` §9].
- **C5** sweep scheduling/validation — [`revoke-delegation-chain.md` §10].
- Org-admin authorization revocation (`AdminAuthorizationRevoked`) is a
  separate, landed path; do not reuse `DataAuthorization` deletion for it.

## 10. Superseded material (for history)

The former `authorization-revoked.md` proposed typing `recordAuthorization`'s
deny as `authorizationRevoked`. That is superseded:

- deny is now `AuthorizationDenied` (pure decline, no delete, no grant clear);
- `authorizationRecorded` no longer exists;
- `AuthorizationRevoked` already exists with a different shape and full routing;
- the missing piece is the producer + workflow, not the activity type.

The previous revision of this file §2–3 said the carrier re-pin lands with a
now-removed `authorization-granting.md`, that `target` is dropped with an
embedded/live-link form, and that the leg revokes "with the org session". Those
are corrected by D3 (refs + `grantee`, `target` dropped), this file §4, and the
org-context note in the workstream §11/B1. `grantsRevoked` and
`processGrantsRevocation` stay retired; do not revive them.
