# Real `checkEquivalence` — reuse equivalent grants

> **Status:** design (revised 2026-10-21). The dummy (`{ reused: [] }`) shipped
> with the grant-workflow refactor; this plan is where the real implementation
> is tracked.
>
> **Prerequisites:**
>
> 1. **Drop `delegationOfGrant`** — step 0 (§2.0); small enough to land as the
>    first step of this plan (currently item 7 of
>    `revoke-delegation-chain-follow-ups.md`).
> 2. **Issuer-side grant replica** (§2.1) — the comparison needs grant bodies
>    where we are `grantedBy` and a peer is `dataOwner`.
>
> **Wiring note (corrects an earlier assumption):** `createGrantsForAgent` is
> **not** ready for real results. Its reuse set keys on object identity across a
> Temporal activity boundary and its result shape cannot re-link children — see
> §2.2. The workflow changes in §5 step 2 are required.

## 1. Problem

Today every regeneration is "generate everything, store everything":

- `generateGrants` produces new grant data (source + delegated) with **fresh
  IRIs** on every run.
- `checkEquivalence` is a dummy → `{ reused: [] }` → the workflow stores every
  generated grant (new `DataGrant` resources + new ACRs), requests every
  delegation again, and re-links the registration with the **new** IRIs.
- Result: an unchanged authorization state (e.g. the same role membership, a
  re-run of the per-target consumer over a burst, or the reconciliation sweep
  re-processing a `pending` activity) **recreates the whole grant set** — new
  resources, new ACRs, new delegated grants on the data owners' registries —
  while the old resources stay behind as orphans (the HTTP-DELETE of old
  grants is commented out, see §6).

Reuse is the fix: when a generated grant **tree** is equivalent to an existing
one, keep the existing resources + ACRs and re-link their ids on the
registration.

## 2. Current wiring (as-is)

**Activity** (`packages/components/src/temporal/activities/grants.ts`):

```ts
export interface CheckEquivalenceInput {
  webId: SocialAgentId
  grantee: AgentId
  generated: GeneratedGrants      // { sourceGrants: FinalGrantData[], delegatedGrants: GrantData[] }
  existing: GrantId[]             // the grantee's current grant IRIs (from getExistingGrants)
}
export interface EquivalenceResult {
  reused: { existing: GrantId; generated: GrantData }[]   // existing = { id, type }
}
export async function checkEquivalence(_payload: CheckEquivalenceInput): Promise<EquivalenceResult> {
  return { reused: [] }   // DUMMY
}
```

`getExistingGrants` returns **IRIs only** (one `AgentRegistry.findRegistration`
read; no grant bodies — this is the current state, not a `loadGrant` loop).

**Workflow** (`temporal/workflows/grants.ts`, `createGrantsForAgent`):

```ts
const { reused } = await checkEquivalence({ webId, grantee, generated, existing })
const reusedGenerated = new Set(reused.map((e) => e.generated))
// store:        for grant of generated.sourceGrants      → skip if reusedGenerated.has(grant)
// delegation:   for grant of generated.delegatedGrants   → skip if reusedGenerated.has(grant)
// delete (⚠️ commented out — §6): existing not in reusedExistingIds
// registration: replaceDataGrantsOnRegistration({ grants: [...newGrantIds, ...reused.map((e) => e.existing)] })
```

Note that `reusedExistingIds` exists **only inside the commented-out delete
block** — it is not a live local.

### 2.0 Prerequisite: drop `delegationOfGrant`

`delegationOfGrant` is vestigial: nothing reads it (issuance and revocation
chain validation are both match-based SPARQL — `findDelegableGrant`,
`revoke-delegation-chain.md` §2/DD3), and it is the only field whose comparison
would need a special case in §3. **Drop it before implementing equivalence**:
remove it from `GrantData`/`GRANT_TERMS` (`data-model/src/grant.ts`), the
context (`context.ts`), generation (`grant-generation.ts` parent and child
delegated grants), the issuance copy (`GrantIssuanceHandler.buildInheritingGrant`),
the seed triples, and the tests that assert it
(`authorization-agent/test/grant-generation.test.ts`) plus the components
fixture (`components/test/delegation-request.test.ts`). `data-model/test/
framing/regressions.test.ts` already asserts the field is absent — it stays
green unchanged. The vocabulary term stays in
`namespaces.ts`/`vocabularies.ts` (it remains a valid INTEROP term, like other
terms we no longer write). Existing resources that still carry the triple are
inert — framing no longer selects it — so no data migration is required.

