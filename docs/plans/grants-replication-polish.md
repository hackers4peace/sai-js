# Grants replication polish — orphan scan, stranded revocation, role grantees, tests

> **Status:** ⬜ not started (design ready). The revocation workstream is
> **closed** (landed design:
> [`../../openwiki/architecture/authorization-revocation.md`](../../openwiki/architecture/authorization-revocation.md));
> this plan owns the four remaining C5 polish items (#4–#7) that are not
> scheduling or out of scope.
> **Last verified:** `b9f01a17` (2026-10-21) — C0–C5 runtime landed; the
> production schedules/cadence and activity-webhook channel healing live in
> [`update-deployment.md` §F](update-deployment.md#workstream-f--scheduled-reconciliation-c5--channel-healing).
> **Green gate:** package gate below + `/test` acceptance (user-run).
> **Workstream:** follow-up to the closed revocation workstream (C0–C5).
> Landed design: OpenWiki `architecture/authorization-revocation.md`,
> `architecture/federation.md`, `architecture/grant-reuse.md`,
> `services/activity-lifecycle.md`.

## Context

Grants are **projections of authorizations**; the landed workstream delivers:

- C0–C4: authorization view, chain validity/closure, authorization revocation,
  projection + GC reconciliation, typed revocation errors, owner projection
  cleanup;
- C5 runtime: pending-activity drain, authorization-vs-projection drift
  (D19), reciprocal-mirror local completeness + peer freshness (D20), the
  per-peer forced sync, and the mirror no-op guard (only `hasDataGrant`
  compared);
- **out of scope:** grantee self-revocation (D17) and batch boundary validation
  (D21);
- **deployment:** schedules/cadence and activity-webhook channel healing
  ([`update-deployment.md` §F](update-deployment.md#workstream-f--scheduled-reconciliation-c5--channel-healing)).

This plan owns the four remaining polish items. None is a new capability
slice; each closes a recovery/verification gap in the landed replication model.

## State map

| Item | Status | Code anchors | Verified by | Notes |
|---|---|---|---|---|
| Peer-side orphan scan | ⬜ open | `getRegistryGrantsForGrantee` (`activities/grants.ts`); `storeGrantReplica`/`dropGrantReplicas` (`services/GrantReplica.ts`); `reconcileGrantsForGrantee` | package + `/test` | Own-registry orphan scan landed in C3; peer-owned orphans with a **local replica body** are still invisible to `existing` |
| Stranded `AuthorizationRevoked` end-state | ⬜ open (verify) | `reconcileActivities` → `processAuthorizationRevoked` (`workflows/grants.ts`) | package + `/test` | Routing already works (404-tolerant DA deletes); add the explicit end-state verification/test |
| Role-grantee projection healing | ⬜ open (verify) | `removeGrantsFromRegistrations` skips role grantees; `reconcileGrantsForGrantee` per member; `findAuthorizationsForAgent` includes via-role | package + `/test` | Expected to be covered by the D19 drift arm for registered members; prove it, fix only if the test fails |
| Tests / docs | ⬜ open | `test/reconciliation.test.ts`, package suites | gate | Remaining acceptance for the three items above |

## P1 — Peer-side orphan scan

**Problem.** C3's `existing` set is the registration projection plus the
**own-registry** orphan scan (`getRegistryGrantsForGrantee`). Peer-owned grants
(`dataOwner` is a peer) live in the data owner's registry; the grantor keeps
only the **issuer-side replica** (`storeGrantReplica`: one graph per grant IRI
in the grantor's registry-pod dataset). A peer-owned grant that is no longer
linked from the projection — e.g. a crash between delete and the registration
PATCH, or a lost link — is invisible: it is not in the grantor's own grant
registry and not in the projection. It can still confer access at the owner.

**Recommended shape (local, no new wire primitive):** replica-based orphan scan.

- Enumerate issuer-side replica bodies for the grantee (one SPARQL query over
  named graphs, filtering `interop:grantee`; exclude `dataOwner == webId`).
- Treat them like the own-registry orphan scan: union into `existing` in
  `reconcileGrantsForGrantee`, so `existing − reusedExisting` includes the
  orphan and GC can group it by `dataOwner` from the local body.
- GC path is the existing one: `requestRevocations` per data owner, then
  `dropGrantReplicas`.
- A peer-owned grant with **no** replica body remains out of reach (no owner
  grouping); it stays the data owner's sweep/closure — document that.

**Open decisions:**
- Scan all replica graphs vs maintain a replica index (the current store has no
  container for replicas).
- Include replicas whose `grantee` is a role? (Replica bodies are generated per
  agent; treat role IRIs as out of scope like the projection.)

**Green:** package test that an unlinked replica body is GC'd via
`requestRevocations` + `dropGrantReplicas`; `/test` crash simulation (delete the
projection link while the grant remains at the owner with a local replica; run
the sweep; assert the owner deleted the grant and the replica is gone).

**Overlap:** `pod-isolation-followup.md` A1 owns the **reciprocal-mirror**
backfill/drift; this is the **grant replica** (grantor direction). Do not
duplicate.

## P2 — Stranded `AuthorizationRevoked` end-state

**Problem.** A pending `AuthorizationRevoked` whose data authorizations were
already deleted is already re-driven by `reconcileActivities` (the carrier has
refs + `grantee`, and `processAuthorizationRevoked` uses 404-tolerant deletes,
reconciles, and completes). What is missing is the explicit **end-state check**
and a test: completion must mean the referenced authorizations are gone **and**
the grantee's projection has been reconciled against the remaining
authorizations (no grants derived from the removed authorizations remain).

**Shape:**
- Before `markActivitiesDone` (or as a small pre-completion activity), verify
  the refs are absent and the grantee's projection matches the desired set
  (the reconciliation is idempotent; a mismatch re-runs it).
- Do not assert "the grantee has no grants" in general — it may have other
  authorizations. Assert only that nothing derived from the revoked
  authorization remains.
- Keep the existing routing for a pending activity with missing refs; the
  sweep must not skip it as "nothing to do".

**Green:** package workflow test with a pending `AuthorizationRevoked` whose
refs are 404 and whose grants were already removed → completes; a case where
the projection still links a removed grant → reconciled before completion.
`/test`: create the activity with deleted refs, run the sweep, assert done and
no resurrection.

## P3 — Role-grantee projection healing

**Problem.** `removeGrantsFromRegistrations` removes the owner's `hasDataGrant`
links for the removed grants grouped by `grantee`; a role grantee has no agent
registration, so it is skipped. The C4 note said role members' links heal via
reconciliation/the sweep.

**Verify:** the D19 drift arm re-runs `reconcileGrantsForGrantee` for every
**registered** member; `getAuthorizations` includes via-role authorizations, so
the member's desired set drops the role-derived grants and
`replaceDataGrantsOnRegistration` re-links only the remaining ones. Expected to
be covered; add a package/`/test` case (role-granted authorization revoked or
role membership changed → member projection links stale grants removed, no
unrelated grants touched). Fix only if the test exposes a gap (e.g. a member
without a direct authorization or a missing registration).

**Green:** package workflow test for the per-member diff; `/test` role revoke →
member registration links no longer include the removed grant. `roles.test.ts`
or `reconciliation.test.ts`.

## P4 — Tests / docs

- Package tests for P1–P3; extend `/test/reconciliation.test.ts` (orphan
  replica GC, stranded activity, role-grantee links).
- Update the OpenWiki if a design changes (federation/grant-reuse); keep
  `update-deployment.md` §F as the scheduling owner.
- `/test` acceptance is user-run; mark items landed only after the user
  confirms.

## Green gate

```bash
npm run typecheck
npx tsc -p packages/components/tsconfig.json --noEmit
npx vitest run --project @janeirodigital/interop-authorization-agent
npx vitest run --project @elfpavlik/sai-components
cd ui/authorization && npx vite build   # if UI changes
```

`/test` acceptance (user-run, dagger): `test/reconciliation.test.ts` extended;
`test/roles.test.ts` / `test/authorization-revocation.test.ts` as needed.

## Out of scope

- Batch boundary validation (P5) — **out of scope** (closed workstream D21).
- Scheduling, cadence/config, and activity-webhook channel healing —
  [`update-deployment.md` §F](update-deployment.md#workstream-f--scheduled-reconciliation-c5--channel-healing).
- Grantee self-revocation (D17; future shadowing / need-based revocation
  request).
- Production deployment/migration.

## Related

- Closed revocation workstream (C0–C5, decisions D1–D21) and the C0/C2 detail:
  [`architecture/authorization-revocation.md`](../../openwiki/architecture/authorization-revocation.md).
- OpenWiki: `architecture/federation.md` (mirror + replica), 
  `architecture/grant-reuse.md` (equivalence/reuse), 
  `services/activity-lifecycle.md` (activities/outbox).
- [`pod-isolation-followup.md`](pod-isolation-followup.md) A1 (reciprocal-mirror
  backfill/drift, not the grant replica).
