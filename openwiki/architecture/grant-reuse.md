---
type: architecture
title: Grant equivalence and reuse
description: How an unchanged authorization state regenerates to the same grant resources — whole-subtree equivalence over GrantData fields, source vs delegated tree matching, the issuer-side grant replica written from the issuance echo, fail-closed missing bodies, and the value-based result the grant workflow consumes.
tags: [architecture, grants, equivalence, delegation, temporal, replica]
sources:
  - id: openwiki-source-99a0f343f48d54d1c1e98086
    resource: repo://packages/components/src/GrantIssuanceHandler.ts
  - id: openwiki-source-9e7488ce272b5af0500c0557
    resource: repo://packages/components/src/services/GrantReplica.ts
  - id: openwiki-source-5685475b394b1360422a797d
    resource: repo://packages/components/src/temporal/activities/check-equivalence.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
generated: { by: "pi", at: "2026-10-22T04:35:20.186Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-22T04:54:18.757Z
---

# Grant equivalence and reuse

Every grant regeneration (`reconcileGrantsForGrantee`, to which
`createGrantsForAgent` delegates) normally mints fresh IRIs and re-writes the
registration, so an unchanged authorization state would replace the whole grant
set on every re-run — new grant resources, new ACRs, new delegation requests —
while the old resources become orphans. Grant reuse removes that churn: when a
generated grant **tree** is equivalent to an existing one, the existing
resources and ACRs stay and only their IRIs are re-linked. Non-reused trees are
collected (delete-before-create) before any replacement is written.

## The regeneration contract

`createGrantsForAgent` is a thin delegate to `reconcileGrantsForGrantee`,
which fetches the grantee's authorizations and its current grants (the
registration projection unioned with an own-registry orphan scan), handles the
deny case, generates fresh grant data, and asks `checkEquivalence` what can be
kept. It deletes the non-reused existing grants first (own registry through the
owner's closure, peer-owned through the `AccessRevocation` boundary, with the
issuer-side replica dropped), stores only the non-reused source grants,
requests only the non-reused delegated grants, and rewrites the registration as
`[...newGrantIds, ...reusedExisting]` last.

The equivalence result is **value-based**, not object-based:

```ts
interface EquivalenceResult {
  reusedSourceIds: string[]          // generated.sourceGrants ids to keep
  reusedDelegatedIndexes: number[]   // positions in generated.delegatedGrants
  reusedExisting: GrantId[]          // existing IRIs to keep linked
}
```

The shape is forced by two properties of the boundary:

- `checkEquivalence` is a Temporal activity, so its arguments and result cross
  the data converter. A result keyed on object identity (`Set<GrantData>`) can
  never match the workflow's freshly deserialized `generated` entries — the
  earlier wiring silently skipped nothing. Ids and array indexes survive.
- Generated delegated grants carry **no ids yet** (the issuance endpoint mints
  them), so they are addressed by their position in the array. A reused
  delegated parent is skipped as a whole, including its embedded children.

`reusedExisting` carries **parents and children** of every matched tree. The
registration PATCH rewrites the complete `hasDataGrant` set, so omitting a
reused child would silently unlink it. Source children are separate
`sourceGrants` entries (skipped by id); delegated children exist only as
embedded objects, so their existing IRIs arrive through `reusedExisting`.

## What counts as equivalent

A grant's identity is its **subtree**, not the individual resource.

- **Compared fields:** `grantee`, `grantedBy`, `dataOwner`,
  `registeredShapeTree`, `hasDataRegistration`, `hasStorage`, `scopeOfGrant`,
  and the set-valued `accessMode`, `creatorAccessMode`, `hasDataInstance`.
  Sets are order- and duplicate-insensitive; an absent optional set equals an
  empty one.
- **Not compared:** `id` (minted per run), `type` (always `DataGrant`),
  `inheritsFromGrant` (a derived parent IRI that changes with the parent), and
  `hasInheritingGrant` (structure, compared by the tree walk). `delegationOfGrant`
  no longer exists: delegated-chain validity is match-based.
- **Subtree as a unit.** A parent matches only if the whole subtree matches —
  same child count and a one-to-one equivalence between children, recursively.
  A child is never reused under a new parent: the child's `inheritsFromGrant`
  points at the old parent, so a new parent linking it would leave two parents
  claiming it. If any member differs, the whole subtree is regenerated.
- **n-depth ready.** Generation creates one level of inheritance today, but the
  tree builders and `pairNodes` recurse, so deeper inheritance needs no
  comparison change.

The two generated shapes are different and get separate builders:

- source grants are a **flat list** linked by `id` + `inheritsFromGrant`, with
  the parent's `hasInheritingGrant` holding child IRIs;
- delegated grants **embed** child objects in `hasInheritingGrant` (no ids yet),
  so their tree comes straight from the nesting.