This is small (a handful of source lines, the seed, and the tests that assert
the field), so it is **step 0 of this plan** rather than a separate plan; it
lands green on its own before any comparison code.

### 2.1 Prerequisite: the `existing` bodies must be replicated locally

`existing` reaches the activity as IRIs. The comparison (§3.1) is **body-only**
(`dataOwner`, `registeredShapeTree`, `hasDataRegistration`, `hasStorage`,
`scopeOfGrant`, `accessMode`, `creatorAccessMode`, `hasDataInstance`), so the
IRIs alone cannot answer "is this the same grant".

- **Source grants** (we are `dataOwner`) live in our own grant registry — their
  bodies are already local (read via `getDataGrant(localSparqlTransport(
  session.sparqlEndpoint), iri)`).
- **Delegated grants** (we are `grantedBy`, a peer is `dataOwner`) live on the
  peer's registry; our side keeps only the IRIs. `loadGrant`-ing them would be
  one HTTP dereference per grant and would make regeneration depend on peer
  availability and on the grantor-read ACR policy — not acceptable for reuse.

**Requirement: replicate the delegated grant bodies locally** — the
*issuer-side* mirror (the reciprocal mirror is grantee-side and covers the
opposite direction).

- **Link source:** our own registration of the grantee. `getExistingGrants`
  reads `hasDataGrant`, and the registration links **every parent and child
  directly**: the issuance endpoint returns `finalGrants.map((g) => g.id)` for
  parents *and* inheriting children, so `newGrantIds` (and the registration)
  include both; source children are separate `sourceGrants` entries and are
  linked the same way. The replica therefore has a complete link set for
  runtime-generated data. (One seed pair is stale — see §7.)
- **Bodies:** the grant documents. The data owner already holds `finalGrants`
  (parents and children), so the issuance response is extended to **echo the
  finalised grants** instead of bare IRIs (decided — no cross-pod read, no
  grantor-read ACR dependency). `requestDelegations` stores each echoed body as
  a replica graph and returns the ids exactly as today, so the workflow
  contract is unchanged. The replica must include **child bodies**, not only
  top-level parents: a parent body carries the child IRIs (reverse
  `inheritsFromGrant` triples) but not the child fields.
- **Freshness: none needed.** Grants are immutable (a change mints a fresh IRI —
  `openwiki/architecture/federation.md`), so a replicated body is either current
  or absent. Replicate when the link is written; no periodic sync workflow.
- **Graph shape:** one named graph per grant IRI (`GRAPH <grantIri>`), same
  convention as the reciprocal mirror, read through the same `graphDoc` union
  (resource graph + `meta:` twin). Written to the org's own SPARQL endpoint
  (`session.sparqlEndpoint`), like `updateReciprocalMirror`.
- **Missing body ⇒ not reusable (fail-closed).** Do **not** raise
  `MirrorIncompleteError` here: on the first run after this plan lands no
  delegated grant has a replica body, so failing loud would never heal. A
  missing/unframable body simply makes that existing tree a non-match; the
  regeneration replaces it (as today) and populates the replica, so the second
  run reuses.
- **Drop-on-unlink (deferred).** Orphan replica graphs are invisible
  (`getExistingGrants` only reads current links) and are the same class as the
  orphaned grant resources whose DELETE is already off (§6). Their cleanup
  rides the grant-resource cleanup lifecycle in `revoke-delegation-chain.md`
  (follow-up 10), not this plan.

