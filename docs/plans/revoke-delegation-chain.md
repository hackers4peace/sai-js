# Revocation of a delegation chain at the data-owner boundary

> **Status:** the **first-cut implementation slice has landed** — §10 steps
> 1–5 are implemented (contract, authority, atomicity, requester hop,
> data-owner UI RPC); remaining follow-up work is tracked in
> [`revoke-delegation-chain-follow-ups.md`](revoke-delegation-chain-follow-ups.md).
> Builds on the delegation model in
> `refactor-grants-workflows.md` (delegated grants, commented-out DELETEs —
> design decision 3) and on [`authorization-revoked.md`](authorization-revoked.md)
> (typed producer activity). Replaces direct cross-peer DELETE of grant
> resources with a **revocation operation at the delegation issuance boundary**
> and **replaces the `delegationOfGrant` link with match-based chain validity**
> (the now-vestigial link's removal is
> [follow-up 7](revoke-delegation-chain-follow-ups.md#7-drop-the-vestigial-delegationofgrant)).

> **First cut** (§3, §5, §6): revocation deletes the **listed grants plus their
> inheriting children** (one level, recursive-ready) only; full dependent-chain
> calculation (the §2 predicate over D's SPARQL endpoint) is a tracked
> follow-up ([item 1](revoke-delegation-chain-follow-ups.md#1-full-dependent-chain-calculation)).

## 1. Problem

- All grant resources for a data owner live in **that data owner's grant
  registry** (source and delegated). Registration `hasDataGrant` links are
  only a projection of the registry on each grantor's side.
- **Enforcement is derived from the registry**, not the links:
  `SaiPermissionsEngine` → `SaiAuthorizationManager.getAuthorizationData`
  collects every grant resource with `hasStorage` pointing at the pod. A grant
  resource that still exists **still confers access**, even if no registration
  links it.
- Today's revocation is grantor-side only (`AuthorizeApp` `granted: false`):
  it deletes authorizations and clears the registration link
  (`replaceDataGrantsOnRegistration([])`) but **never removes grant
  resources** — and direct cross-peer DELETE is the wrong seam (authority,
  knowledge, side-effects-as-protocol; see the 403 analysis in
  `refactor-grants-workflows.md` design decision 3).
- Chain churn: with `delegationOfGrant`, any upstream replacement (new grant
  IRI after regeneration) breaks the link and forces propagation all the way
  down the chain — even when nothing semantically changed.

## 2. Principle — match-based chain validity, no `delegationOfGrant`

Delegated grants **drop `delegationOfGrant`**. Instead, chain validity is a
**predicate** computed by matching:

> Grant g is **valid** iff:
> - `g.grantedBy == g.dataOwner` (source/root grant — issued by the owner) and
>   g exists in the registry; **or**
> - ∃ grant g′ in the registry with
>   `g′.grantee == g.grantedBy` ∧ `g′.dataOwner == g.dataOwner` ∧
>   matching `registeredShapeTree`/`hasDataRegistration` ∧
>   `g′.scopeOfGrant` covers `g.scopeOfGrant` ∧
>   `g′.accessMode ⊇ g.accessMode` (instance coverage for
>   `SelectedFromRegistry`) ∧ **g′ itself valid**.

- **Rooted termination:** validity is rooted reachability (visited-set); a
  chain that never reaches a source grant (where `grantedBy == dataOwner`) is
  invalid — this also prevents mutual delegations from bootstrapping a
  "valid" cycle.
- Half the predicate already exists: `GrantIssuanceHandler`'s issuance SPARQL
  validates the **direct** upstream (grantee/grantedBy, dataOwner,
  shapeTree/registration, modes, scope coverage). This design generalizes it
  to a recursive chain check, reused by issuance, validation, and revocation.
- **Grants are immutable; replacement = delete old + create new.** A leftover
  old grant would keep conferring access (the engine collects all grants with
  `hasStorage`), so old versions must leave the registry. Deleting old +
  creating new is done only by the data owner (owner rights — no ACR issue).
- **Replacement is not propagation:** if an upstream grant is replaced by one
  with identical (or covering) semantics, downstream grants *automatically
  re-anchor* via the predicate — a new upstream grant is just another valid
  g′. Only **semantic weakening** (revocation, scope/mode reduction) can
  invalidate downstream grants and require propagation.
- `hasInheritingGrant`/`inheritsFromGrant` (scope-inheritance children) are
  **kept**: they are created atomically in the same delegation request as
  their parent and replaced/die with it — same-request siblings, no
  cross-request churn.
- Synergy with `check-equivalence.md`: reuse becomes natural. Regeneration
  issues a new grant only when coverage actually changes; an existing grant
  that still matches is kept, so the semantic delta (not IRI churn) drives
  issuance and revocation.

## 3. Boundary operation — revocation at the delegation endpoint

Mirror of issuance, at the same endpoint; the delegation endpoint dispatches on
the message `type`.

**Contract.** A revocation is a typed message:

```json
{
  "type": "interop:AccessRevocation",
  "grants": ["https://registry/acme/grant/…"]
}
```

`grants` carries **grant IRIs only** (no grant bodies). Issuance uses the mirror
envelope `interop:AccessRequest` with full grant objects in `grants`. The
response returns **the removed IRIs** (mirror of issuance's "here are your new
IRIs"); under the all-or-nothing rule below the removed list equals the
request's `grants` on success, so the response is a confirmation echo.

**All-or-nothing, validation first.** The whole request is validated **before
any grant is created or deleted**: every listed grant is loaded from D's
registry — SPARQL via `SparqlEndpointFetcher`, exactly as in
`SaiPermissionsEngine` — and authority-checked; if any check fails, nothing is
mutated and the request fails (exact error-detail schema —
   [follow-up 6](revoke-delegation-chain-follow-ups.md#6-revocation-error-detail-schema)). This applies
symmetrically to `AccessRequest` issuance (validate all grants before creating
any; all entries must share the endpoint's `dataOwner`).

**Authority (per-grant, two branches — first cut):**
- the requester's client is the **UA of the grant's `grantedBy`** → may revoke
  that grant (mirror of the `GrantIssuanceHandler` client-identity check);
- the requester is the **data owner** → may revoke any grant in its own
  registry; exposed to its own UI via an RPC path (§6).
- Grantee self-revocation —
  [follow-up 5](revoke-delegation-chain-follow-ups.md#5-grantee-self-revocation).

**Deletion.** After validation, DELETE the listed grants **plus their
inheriting children** (`?child interop:inheritsFromGrant ?parent`, fixpoint
loop over D's SPARQL endpoint — one level today, written recursive-ready)
**with D's own session** (owner rights — no ACR/403 problem). The full
dependent-chain calculation (§2 predicate) and the replace-vs-delete race are
[follow-ups 1/3](revoke-delegation-chain-follow-ups.md). Idempotent: revoking
an already-removed grant is a
no-op success — its id is still echoed in the response.

## 4. Trigger integration (grantor-side)

The grantor's regeneration path (`createGrantsForAgent`) derives the
**semantic delta** for a grantee — what no longer matches stays out, what new
coverage appears gets issued:

- coverage **shrank or empty** (deny, scope reduction) → request revocation at
  the data owner's endpoint for the entry-point grant IRIs; D's fixpoint
  removes the dependent subchain;
- coverage **unchanged** (pure regeneration) → keep existing grants (reuse),
  no revocation, no re-issuance, no propagation;
- coverage **grew/changed** → request issuance for the new grants only.

HTTP-DELETE of grant resources is **internal to the data owner's revocation
handler only**; no peer ever DELETEs in another peer's registry.

**First cut:** the grantor asks for revocation with the entry-point grant IRIs
only; the semantic-delta derivation (reuse vs. re-issue) is the follow-up
plan's [trigger integration](revoke-delegation-chain-follow-ups.md#4-trigger-integration--grantor-regeneration-requests-revocation),
tied to the chain calculation and replace-vs-delete race items.

## 5. Propagation down the chain — two complementary systems

Both coexist by analogy with "event-driven + sweep" (`pending → done` plus
`reconcileActivities`): System 1 is the authoritative low-latency path, System 2
the scheduled backstop for missed signals, polarity gaps, and crashes.
**Propagation is only needed for semantic weakening** — pure upstream
replacement needs none (§2).

### System 1 — response-driven webhook cascade

1. A revokes at D's endpoint (POST `interop:AccessRevocation`, grant IRIs in
   `grants`) → response contains the removed IRIs.
2. A runs the requester hop: it wrote a `pending` activity to its own activity
   registry, and on the response runs a workflow that **clears its
   registration of B** (`hasDataGrant`) — reusing
   `replaceDataGrantsOnRegistration`/`removeDataGrants` — and then
   `markActivitiesDone`. The requester hop is guaranteed synchronously by the
   response.
3. That PATCH is an `Update` on a resource in A's registry → B's reciprocal
   webhook fires (only if polarity is right — `social-graph.md` §5, the
   inviter-side-only subscription) → B's `updateDelegatedGrants(peer=A)`
   re-derives from registry state via the predicate → clears B's registration
   of C → next hop.

Property: the requester hop is deterministic; **every downstream hop depends on
reciprocal-webhook polarity**. That dependence is what System 2 absorbs.
Downstream hops (step 3 onward) rely on the §2 predicate, so in the first cut
propagation beyond the requester hop is a follow-up (items 1/8/9 of the
[follow-ups plan](revoke-delegation-chain-follow-ups.md)).

### System 2 — recurring reconciliation job per authorization agent

Each authorization agent runs a scheduled job (Temporal schedule / cron —
`reconcileActivities` currently has **no caller/schedule**; this plan provides
one) that re-derives each grantee's delegation projection.

**The signal must NOT be the HTTP status of a deleted grant resource:**

- A deleted grant under an owner-only container yields **403** (the policy
  engine denies before existence matters) — indistinguishable from an
  expired/invalid token or missing credentials. **410 Gone is not produced and
  would not be authoritative from a non-owner reader.** A single HTTP status
  on a cross-peer GET can never be the revocation signal.
- Instead, the sweep works off **200-semantics projections**: each agent
  re-reads the grantor's registration of it via the reciprocal link
  (`hasDataGrant` is always readable by the registered agent). After D's
  closure-delete and A's link cleanup, B's next read *shows* the delta — no
  403, no ambiguity. Detection of a delta triggers the same regeneration
  machinery, which then propagates one hop down.
- When a resource-level truth is needed, route it through the **data owner's
  boundary**: a validate request on the delegation endpoint answers
  authoritatively from the owner's registry (`valid` / `invalid` /
  `unknown`), computed with the §2 predicate (singular or chain). Treat
  D-unreachable as `stale — retry`, never as revocation.

## 6. Data-owner-initiated root revocation

D revoking its direct peer A is the **same operation, locally triggered**: the
`RevokeGrants` RPC (D's own UI — precedent: `recordAuthorization`'s deny RPC in
`authorization-revoked.md`) feeds the same `GrantRevocationHandler.revokeGrants`
core as the delegation endpoint (owner branch via the session's webId = D): it
validates all-or-nothing and deletes the listed grants + their inheriting
children with D's own session. The RPC service then clears D's own
registration of the grantee — derived **per grant** from `grantedBy == D`
(source grants only; a directly-revoked delegated grant has no registration
link in D's registry — its grantor's projection is fixed by the requester hop /
sweep). Enforcement is thereby fixed for the whole chain regardless of
propagation. In the first cut the fixpoint removes **listed + inheriting
grants only**; full dependent-subchain removal arrives with the chain
calculation (§2, [follow-up 1](revoke-delegation-chain-follow-ups.md#1-full-dependent-chain-calculation)).
The `grantsRevoked` observability activity in D's
outbox is deliberately **not written**: the RPC response is the synchronous UI
signal, and writing the activity would re-trigger D's own
`ActivityWebhookHandler` → requester-hop workflow for a from-D-to-D no-op.

## 7. Observability / state machine

- The requester (A) runs the revocation through its own outbox:
  activity `pending` → workflow POSTs revocation + clears links →
  `markActivitiesDone` → UI `done` event (peer.md arc).
- D's handler may record a completion/observability activity (per §6).
- UI refresh mapping additions: a `grantsRevoked`-type `done` event maps to
  `listSocialAgents` (+ applications), same as `delegatedGrantsUpdated`.

## 8. Design decisions

1. **Both issuance and revocation are boundary operations**; the data owner is
   the sole executor of deletes in its registry; peers only request. Request
   granularity (pinned): a `grants` array of grant IRIs (§3); a grantee-
   closure convenience remains a possible future addition — same closure
   computation either way.
2. **No cross-peer DELETEs** — `deleteDataGrants` becomes internal to D's
   revocation handler; ACR/403 blocker for grantors disappears.
3. **No `delegationOfGrant`** — the data model, generation
   (`data-authorization.ts`), and context drop it; chain validity is the §2
   predicate; `hasInheritingGrant`/`inheritsFromGrant` stays (same-request
   siblings).
4. **Validity is rooted reachability** (grantedBy == dataOwner terminus,
   visited-set) — no semantic cycles, no dangling-IRI propagation.
5. **Grants immutable; replacement = delete old + create new**, executed by
   the owner; a replaced grant with unchanged/covering semantics requires no
   downstream propagation.
6. **Idempotent revocation**; revoking an already-removed grant is a no-op.
7. **Sweep signals are 200-based projections**, never status-probes of deleted
   resources (403/410 ambiguity); authority questions go through D's boundary.
8. **Registration links are projections, not enforcement** — stale links are
   eventually-consistent (webhook cascade + scheduled job + mount/reconnect
   refetches), while enforcement is fixed immediately by D's closure-delete.
9. **Message contract (pinned):** revocation = `interop:AccessRevocation`
   (typed message; `grants` carries grant IRIs only); issuance =
   `interop:AccessRequest` (full grant objects); the delegation endpoint
   dispatches on `type`. New terms go in **both** INTEROP vocabularies
   (`packages/utils/src/namespaces.ts` and `packages/components/src/
   vocabularies.ts` — two distinct vocab modules) and message models live in
   `packages/data-model/src/` next to `grant.ts`.
10. **All-or-nothing for both directions:** the full request is validated
    before any create/delete — every grant is loaded (SPARQL via
    `SparqlEndpointFetcher`, as in `SaiPermissionsEngine`), authority-checked,
    then mutated; any failure → no mutation.
11. **Requester classes (first cut):** the grantor (`grantedBy` match,
    per-grant check) and the data owner (any grant in its registry, UI RPC
    path). Grantee self-revocation — [follow-up 5](revoke-delegation-chain-follow-ups.md#5-grantee-self-revocation).
12. **Requester hop (in scope):** on success, the grantor writes a `pending`
    activity to its activity registry and runs a workflow clearing
    `hasDataGrant` (`replaceDataGrantsOnRegistration`), then
    `markActivitiesDone`.
13. **SPARQL wiring (no new env vars):** `CSS_SPARQL_ENDPOINT` is already
    passed to the auth/registry/data services in `docker-compose.yaml` and
    `.dagger/src/index.ts`; handlers take the same `sparqlEndpoint`
    constructor param as `GrantIssuanceHandler`/`SaiPermissionsEngine`.
14. **Grant ACRs are read-only for everyone but the owner:** the
    `dataGrantTemplate` (`packages/data-model/src/templates/DataGrant.acr.ts`)
    drops the grantor's `acl:Write` — currently the enabler of the
    cross-peer DELETE seam decision 2 removes (`deleteDataGrants`'s docstring
    points at it). The grantor keeps `acl:Read`; only the owner holds
    `acl:Read/Write/Control`. The boundary revocation then isn't just
    protocol but ACR-enforced: a grantor literally cannot DELETE a grant
    resource.

## 9. Resolved & follow-ups

**Pinned in this plan:**

- Request contracts: `interop:AccessRevocation` (`grants` = grant IRIs only)
  and `interop:AccessRequest` (full grant objects) — new vocab terms in both
  `packages/utils/src/namespaces.ts` and `packages/components/src/
  vocabularies.ts`; message models in `packages/data-model/src/`; endpoint
  dispatch on `type`.
- Authority branches per §3 (grantor by `grantedBy`, data owner via UI RPC);
  all-or-nothing validation precedes any mutation; idempotent already-removed
  no-op; response = removed list (echo of the request under all-or-nothing).
- Requester hop (§5 System 1): `pending` activity → response → workflow clears
  `hasDataGrant` (`replaceDataGrantsOnRegistration`) → `markActivitiesDone`.
- SPARQL reuse: `SparqlEndpointFetcher` exactly as in `SaiPermissionsEngine`;
  `CSS_SPARQL_ENDPOINT` is already wired to the auth/registry/data services in
  `docker-compose.yaml` and `.dagger/src/index.ts` — no new env vars.
- Grant ACRs read-only for everyone but the owner: grantor `acl:Write`
  removed from `dataGrantTemplate` (DD14) so the grantor's direct DELETE of
  grant resources is ACR-blocked; the owner's revocation handler is the only
  delete path.

**Follow-ups (tracked as shippable slices in
[`revoke-delegation-chain-follow-ups.md`](revoke-delegation-chain-follow-ups.md)):**

1. Full dependent-chain calculation (§2 predicate, recursive reachability over
   D's SPARQL endpoint) — the first cut revokes listed + inheriting grants only.
2. Scope-coverage ordering formalization and mode coverage per-mode vs.
   per-grant — required by the predicate and semantic-delta reuse.
3. Replace-vs-delete race (order delete-old/create-new so enforcement never
   sees both, or neither).
4. Trigger integration — grantor regeneration derives the semantic delta and
   requests revocation; the `grantsRevoked` producer (currently none).
5. Grantee self-revocation ("remove my own access"): authority branch + UI
   affordance.
6. Revocation error-detail schema for the all-or-nothing failure response.
7. Drop the vestigial `delegationOfGrant` (DD3): model, generation, context,
   framing tests, and persisted/seed triples.
8. Validate-request shape/rate for the System 2 sweep (per-grant validation
   against D vs. pure projection re-derivation).
9. `reconcileActivities` scheduling (interval, backoff on D-unreachable,
   per-account fan-out) — assumed by System 2, out of scope here.
10. Drop the issuer-side grant **replica** graphs when grants leave a
    grantor's registration (replaced, unlinked, or revoked). The replica is
    written by [`check-equivalence.md`](check-equivalence.md) §2.1; its cleanup
    belongs with the grant-resource cleanup in DD5 (same lifecycle, same orphan
    class). Orphan replica graphs are invisible to reads, so this waits for the
    DELETE-403 work.

## 10. Execution steps — each step leaves the repo green

Every step below is a shippable checkpoint: code builds and **all tests pass**
after each one. Steps 2 → 3 must land in order (the `type` dispatch built in
Step 2 is reused by Step 3); steps 4 and 5 depend only on Step 3 and can be
swapped or parallelized. No follow-up item (see
[`revoke-delegation-chain-follow-ups.md`](revoke-delegation-chain-follow-ups.md))
blocks any step.

1. **Vocabulary + message models (pure additive).** Add `AccessRequest` /
   `AccessRevocation` to **both** `packages/utils/src/namespaces.ts` and
   `packages/components/src/vocabularies.ts`; add `access-request.ts` /
   `access-revocation.ts` message models in `packages/data-model/src/` (next to
   `grant.ts`, exported from index), moving the `IncomingGrantData` (embedded
   inheriting children) shape out of `test/delegation-endpoint.test.ts` into
   the model. **Green:** new terms/types only — zero behavior change; add
   model unit/framing tests. **Status: landed** in the "access grant revocation"
   commits.
2. **`AccessRequest` envelope on issuance (coordinated break).** Dispatch the
   delegation endpoint on message `type`; `GrantIssuanceHandler` parses
   `{type, grants: […]}` instead of raw GrantData. Multi-grant all-or-nothing:
   validate every entry first (`dataOwner` == endpoint owner, per-grant
   upstream SPARQL), then create all. **Green:** handler + envelope + tests
   change together — the break is contained to the handler and
   `test/delegation-endpoint.test.ts`; add single-grant, multi-grant, and
   wrong-`dataOwner`-fails-all tests. **Status: landed** in the "access grant
   revocation - refactor issuance" commit.
3. **`AccessRevocation` handler (the core cut).** Dispatch on `AccessRevocation`;
   SPARQL-load each listed grant (`SparqlEndpointFetcher`, as in
   `SaiPermissionsEngine`); per-grant `grantedBy` authority check + data-owner
   branch; validate-all-first (§3). Delete the listed grants plus their
   inheriting children (fixpoint `?child interop:inheritsFromGrant ?parent`,
   one level, recursive-ready) with D's own session. Idempotent: response
   echoes the removed list; already-removed is a no-op. **Also here:** drop
   the grantor's `acl:Write` from `dataGrantTemplate` and update
   `deleteDataGrants`'s docstring to owner-session-internal (DD14) — a
   grantor's direct DELETE of a grant resource is now ACR-blocked. **Green:**
   additive handler + tests — issue→revoke→registry empty + echo; re-revoke
   idempotent; unauthorized grantor fails with no mutation; inheriting
   children removed; issuing a delegated grant yields a read-only-for-grantor
   ACR. **Status: landed** in the "access grant revocation" commit.
4. **Requester hop (grantor-side).** Workflow: `pending` activity → POST
   `AccessRevocation` → on success clear `hasDataGrant` (reuse
   `replaceDataGrantsOnRegistration` / `removeDataGrants`) →
   `markActivitiesDone`; `grantsRevoked` done-event → `listSocialAgents`
   refresh mapping. **Green:** new workflow + tests only (activity
   pending→done, registration link cleared). **Status: landed** in the "access
   grant revocation" commit (consumption side; the §4 producing trigger remains
   [follow-up 4](revoke-delegation-chain-follow-ups.md#4-trigger-integration--grantor-regeneration-requests-revocation)
   — no producer writes `grantsRevoked` yet).
5. **Data-owner UI RPC + observability.** RPC path for D's own UI (deny-RPC
   precedent in `authorization-revoked.md`) hitting the same handler code path,
   plus D clearing its own registration; optional `grantsRevoked`
   observability activity in D's outbox. **Green:** additive RPC + tests (owner
   revokes, registry + own registration cleaned). **Status: landed.**
   **Landed as:** `RevokeGrants` RPC (`packages/api-messages/src/effect.ts`;
   `grants: IRI[]` in, echo out) served by `ApiHandler` (new `sparqlEndpoint`
   ctor param, wired in `config/http/handler/default.json` — the same variable
   `GrantIssuanceHandler` uses, no new env vars) and implemented in
   `services/Revocation.ts`, which reuses the endpoint's same code path
   (`GrantRevocationHandler.revokeGrants` — validate-all-first, per-grant
   authority, fixpoint closure) and then clears D's own `hasDataGrant` for the
   removed **closure** where `grantedBy == D`, grouped by grantee. The optional
   `grantsRevoked` observability activity is deliberately not written (§6).
   Tests: `test/revocation-rpc.test.ts` (owner revokes → registry + own
   registration cleaned; idempotent echo; mixed existing/removed echo) — acme
   account cookie added to `environments/data/kv.json` (the RPC needs a
   data-owner session cookie; the seed only had alice/bob/dan).
