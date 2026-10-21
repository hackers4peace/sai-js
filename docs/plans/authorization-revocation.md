# Authorization revocation — detailed design (workstream C0/C2)

> **Status:** 🔶 design ready — C0 (read-only view) and C2 (revocation
> end-to-end) of [`revoke-delegation-chain.md`](revoke-delegation-chain.md).
> **Last verified:** `d7c89f43` (2026-10-21) — the typed activity, routing, and
> consumer gaps checked against the tree.
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

The chain predicate (C1), reconciliation for every trigger (C3), self-revocation
and typed errors (C4), and the sweep (C5) live in the workstream plan. C2
consumes C1's closure and introduces P3/P4 (the first callers).

**Not in scope:** deny. `AuthorizeApp(granted: false)` writes
`AuthorizationDenied` — a pure, forward-only decline (no DataAuthorization is
created, no grant is cleared). Revocation is a separate, explicit operation.
Do not reintroduce revoke-on-deny.

## 2. Current state

| Piece | Status | Where |
|---|---|---|
| `AuthorizationRevoked` type | ✅ exists | `packages/data-model/src/activities.ts` (`object: string[]`, `target` retained) |
| RPC schema | ✅ exists | `packages/api-messages/src/effect.ts` (`AuthorizationRevoked`, unused by a producer) |
| Webhook routing | ✅ exists (replaced by C2) | `ActivityWebhookHandler.ts` starts the per-grantee consumer |
| Sweep grouping | ✅ exists | `workflows/grants.ts` (`reconcileActivities`) |
| UI done-row refresh | ✅ exists | `ui/authorization/src/events.ts` |
| Producer | ⬜ missing | no RPC/service writes the activity |
| DA deletion | ⬜ missing | the consumer only regenerates; no workflow deletes the DAs |
| Retry-safe carrier | ⬜ broken | live-link refs; after deletion the grantee is unresolvable |
| Authorization reader / UI | ⬜ missing | `RecordedDataAuthorization` schema is defined but unused |
| UI revoke action | ⬜ dead | `store/app.ts` `revokeGrants` is not called by any view; it targets grants |

The landed `RevokeGrants` RPC (owner boundary, grant IRIs) remains an internal
owner escape hatch at most; it is **not** the UI path and it has the org-context
gap described in the workstream §11/B1.

## 3. C0 — authorization read model and view

### 3.1 RPC

Add `ListAuthorizations` (name open; keep the request/response shapes stable):

```ts
export const ListAuthorizations = S.TaggedRequest<ListAuthorizations>()(
  'ListAuthorizations',
  {
    failure: S.Never, // or a typed read error
    success: S.Array(RecordedDataAuthorization), // existing schema
    payload: { grantee: IRI, context: IRI },
  }
)
```

`RecordedDataAuthorization` already carries `id`, `grantee`, `grantedBy`,
`registeredShapeTree`, `scopeOfAuthorization`, `dataOwner`,
`hasDataRegistration`, `accessMode`, `creatorAccessMode`, `hasDataInstance`,
`inheritsFromAuthorization`, `hasInheritingAuthorization`,
`satisfiesAccessNeed`. Extend it only with display labels (e.g.
`shapeTreeLabel: S.String` or a `shapeTree: { id, label }` struct), resolved by
the service like `getDescriptions` resolves access-need shape trees.

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

### 3.2 AA reader

Add `authorizationsForGrantee(grantee)` to the AA (domain logic belongs in
`packages/authorization-agent`), over the registry plane:

- list the authorization registry container;
- load each `DataAuthorization` (reuse `getDataAuthorizationFromSparql`);
- filter by `grantee` and `type.includes(INTEROP.DataAuthorization)`;
- optionally load `findInheritingAuthorizations` to guarantee children are
  present even if a parent's reverse list is stale (the forward
  `inheritsFromAuthorization` always survives; union both, as grant generation
  does).

### 3.3 UI

- Entry points: a **"Manage access"** action on `SocialAgentList` and
  `ApplicationList` rows (peer/application first; roles later).
- New view/dialog: group by `dataOwner`; nest inherited authorizations under
  their parent; per item show shape tree label, registration, scope, and access
  modes. Reuse the nested `v-list` + `v-checkbox-btn` + expansion-panel patterns
  from `AuthorizeApp.vue`; extract a small `AuthorizationTree.vue` if the
  duplication grows. The access-need/scope/registration/instance selection
  machinery is not reused — this view selects whole authorizations.