Existing bodies are always the flat shape: `graphDoc(parent)` surfaces children
through the reverse `inheritsFromGrant` edges. A flat tree is **complete** only
when every declared child is present with the matching parent link; an
incomplete tree is dropped, never treated as childless.

Pairing is greedy and one-to-one: iterate generated trees, claim the first
unclaimed existing tree that matches, and return the flattened node
correspondence (parent first, then descendants). The existing side is split by
root `dataOwner`: trees owned by the context pair with generated source trees;
peer-owned trees (the issuer-side replica) pair with generated delegated trees.
Each existing tree is claimed at most once.

## Where existing bodies come from

`getExistingGrants` stays IRI-only (the registration projection). The activity
loads bodies lazily through `getExistingGrantBodies`:

- it reads the **session's own SPARQL endpoint** only — the grant registry for
  source grants, the issuer-side replica for delegated ones — never a peer
  resource;
- it follows `hasInheritingGrant` recursively, so a child that is missing from
  the registration projection still joins its parent;
- a missing or unframable body is skipped, which fails the tree's completeness
  check and forces regeneration (fail closed), never a silent partial match.

### The issuer-side replica

Delegated grants live in the **data owner's** registry; the grantor only gets
IRIs back. The issuance endpoint therefore echoes the finalised grants (parents
and children), and `requestDelegations` stores each body as `GRAPH <grantIri>`
in the context's own registry-pod dataset via `storeGrantReplica`.

- The parent document keeps the reverse `inheritsFromGrant` edges (the context
  maps `hasInheritingGrant` to the reverse property), so framing the parent
  surfaces its children; child bodies are their own graphs. Grants are
  immutable, so re-writing a body is a no-op.
- The write is **best effort**: the grants are already issued, so failing the
  activity would retry the POST and mint duplicates. A missing body only
  disables reuse until the next issuance or regeneration repopulates it.
- The writer only inserts. Replica graphs of removed delegated trees are
dropped by `dropGrantReplicas`, which the reconciliation GC runs right after a
peer-owned boundary revocation; it drops both the grant graph and its `meta:`
twin and never touches own grant-registry graphs. A stale graph that survives a
crash is invisible to reuse (only current registration links are read) and is
removed by the next reconciliation.
- Grants issued before the echo existed have no replica body. They fail closed
  once (regenerated), which populates the replica for later runs.

## What reuse changes downstream

- **Unchanged re-run:** no source store/ACR (`storeGrantAndAcr` skipped), no
  delegation request, and the registration PATCH is a no-op — the same
  `hasDataGrant` set.
- **Partial change:** only the affected subtree gets new IRIs; unaffected
  subtrees keep theirs. The non-reused old subtree is deleted by the projection
  GC before the replacement is created (own registry locally, peer-owned at the
  owner's revocation boundary).
- **Deny case:** no authorizations means no generation/equivalence; the
  registration is cleared as before.

## Tests

- `packages/components/test/check-equivalence.test.ts` — field comparison
  (set normalization, ignored ids/derived links), flat and embedded tree
  builders (order, n-depth, missing child, orphan, mismatched parent), subtree
  equality (child order, child change, parent change), and greedy pairing
  including the child correspondence.
- `packages/components/test/check-equivalence-activity.test.ts` — local-only
  body loading, source and delegated subtree reuse, delegated child missing →
  fail closed, source/delegated pools paired independently, and index
  addressing (`[1]` of two delegated grants).
- `packages/components/test/grants-workflow.test.ts` — the workflow's
  value-based skip and **all** reused IRIs (parents + children) re-linked on the
  full-set registration PATCH; the regression test against object-identity
  reuse.
- `packages/components/test/delegation-request.test.ts` — the echoed-grant
  response, one named graph per grant with the reverse child edge, best-effort
  replica failure, and malformed-response rejection.
- `test/check-equivalence.test.ts` (Dagger) — runs `createGrantsForAgent` twice
  for a source pair (seeded acme → alice keeps `g4yhtm` + child `wpqyds`) and
  for a delegated pair (alice → test client reuses what the first run issued),
  asserting identical registration IRIs. `test/reconciliation.test.ts` pins the
  same reuse through the reconcile sweep.

## Limits and follow-ups

- Replica drops ride the revocation GC (`dropGrantReplicas`), not the replica
  writer itself.
- Backfill/drift for pre-echo grants is natural (one regeneration) but there is
  no drift scan for replica bodies.
- Whole-registry regeneration is a recovery scenario, not part of reuse.

## Related pages

- [Authorization revocation and grant projections](authorization-revocation.md)
  — the projection GC, delete-before-create ordering, and replica drops.
- [Federation constraints](federation.md) — the reciprocal mirror, the
  issuer-side replica, and the per-pod store split.
- [Temporal workflows and activities](../temporal/workflows.md) — the
  regeneration workflow and its activities.
- [Data model entities](../data-model/entities.md) — `GrantData` fields and the
  grant tree links.
- [Integration test suite](../testing/integration-tests.md) — where the reuse
  assertions live.
