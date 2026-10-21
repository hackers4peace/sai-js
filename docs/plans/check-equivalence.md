# Real `checkEquivalence` — reuse equivalent grants

> **Status:** design only. The dummy (`{ reused: [] }`) shipped in
> `refactor-grants-workflows.md`; the real implementation was that plan's
> "Future step" and is **Phase 4.5** of `workflow-temporal-decupling.md`. This
> standalone plan is now where the real `checkEquivalence` is tracked.

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

Reuse is the fix: when a generated grant is **equivalent** to an existing one,
keep the existing resource + ACR and re-link its id on the registration.

## 2. Current wiring (as-is)

**Activity** (`packages/components/src/temporal/activities/grants.ts`):

```ts
export interface CheckEquivalenceInput {
  webId: SocialAgentId
  grantee: AgentId
  generated: GeneratedGrants      // { sourceGrants: GrantData[], delegatedGrants: GrantData[] }
  existing: GrantData[]           // the grantee's current grants (from getExistingGrants)
}
export interface EquivalenceResult {
  reused: { existing: GrantId; generated: GrantData }[]   // existing = { id, type }
}
export async function checkEquivalence(_payload: CheckEquivalenceInput): Promise<EquivalenceResult> {
  return { reused: [] }   // DUMMY
}
```

**Workflow** (`temporal/workflows/grants.ts`, `createGrantsForAgent`) — already
fully wired for reuse:

```ts
const { reused } = await checkEquivalence({ webId, grantee, generated, existing })
const reusedGenerated = new Set(reused.map((e) => e.generated))
const reusedExistingIds = new Set(reused.map((e) => e.existing.id))
// store:        for grant of generated.sourceGrants      → skip if reusedGenerated.has(grant)
// delegation:   for grant of generated.delegatedGrants   → skip if reusedGenerated.has(grant)
// delete (⚠️ commented out — §6): existing not in reusedExistingIds
// registration: replaceDataGrantsOnRegistration({ grants: [...newGrantIds, ...reused.map((e) => e.existing)] })
```

So the workflow needs **no changes** — only `checkEquivalence` returns real
results.

### 2.1 Prerequisite: the `existing` bodies must be replicated locally

`existing` reaches the activity through `getExistingGrants`
(`activities/grants.ts:261-289`), which takes the IRIs off **our registration of
the grantee** (`hasDataGrant`, already local and authoritative) and then
`loadGrant`s each one with our session. That is fine for grants we own, but
**every grant where we are `grantedBy` and a peer is `dataOwner` lives on that
peer's registry** — `GrantIssuanceHandler.issue` writes the finalised grant
there (`getSession(dataOwner)`), and our side keeps only the IRIs it gets back.
For those, `loadGrant` is an HTTP dereference of the peer's pod (permitted: the
grant ACR gives the `grantor` `acl:Read`), which makes the comparison depend on
peer availability and on the grantor-read policy staying in place.

That is not acceptable for this plan, because §3.1/§3.2 compare **body-only**
fields (`dataOwner`, `registeredShapeTree`, `hasDataRegistration`, `hasStorage`,
`scopeOfGrant`, `accessMode`, `creatorAccessMode`, `hasDataInstance`, and the
child tree via `inheritsFromGrant`) — the IRIs alone cannot answer "is this the
same grant".

**Requirement: replicate the grants where we are `grantedBy`.** Call it the
*issuer-side* mirror (the reciprocal mirror is grantee-side and covers the
opposite direction):

- **Link source:** our own registration of the grantee — `hasDataGrant` is
  written by `replaceDataGrantsOnRegistration` on every regeneration, so it is
  the authoritative, local, complete list. No peer read is needed to know *which*
  grants must be present.
- **Bodies:** the grant documents. For source grants they are already in our
  grant registry; for delegated ones they are on the data owner's registry.
- **Freshness: none needed.** Grants are immutable (a change mints a fresh IRI —
  `improve-grant-replication.md` §2), so a replicated body is either current or
  absent. Replicate once when the link is written, drop the graphs whose link
  left the registration, and the mirror is correct by construction; only drift
  repair (a graph-at-a-time writer or a single-graph restore) needs a scan.
- **Write point:** the cheapest is the issuance path itself — `requestDelegation`
  already holds the response, and the server already holds `finalGrants`, so
  either (a) have the issuance endpoint **echo the finalised grants** and store
  them, or (b) store the IRIs' documents right after the call. Both satisfy the
  requirement with one round-trip; neither needs a periodic sync workflow.
- **Graph shape:** same convention as the reciprocal mirror — one named graph
  per grant IRI (`GRAPH <grantIri>`), read through the same `graphDoc` union.

Deliberately **not** proposed: on-demand caching inside `checkEquivalence`.
Reuse decisions must be a pure function of replicated state, otherwise the
"same input → same grants" property this plan is about cannot be tested.

> Coordination: `improve-grant-replication.md` T8 tracks the same gap from the
> replication side. If that plan's post-S9 work lands first with an issuance
> echo, this plan only needs to consume the replicated bodies.

## 3. Target: the real comparison

For each generated grant (source and delegated, **including child grants**),
find an existing grant whose **semantic fields are equal**; pair them.

### 3.1 Compared fields

Equal iff all of the following match (`GrantData` / `FinalGrantData`):

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
- `delegationOfGrant` — **excluded for delegated grants** (§3.4)

### 3.2 Child grant trees