**Bodies are loaded lazily:** `getExistingGrants` stays IRI-only (decided);
`checkEquivalence` loads the bodies it needs from the local endpoint and skips
unreadable ones (fail-closed). The deny path never pays for bodies.

Deliberately **not** proposed: on-demand caching inside `checkEquivalence`.
Reuse decisions must be a pure function of replicated state, otherwise the
"same input → same grants" property this plan is about cannot be tested.

### 2.2 The workflow is not serialization-safe

`checkEquivalence` is a Temporal activity: its arguments and result cross the
data converter (JSON). The `generated` objects returned in
`reused[].generated` are **fresh copies**, never identical to the workflow's
`generated.sourceGrants`/`delegatedGrants` entries, so
`reusedGenerated.has(grant)` is always false — the dummy hid this. The result
shape also cannot express the child re-links required by §3.2/§4.

The result must therefore be **value-based** (§3.4), and
`createGrantsForAgent` must consume it by ids/indexes (§4, §5 step 2).

## 3. Target: the real comparison

Equivalence is evaluated over a **grant tree** — a parent grant and all of its
descendants — not over independent grants.

### 3.1 Compared fields

Equal iff all of the following match (`GrantData`):

- `grantee`
- `grantedBy`
- `dataOwner`
- `registeredShapeTree`
- `hasDataRegistration`
- `hasStorage`
- `scopeOfGrant`
- `accessMode` (as a set)
- `creatorAccessMode` (as a set, when present)
- `hasDataInstance` (as a set, when present)

**Not compared:** `id` (minted per run), `type` (always
`[INTEROP.DataGrant]`), `inheritsFromGrant` (derived parent IRI — points at a
fresh/minted parent), `delegationOfGrant` (gone, §2.0), and
`hasInheritingGrant` (structural — compared by the tree walk in §3.2).

Set-valued fields are normalized before comparing.

### 3.2 Child grant trees