- Selection semantics (C2, but design them now): parent toggles descendants;
  indeterminate when partial; **select all** at the top; Revoke disabled when
  empty; confirmation dialog that states access will be removed and the grants
  will be reconciled.
- C0 ships the view with the Revoke action disabled (or absent). No writes.

## 4. C2 — producer and carrier

### 4.1 RPC

```ts
export class RevokeAuthorizations extends S.TaggedRequest<RevokeAuthorizations>()(
  'RevokeAuthorizations',
  {
    failure: RevocationFailure, // typed, C4; not S.Never
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

`reconcileGrantsForGrantee` (P4, introduced here; reused by C3):

1. Load existing grants (`getExistingGrants`) and bodies (own registry +
   issuer-side replica, `getExistingGrantBodies`).
2. Generate the desired set from the remaining authorizations for the grantee
   (`getAuthorizations` → `generateGrants`).
3. `checkEquivalence` → reused trees vs non-reused.
4. Remove the non-reused set, grouped by `dataOwner`:
   - `dataOwner == webId`: delete locally with the owner session (Temporal);
   - otherwise: `requestRevocations` (P3 — POST `AccessRevocation` to that
     owner, await the echo).
5. Issue the new generated trees (source grants locally, delegated via
   `requestDelegations`).
6. PATCH the registration projection to `[...reusedExisting, ...new]`.
7. Drop the issuer-side replica graphs for the removed delegated trees.

The full C3 section covers replacement ordering, the requester hop, and why the
old `deleteDataGrants` calls cannot simply be uncommented.

## 6. C2 — UI action

1. The user selects authorizations (parent = descendants; select all).
2. `effect.revokeAuthorizations(selectedIds, context)` calls the RPC and gets
   `{ activityId, authorizations }`.
3. `claimActivity({ context, type: 'AuthorizationRevoked', activityId })` — the
   same uniform claim anchor as `authorizeApp`/`deleteRole`/`toggleAdmin`.
4. Eagerly refresh the view (and the peer/app lists) after the ack; the
   `AuthorizationRevoked` done-row in `events.ts` refreshes both lists again
   (cheap, idempotent).
5. Remove `revokeGrants` from `ui/authorization/src/store/app.ts` and
   `effect.ts`; the UI no longer imports `RevokeGrants`.

The destructive action gets a confirmation dialog (the activity is async; the
snackbar shows pending → done). No grant IRIs are shown or sent.

## 7. Deletion, authority, idempotency

- **Deletion** uses the existing `deleteAuthorizations` activity
  (`packages/components/src/temporal/activities/grants.ts`): `session.fetch(iri,
  { method: 'DELETE' })`, 404-tolerant, with the owner/actor session. The worker
  mints the session via `buildSessionManager().getSession(actor)`; the API
  process does not mint an org session (`services/Context.ts`).
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

C0 tests:

- AA reader: SPARQL mock, a parent + child, a role grantee, an
  `AdminAuthorization` excluded, missing parent tolerated.
- components service: RPC shape, label resolution, context gating.
- UI typecheck.

C2 tests:

- data-model: `AuthorizationRevoked` framing/round-trip with refs + `grantee`.
- components producer: closure expansion, one activity per grantee, empty
  selection rejected, mixed grantee rejected, non-DA rejected, ack closure.
- components workflow (mocked activities): delete → reconcile per grantee →
  closure → complete; idempotent re-run; role expansion; retry after the DAs
  are gone (carrier `grantee`).
- AA: reconciliation/closure behavior (with C1); no mutation for unrelated
  grantees.

`/test` acceptance (user):

- `test/authorization-revocation.test.ts` (new): approve → revoke selected
  authorization(s) → authorizations gone, grants gone, registration projection
  clean, done event; a later approve/regenerate does not resurrect access.
- parent+child selection: revoking the parent removes both.
- `test/authorization.test.ts` stays green (deny remains a pure decline).
- `test/revocation-rpc.test.ts` stays green if the internal RPC survives; update
  it if the RPC is deleted.

## 9. Out of scope

- **C1** chain predicate and closure — [`revoke-delegation-chain.md` §6].
- **C3** reconciliation for every trigger, replacement ordering, requester hop,
  replica cleanup — [`revoke-delegation-chain.md` §8].
- **C4** self-revocation and typed errors — [`revoke-delegation-chain.md` §9].
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