A parent grant's equivalence includes its children (`hasInheritingGrant` /
`inheritsFromGrant`): match the **parent and its children as a unit** — the
generated parent matches an existing parent only if the existing parent's
children are equivalent (by the same field comparison, on the child's
`registeredShapeTree`, `accessMode`, `creatorAccessMode`, `hasDataInstance`,
`hasDataRegistration`) and the child sets have the same shape-tree composition.
Child IRIs are not compared (they are derived, like the parent's).

### 3.3 Matching algorithm

- Normalize sets (`accessMode`, `creatorAccessMode`, `hasDataInstance`) before
  comparing.
- Match **one-to-one, greedily**: iterate generated grants, find the first
  unclaimed existing grant with equal fields. (O(n·m) is fine — grant sets are
  small.)
- `type` is not compared (always `[INTEROP.DataGrant]`).

### 3.4 Delegated grants — the `delegationOfGrant` wrinkle

`generateDelegatedDataGrants` sets `delegationOfGrant: sourceGrant.id!` — the
**freshly generated** source grant's IRI. On a re-run that id never equals the
existing delegated grant's `delegationOfGrant` (which points to the *old*
source grant). Therefore:

- **Exclude `delegationOfGrant` from the comparison** for delegated grants;
  match on the other fields only.
- **Linkage caveat (documented):** if a source grant is *reused* while its
  delegated grants are *not* (or vice versa), a reused delegated grant's
  `delegationOfGrant` can point at the old source grant. In the common case
  (nothing changed) the whole chain is reused coherently, so the link stays
  valid. A follow-up could match **chains** (a delegated grant is reused only
  if its delegation source is also reused) — not needed for the first cut.

## 4. What reuse means downstream (already wired)

For every `{ existing, generated }` pair:

- **Store**: the generated counterpart is skipped — no new resource, no new ACR
  (`createAcr` not called for it).
- **Delete**: the existing grant is skipped by `reusedExistingIds` — its
  resource and ACR stay in place.
- **Registration**: `replaceDataGrantsOnRegistration` re-links the **existing**
  id (`[...newGrantIds, ...reused.map((e) => e.existing)]`).

Net effect on an unchanged re-run: **zero new grant resources, zero new ACRs,
zero delegation requests** — the registration's `hasDataGrant` set is unchanged
(after the single-PATCH diff, the PATCH is even a no-op).

## 5. Implementation steps

0. **Prerequisite (§2.1):** make the grant bodies where we are `grantedBy`
   available locally. Minimal cut: extend the issuance response with the
   finalised grants (or replicate the IRIs' documents in the same step) and
   store them as `GRAPH <grantIri>`; refresh nothing (immutability), drop on
   unlink. `getExistingGrants` then reads those graphs instead of `loadGrant`ing
   peer resources — assert it with a `fetch` stub that throws.
1. **`checkEquivalence` activity** (`activities/grants.ts`): implement the field
   comparison (§3) — a helper `grantsEqual(a, b, { includeDelegationOfGrant })`
   plus the child-tree matching (§3.2), and the greedy one-to-one pairing
   (§3.3). Return `{ reused }`.
2. **No workflow changes** — `createGrantsForAgent` already consumes `reused`.
3. **No data-model changes** — the comparison reads `GrantData` fields directly.

## 6. Interaction with the commented-out grant deletion

The old-resource HTTP-DELETE in `createGrantsForAgent` is **commented out**
(CSS 403 on grantor-side DELETE of delegated grants — see
`refactor-grants-workflows.md` design decision 3). Reuse does **not** fix that:
non-equivalent old grants remain orphaned. What reuse changes:

- an unchanged re-run produces **no new orphans** (nothing is replaced);
- when grants actually change, the replaced ones still orphan (unchanged
  behavior until the DELETE 403 is resolved).

## 7. Testing

- **Replica-only comparison (§2.1)**: `getExistingGrants` resolves every grant —
  including delegated ones whose `dataOwner` is a peer — from the local store; a
  `fetch` stub that throws on any IRI proves no peer dereference happens during
  a regeneration.
- **No-new-IRI-on-rerun**: run a regeneration twice with an unchanged
  authorization state and assert the registration's `hasDataGrant` set is
  **identical** (same IRIs) after the second run. Natural triggers: two
  identical `authorizationRecorded` activities (consumer coalesces, but a
  manual re-run via the reconciliation sweep reproduces it), or re-running the
  sweep on a `done`… no — on a **pending** activity after an unchanged
  regeneration.
- **Change → replace**: change one authorization and assert the changed grant
  is new while the unaffected grants keep their IRIs (partial reuse).
- **Delegated reuse**: a yoyo-delegated grant survives a re-run with the same
  IRI (covers §3.4).
- Extend `roles.test.ts` or a new `check-equivalence.test.ts`; the existing
  suite stays green (dummy → real is outcome-neutral when nothing is asserted
  about IRIs).

## 8. Out of scope / follow-ups

- Resolving the DELETE 403 (old-resource cleanup) — `refactor-grants-workflows.md`
  design decision 3.
- Chain-consistent reuse (delegated grant reused only with its source) — §3.4.
- Whole-registry regeneration (recovery scenarios only).
- Drift repair for the issuer-side mirror (§2.1): a graph-at-a-time backfill or
  single-graph restore can leave a linked grant without a body. Same class as
  the reciprocal mirror's `MirrorIncompleteError` / presence check
  (`improve-grant-replication.md` S7) — reuse that primitive rather than a
  second implementation.
