# Revocation of a delegation chain — follow-up slices

> **Status:** tracks the **remaining follow-up work** out of
> [`revoke-delegation-chain.md`](revoke-delegation-chain.md), whose first-cut
> slice (§10 steps 1–5) has landed. Each item below is a shippable checkpoint:
> code builds and **all tests pass** after each one, so they can land
> independently — the numbering reflects dependencies, not a mandatory order.
> Section/DD references point at `revoke-delegation-chain.md`.

## 1. Full dependent-chain calculation

**Context (§2 validity predicate, §3 deletion, §6).** The first cut revokes the
**listed grants plus their inheriting children** only (fixpoint over
`inheritsFromGrant`). The plan's chain validity is a recursive predicate over
D's registry — a grant is valid iff it is a source grant (`grantedBy ==
dataOwner`) or has a valid upstream g′ matching `grantee == g′.grantedBy`,
`dataOwner`, shapeTree/registration, scope- and mode-coverage. Full revocation
must remove every grant whose validity fails once the entry-point grant is
gone, not just same-request siblings.

**Scope.** Generalize the match-based direct-upstream check that
`GrantIssuanceHandler.validateDelegable` already performs into a recursive
reachability computation over D's SPARQL endpoint (visited-set termination —
no semantic cycles, no mutually-delegating bootstrap), and use it in three
places: revocation closure, issuance chain validation, and the sweep's
per-grant validation (follow-up 8).

**Green.** Revoking one entry-point grant removes the full dependent subchain
across delegating grantees (multi-hop A→B→C chains); the registry contains no
grant failing the predicate; tests for multi-hop chains, mutual delegation
(non-termination), and chain-invalidating scope/mode reductions.

## 2. Scope-coverage and mode-coverage ordering

**Context (§2 predicate, §4 semantic delta).** The predicate requires
comparing coverage of an upstream grant against a downstream one:
`All ⊃ AllFromRegistry ⊃ SelectedFromRegistry`, `Inherited` as a child scope,
and access-mode coverage per-mode vs. per-grant — currently asserted informally
in `validateDelegable`'s SPARQL (scope block + `VALUES ?mode`).

**Scope.** Formalize the ordering in one module consulted by the predicate (1),
semantic-delta derivation (4), and `check-equivalence` reuse; replace the
SPARQL scope/mode blocks with the formalized check.

**Green.** Unit tests for the ordering lattice and mode semantics;
issuance/revocation behavior unchanged on today's cases.

## 3. Replace-vs-delete race

**Context (§2 DD5 — grants immutable, replacement = delete old + create new).**
When a regeneration replaces a grant (new IRI), the old grant must leave D's
registry before — or atomically with — the new one's creation, so enforcement
(which collects *all* grants with `hasStorage`) never observes both, or
neither after a crash between the operations. The first cut tolerates the
race; the `deleteDataGrants` calls in `createGrantsForAgent` are commented
out for exactly this reason.

**Scope.** Ordering/failure handling for the delete-old/create-new pair
(transactional container or delete-then-create with compensating retry);
landing this re-enables the *replacement* deletion in `createGrantsForAgent`
(not the semantic-weakening revocation — that belongs to follow-up 4).

**Green.** Regeneration with replacement leaves exactly the new grant in the
registry across simulated failures; enforcement sees either old-only
(pre-create) or new-only (post-delete), never both.

## 4. Trigger integration — grantor regeneration requests revocation

**Context (§4).** The grantor's regeneration path (`createGrantsForAgent`)
must derive the **semantic delta** for a grantee and act on it: coverage
shrank/empty → request revocation at the data owner's endpoint for the
entry-point grant IRIs; coverage unchanged → keep existing grants (reuse, no
propagation); coverage grew/changed → request issuance for the new grants
only. **Today nothing produces a `grantsRevoked` activity** — the consumers
are all wired (`ActivityWebhookHandler` routing,
`reconcileActivities` handling, UI `events.ts` refresh map) and the requester
hop workflow operates, but no producer writes the pending activity, so the
integration is inert.

**Scope.** Semantic-delta derivation (depends on coverage ordering, 2, and
reuse equivalence) + the `grantsRevoked` producer (grantor-side outbox write
when the delta is a revocation); also a UI affordance on the grantor side may
leverage the same producer.

**Green.** Denying an app/agent (or reducing coverage) on the grantor side
removes the grant resources at the data owner and clears the grantor's
registration, driven end-to-end by the regeneration path (no manual
activity seeding as in today's requester-hop test).

## 5. Grantee self-revocation

**Context (§3 authority, DD11).** The first cut admits two requester classes:
the grantor (`grantedBy` match) and the data owner. "Remove my own access" is
a third branch: the grant's `grantee` (via their UA) revoking the grant they
hold.

**Scope.** Authority branch in `GrantRevocationHandler.revokeGrants`
(`requesterWebId == grant.grantee`), plus a UI affordance and — since the
grantee's own registry is not the grantor's — a registration-cleanup story
for the grantee's projection (or an explicit "delegated to sweep" decision).

**Green.** A grantee's authenticated request revokes its grant (and children)
with no mutation for anyone else; endpoint tests for the new branch.

## 6. Revocation error-detail schema

**Context (§3 all-or-nothing).** "If any check fails, nothing is mutated and
the request fails (**exact error-detail schema — TODO**)"; the same applies
symmetrically to `AccessRequest` issuance.

**Scope.** Define the failure response shape (which grant(s) failed and why:
unknown, wrong dataOwner, unauthorized) shared by the delegation endpoint and
the `RevokeGrants` RPC (whose failure channel is currently `S.Never` / thrown
errors).

**Green.** Client-parseable failure details for each all-or-nothing failure
case, asserted in endpoint and RPC tests.

## 7. Drop the vestigial `delegationOfGrant`

**Context (DD3).** The data model, generation, and context were supposed to
**drop `delegationOfGrant`**; chain validity is match-based and nothing
consumes the link anymore — issuance (`validateDelegable`) and revocation
validation are both match-based SPARQL. The link survives as data: `grant.ts`
(field + framing), `data-authorization.ts` (sets it on delegated grants and
children), `context.ts`, `GrantIssuanceHandler.buildInheritingGrant` (copies
it), the issued grant resources, and the seed (`environments/data/registry.trig`).

**Scope.** Remove the field from generation/framing/context and the
`delegationOfGrant` copy in the issuance handler; drop the triple from the
seed and from newly issued grants; update `data-model` framing tests
(`grant.test.ts`, `regressions.test.ts`), the `authorization-agent` generation
tests (`grant-generation.test.ts` asserts the field), and the components
`delegation-request.test.ts` fixture. The vocab term stays in both
`namespaces.ts` / `vocabularies.ts` (it remains a valid INTEROP term).

**Green.** No `delegationOfGrant` triple is written by issuance; framing tests
updated; revocation/issuance tests still green (behavior never depended on it).

**Coordination.** Executed as **step 0 of
[`check-equivalence.md`](check-equivalence.md)** (§2.0) — small enough not to
need a standalone plan; land it before any equivalence code so the compared
field set is stable.

## 8. Validate-request shape/rate for the System-2 sweep

**Context (§5 System 2).** The recurring reconciliation job re-derives each
grantee's delegation projection from **200-semantics projections** — never
status-probes of deleted resources. Open question: per-grant validation
against D's boundary endpoint (authoritative, `valid`/`invalid`/`unknown`)
vs. pure projection re-derivation (cheaper, eventually consistent).

**Scope.** Decide the sweep's detection mechanism, per-grant vs. per-grantee
granularity, and rate against D (batch validation requests? cached validity?).

**Green.** Sweep detects a revocation missed by the webhook cascade and
propagates one hop down, within the configured interval, without hammering
D's SPARQL endpoint.

## 9. `reconcileActivities` scheduling

**Context (§5 System 2).** `reconcileActivities` exists and is exercised by
the reconciliation tests but has **no caller/schedule** (Temporal schedule /
cron), no interval policy, no backoff on D-unreachable, and no per-account
fan-out. Assumed by System 2; explicitly out of scope of the base plan.

**Scope.** Schedule the job per authorization agent (interval, backoff on
D-unreachable treated as `stale — retry` never as revocation, per-account
fan-out), wiring `reconcileActivities` to it.

**Green.** A missed webhook delivery is corrected by the scheduled run within
the configured interval; D-unreachable periods retry without false
revocations.

## 10. Drop the issuer-side grant replica graphs on unlink

**Context (§8 DD5, [`check-equivalence.md`](check-equivalence.md) §2.1).** The
grantor-side replica created for grant reuse (`GRAPH <grantIri>` for delegated
grants) outlives grants that leave the registration (replaced by a
regeneration, unlinked, or revoked). The same lifecycle already leaves the
grant resources themselves orphaned because the cross-peer DELETE is off (DD2),
so the replica cleanup rides that work rather than shipping alone.

**Scope.** When the grant-resource cleanup lands, drop the replica graphs of
the then-unlinked grants (parent and children, each with its `meta:` twin) as
part of the same step — never touching our own grant-registry graphs.

**Green.** A replaced/revoked subtree leaves no local replica graphs behind;
re-running the cleanup is idempotent.