A parent and its descendants are one unit: **the parent is equivalent only if
the whole subtree is equivalent, and no descendant is reused unless its
parent is reused**. If any member differs, the whole subtree is regenerated
(new parent + all new descendants); reusing a child under a new parent would
leave two parents claiming it (`inheritsFromGrant` on the reused child points
at the old parent, while the new parent's document links it).

- Equality is recursive: `treeEqual(g, e)` = `fieldsEqual(g, e) ∧` the child
  sets are equal as a multiset by `treeEqual` (same cardinality; a bijection
  exists). Matching children are therefore a set comparison, not just a
  "shape-tree composition" check.
- Child IRIs are not compared (they are derived). The **tree links** are used
  to reconstruct each side: generated source children are separate
  `sourceGrants` entries referenced by the parent's `hasInheritingGrant` IRIs;
  generated delegated children are **embedded objects** in the parent's
  `hasInheritingGrant` (no top-level entry); existing children are separate
  resources referenced by the existing parent's `hasInheritingGrant`, with
  bodies loaded from the replica/our registry.
- Today generation creates **one level** of inheritance; the comparison is
  written recursively so an n-depth generalization needs no change here.

### 3.3 Matching algorithm

- Iterate generated trees (source trees and delegated trees), greedily find the
  first unclaimed existing tree with `treeEqual`.
- One-to-one: a matched existing tree is claimed, so duplicates cannot reuse the
  same existing grants.
- O(n·m) is fine — grant sets are small.
- The result enumerates every member of each matched pair (see §3.4): the
  generated source ids to skip storing, the delegated top-level index to skip
  requesting, and **every existing IRI in the tree** (parents *and* children) to
  keep linked.

### 3.4 Result shape (serialization-safe)

```ts
export interface EquivalenceResult {
  /** generated.sourceGrants ids to keep (parents AND children of matched trees) */
  reusedSourceIds: string[]
  /** indexes into generated.delegatedGrants (top-level only) to keep */
  reusedDelegatedIndexes: number[]
  /** every existing grant IRI in matched trees — parents AND children */
  reusedExisting: GrantId[]
}
```

Strings and indexes survive the activity boundary; object identity does not.
`reusedExisting` is what makes the full-set registration PATCH keep the child
links — `replaceDataGrantsOnRegistration` removes every link not in the target
set (`authorization-agent/src/agent-registration.ts`), so a reused delegated
parent with un-listed children would otherwise silently drop them.

### 3.5 Delegated grants

After §2.0 there is no `delegationOfGrant` to exclude: delegated trees are
compared with the same `fieldsEqual`/`treeEqual` as source trees. Chain
validity is match-based (`revoke-delegation-chain.md` §2), so a reused
delegated grant does not need a source-grant pointer.

## 4. What reuse means downstream (after the §5 step 2 wiring)

- **Store:** skip every `generated.sourceGrants` entry whose id is in
  `reusedSourceIds` — no new resource, no new ACR (`createAcr` not called).
- **Delegation:** skip `generated.delegatedGrants` whose index is in
  `reusedDelegatedIndexes` — no new delegation request (embedded children ride
  the parent, so they are skipped too).
- **Registration:** `replaceDataGrantsOnRegistration` re-links
  `[...newGrantIds, ...reusedExisting]` — the whole reused subtree, parents and
  children.
- **Delete:** non-reused existing grants remain (see §6).

Net effect on an unchanged re-run: **zero new grant resources, zero new ACRs,
zero delegation requests** — the registration's `hasDataGrant` set is unchanged
and the single-PATCH diff is a no-op.

## 5. Implementation steps (each green-to-green)

0. **Drop `delegationOfGrant`** (§2.0) — first, independently green step.
1. **Pure comparison helper, unwired** (`activities/grants.ts` or a small
   sibling module): `grantFieldsEqual(g, e)` + recursive `treeEqual` +
   tree reconstruction from `hasInheritingGrant`/`inheritsFromGrant`. Unit
   tests in `packages/components/test/check-equivalence.test.ts`; no behavior
   change.
2. **Result interface + workflow consumption** (§3.4): replace
   `EquivalenceResult`, update `createGrantsForAgent` to consume
   `reusedSourceIds` / `reusedDelegatedIndexes` / `reusedExisting`. The dummy
   returns empty sets → **behavior identical**. Add a workflow-level test with
   mocked activities (a non-empty result must skip storing/requesting and must
   re-link every reused child IRI); that is the test that catches §2.2.
3. **Source-grant reuse**: `checkEquivalence` loads the existing bodies for our
   own grants from the local endpoint, pairs source trees, returns the result.
   Delegated grants stay unmatched until step 5. Behavior changes here (source
   grants start being reused); update the `/test` assertion that pins the old
   behavior (§7).
4. **Issuer-side replica write**: the issuance endpoint echoes the finalised
   grants; `requestDelegations` stores every echoed body — parent **and
   children** — as `GRAPH <grantIri>` in the org's endpoint and returns the
   ids as today. No drops here (deferred to `revoke-delegation-chain.md`
   follow-up 10). Tests: issuance response, replica content, and the updated
   `/test` / `delegation-request` response-shape assertions.
5. **Delegated-tree reuse**: read replica bodies for existing delegated grants;
   fail-closed on missing/unframable bodies; pair delegated trees. Add the
   `/test` cases: unchanged re-run keeps the same IRIs (source + delegated),
   partial change replaces only the changed subtree.
6. **Follow-ups** (§8): replica drops/backfill, drift repair.

No data-model changes beyond §2.0 (the comparison reads `GrantData` fields
directly).

## 6. Interaction with the commented-out grant deletion

The old-resource HTTP-DELETE in `createGrantsForAgent` is **commented out**
(CSS 403 on grantor-side DELETE of delegated grants — the ACR analysis is in
`revoke-delegation-chain.md` §1/DD2). Reuse does **not** fix that:
non-equivalent old subtrees remain orphaned. What reuse changes:

- an unchanged re-run produces **no new orphans** (nothing is replaced);
- when grants actually change, the replaced subtrees still orphan (unchanged
  behavior until the DELETE 403 is resolved by the boundary-revocation work).

## 7. Testing

- **Unit (`packages/components/test/`, agent-runnable via the root vitest):**
  `grantFieldsEqual` (set normalization, optional fields, ids/derived fields
  ignored), `treeEqual` (parent-only, one-level child, differing child set,
  n-depth shape), greedy one-to-one pairing, and the child re-link enumeration.
- **Workflow-level (mocked activities, `packages/components/test/`):** a
  non-empty `EquivalenceResult` actually skips `storeGrantAndAcr` /
  `requestDelegations` and re-links **all** reused IRIs (parents + children).
  This is the regression test for the §2.2 serialization bug.
- **No-peer-read oracle:** mock `fetch-sparql-endpoint` and assert every body
  read targets `session.sparqlEndpoint`; `session.fetch` is allowed only for
  local registration/agent reads (a blanket "throws on any IRI" stub is wrong —
  `getExistingGrants` fetches the registration through `session.fetch`, and
  grant bodies are read through SPARQL, not HTTP).
- **`/test` (dagger, user-run):**
  - `test/reconciliation.test.ts` currently asserts the seed grant `g4yhtm` is
    **not** in the registration after regeneration (`expect(iris).not.toContain
    (seedGrant)`). With real reuse it **will** be; the assertion changes to
    assert the same IRIs (approved). This is the only `/test` assertion I found
    that pins grant IRIs; `authorization`, `roles`, `share` assert
    shapes/semantics and stay green.
  - **No-new-IRI-on-rerun**: regeneration twice with an unchanged state keeps
    the registration's `hasDataGrant` set identical (parents and children).
    Trigger: the reconciliation sweep on a pending activity, or two drain
    cycles of the consumer.
  - **Change → replace**: change one authorization and assert the changed
    subtree is new while the unaffected subtrees keep their IRIs (partial
    reuse).
  - **Delegated reuse**: a delegated tree (e.g. the `wwp4j6` → `qwvbcu` pair on
    alice's application registration) survives a re-run with the same IRIs.
  - **Seed fix:** `https://registry/acme/social-agent/je0s7n/` links only
    `g4yhtm` and omits its child `wpqyds`; runtime links every parent and
    child. Add the missing `hasDataGrant` link so fixtures match runtime and
    the mirror/replica assumption holds. (The child stays reachable through the
    parent's reverse link either way, so this is a fixture correction, not a
    code requirement.)

## 8. Out of scope / follow-ups

- Resolving the DELETE 403 (old-subtree cleanup) — `revoke-delegation-chain.md`.
- Replica drops on unlink — rides the grant-resource cleanup lifecycle in
  `revoke-delegation-chain.md` (follow-up 10): same orphan class as the grant
  resources whose DELETE is off.
- Initial replica backfill / drift scan for existing deployments —
  `pod-isolation-followup.md` A1; reuse the mirror's presence check
  (`presentGraphs`) rather than a second implementation.
- n-depth inheritance: generation is one level today; §3.2 is written
  recursively so this plan does not need to change.
- Whole-registry regeneration (recovery scenarios only).

## 9. Decisions (approved 2026-10-21)

- **Replica write point:** the issuance endpoint **echoes the finalised
  grants**; no post-issuance peer fetch (§2.1, §5 step 4). This changes the
  response contract from `string[]` to grant objects — update
  `test/delegation-endpoint.test.ts` and
  `packages/components/test/delegation-request.test.ts` with it.
- **Replica drops:** deferred to the grant-resource cleanup lifecycle
  (`revoke-delegation-chain.md` follow-up 10); this plan writes replicas and
  never drops them.
- **Missing replica body:** fail-closed — not reusable; the regeneration
  replaces it and repopulates the replica (§2.1).
- **`getExistingGrants`:** stays IRI-only; `checkEquivalence` loads bodies
  lazily from the local endpoint (§2.1).
- **`/test/reconciliation.test.ts`:** the "seed grant replaced" assertion
  changes to "seed grant reused" (§7).
- **`delegationOfGrant` drop:** step 0 of this plan, not a separate plan
  (§2.0).
