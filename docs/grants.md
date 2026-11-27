# Grants — policy, permission and target grouping

> **Status:** current behaviour (wire shape, producers, consumers).
> **Last reviewed:** 2026-11-27.
> Grouping is independent of the read-model refactor: that refactor changes how
> a grant is read (wire-shaped `GrantData`), not how it is grouped.

This note documents the grouping contract and the assumptions it rests on. It
also corrects three common assumptions about how policies are grouped per
grant.

## TL;DR — the three assumptions

| assumption | verdict |
| --- | --- |
| All policies of a grant share storage, assigner and assignee | **True today, but vacuous: a grant carries exactly one policy.** There is no multi-policy grant grouping in any producer. If you introduce one, see §6 — the reader does not enforce uniformity. |
| Policies have different registrations, so also different shape trees | **No.** Registration and shape tree are independent: one shape tree has many registrations (the seed's `Project` tree is registered in 11 pods). Different registrations are different **grants**, not different policies. |
| Policies that inherit are in the same grant | **No.** An `Inherited` grant is its own grant document, linked to its parent grant by `inheritsFromGrant`. They only become policies of one document when an **ID-JAG access claim** is derived (§5). |

## 1. Wire shape

A grant is an ODRL agreement under `lws:access`:

```
grant ─lws:access→ policy (odrl:Agreement) ─odrl:permission→ permission ─odrl:target→ target
```

- **One target per permission.** We never emit several `odrl:target` values
  on one permission (an ODRL permission can, and the claim verifier tolerates
  it, but our writer and generator produce one).
- Access **requests** are a different model (one `Request` policy per access
  need, see `openwiki/architecture/access-request-profile.md`); this note is
  about grants and the claims derived from them.
- The permission carries the parties and actions: `odrl:assigner` (delegator),
  `odrl:assignee` (delegatee), `odrl:action` (compacted mode tokens).
- The target carries the resource facts: `interop:dataOwner` (`owner`),
  `lws:storage`, `odrl:source`, `interop:registeredShapeTree`, and for a
  selected asset `interop:hasDataRegistration`.
- `scopeOfGrant` is on the grant node and mirrored on each policy (the reader
  falls back to the first policy when the grant node lacks it). Admin grants
  carry `interop:scopeOfAdminGrant` instead of a data scope.

```json
{
  "@context": { "...": "access context" },
  "id": "https://registry/acme/p9m2vr",
  "type": ["AccessGrant"],
  "scopeOfGrant": "AllFromRegistry",
  "access": [
    {
      "id": "urn:uuid:…-policy",
      "type": ["Agreement"],
      "profile": "AccessProfile",
      "scopeOfGrant": "AllFromRegistry",
      "permission": [
        {
          "id": "urn:uuid:…-permission",
          "assigner": "https://id/acme",
          "assignee": "https://id/bob",
          "action": ["read", "create", "modify", "delete"],
          "target": {
            "owner": "https://id/acme",
            "storage": "https://data/acme-rnd/",
            "type": ["AssetCollection", "DataRegistration"],
            "source": ["https://data/acme-rnd/reb39k"],
            "registeredShapeTree": "https://data/shapetrees/trees/Project"
          }
        }
      ]
    }
  ]
}
```

### Context and read model

Grants are read and written with `accessContext` (`= odrlAccessContext`: the
bundled LWS + ODRL + SAI contexts composed with `accessClaimTerms`). The
definitions this document depends on:

- `type` and `access` are `@container: '@set'` both at the top level and
  inside the bundled LWS `AccessGrant`/`AccessRequest` type-scoped contexts —
  without the scoped containers a grant frames with a scalar `type` and an
  object `access`;
- `action`, `profile` and `scopeOfGrant` are `@type: '@vocab'`, so they compact
  to bare tokens (`read`, `AccessProfile`, `AllFromRegistry`);
- `assigner`, `assignee`, `uid`, `source`, `owner`, `storage`,
  `registeredShapeTree`, `hasDataRegistration` are `@type: '@id'`;
- `access`, `permission`, `source` and `action` are always arrays; `target` is
  an embedded node (a scoped context there maps `value` to `lws:value`);
- `uid` maps to `odrl:uid` and is **distinct** from the node `id`.

Reads frame the grant with `GRANT_TERMS` (`@explicit`), embedding the policy
with `@embed: '@always'` and resolving `hasInheritingGrant` through a
`@reverse` term. `GrantData` (`packages/data-model/src/grant.ts`) is the wire
shape — `id`, `type`, `access`, `scopeOfGrant`, `inheritsFromGrant`,
`hasInheritingGrant`. The target facts (`storage`, `grantedBy`, `dataOwner`,
`registeredShapeTree`, `hasDataRegistration`, `hasDataInstance`) are not
fields: they are derived by the `grant*` helpers, so they cannot go stale. The
write path is the inverse: `toJsonLd` is a per-level `pick` of the wire terms
plus the two normalizations a builder may not have applied — the `AccessGrant`
envelope class and `uid ?? id` at policy, permission and target level. It
cannot be dropped entirely: a claim-derived policy may lack `uid`, and a
generated grant carries only the document's own classes until the write adds
the envelope.

## 2. What we emit

Every producer emits **one policy per grant document**:

- `grantAccess` (`packages/data-model/src/grant.ts`) returns `[policy]`;
- `adminAccess` (`packages/components/src/temporal/activities/admin.ts`)
  returns `[policy]`;
- the seeded fixtures (`environments/data/registry.trig`) have one
  `lws:access` per grant.

Permissions per policy depend on the scope:

| scope | permissions | target |
| --- | --- | --- |
| `SelectedFromRegistry` | **one per selected instance** (N permissions in one policy; all instances share the registration) | `odrl:Asset`, `source: [instance]`, `interop:hasDataRegistration`, `registeredShapeTree` |
| `AllFromRegistry` / `Inherited` | one | `AssetCollection` + `interop:DataRegistration`, `source: [registration]`, `registeredShapeTree` |
| `AllFromAgent` (not produced by generation; supported by `grantAccess`) | one | `interop:SocialAgent`, `source: [agent]`, `registeredShapeTree` |
| admin grant (`AdminGrant`) | one | `AssetCollection` + `lws:Storage`, `source: [storage]`, action `read` |

A `SelectedFromRegistry` policy with zero instances would have zero
permissions; the request path falls back to a registration-scoped request
instead, so a selected grant always has at least one permission.

### One grant per registration

`generateSourceAccessGrants`
(`packages/authorization-agent/src/grant-generation.ts`) creates one source
grant per **matching registration per pod**:

- `hasDataRegistration` set → only the pod holding that registration matches;
- only `registeredShapeTree` set → one grant per pod that has a registration
  of that tree (same shape tree, different registration/storage per grant).

The emitted grant scope is `SelectedFromRegistry` or `AllFromRegistry`. An
`All`/`AllFromAgent`/`AllFromRole` **data authorization** becomes
`AllFromRegistry` grants — the broader authorisation scope is resolved to
concrete registrations, it is not copied onto the grant. A selected
authorization keeps `SelectedFromRegistry`.

Delegated grants (`generateDelegatedAccessGrants`) are one per matching source
grant, with the same storage/registration/shape tree. Admin grants are written
separately by `storeAdminGrant` and are scoped to a storage (registry set or
data registry), not to a registration.

### Inheritance is between grants

`generateChildSourceGrantData` / `generateChildDelegatedGrantData` create a
**separate grant document for each inheriting authorization**:

- the child has its own id, policy, permission and target (its own registration
  and shape tree) and `inheritsFromGrant: <parent grant id>` — the
  **authoritative** link (the child's forward pointer always survives a
  round-trip; the reverse list is treated as unreliable);
- the parent may list the children in `hasInheritingGrant`, by id. Generation
  sets it, but the seeded fixtures carry only the child's `inheritsFromGrant`,
  so consumers must not require the parent-side list.

The parent and child share storage, data owner, assigner and assignee; they
differ in registration and shape tree. The seeded pair
`acme/p9m2vr` (Project) → `acme/hdaymz` (Task) is the canonical example.

During **delegated** generation the parent temporarily embeds full child grant
objects in `hasInheritingGrant` so reconciliation can flatten the tree;
`delegatedGrantBodies` converts them back to ids and stores every child as its
own grant body. The stored wire is ids — objects exist only in the in-memory
generation result.

## 3. Grant-level invariants

These hold for every grant we produce:

1. **One policy.**
2. **One registration per data grant (and therefore one storage).** A data
   grant never covers two registrations; instances of one selected grant share
   its registration. Admin grants are storage-scoped and have no registration.
3. **One shape tree** for selected, registration-scoped, inherited and
   `AllFromAgent` grants. The reverse is not true: many registrations and
   grants can share one shape tree.
4. All permissions of a grant share assigner, assignee, data owner, storage
   and action set; only the target (and, for selected grants, `source`) differs.

The reader relies on 1–4 but does not enforce them. It reads at two
granularities:

- **scalar facts** — storage, data owner, assigner — from the **first
  permission of the first policy**;
- **set facts** — shape tree, registration, selected instances, actions — from
  **all targets/permissions**.

The values come from the `grant*` helpers in
`packages/data-model/src/grant.ts` (`grantStorage`, `grantDataOwner`,
`grantAssigner` vs `grantShapeTree`, `grantRegistration`, `grantDataInstances`,
`grantAccessModes`). Do not add a writer that breaks 1–4 without updating
those reads (see §6).

## 4. Grants are read per policy elsewhere

Several consumers treat **a policy**, not a grant, as the unit:

- `grantFromPolicy` (`packages/components/src/grant-policy.ts`) wraps one
  policy into a grant-shaped view for coverage checks;
- `grantCoversClaim` compares a candidate grant with one claim policy;
- `grantFieldsEqual` (`components/src/temporal/activities/check-equivalence.ts`)
  compares the scalar facts and the flattened access shape — it therefore
  collapses a hypothetical multi-policy grant to its first permission for the
  scalar facts and to the first named registration/shape tree for the set
  facts.

This is fine while a grant is one policy and one registration, and is another
reason not to group several registrations into one grant document.

## 5. ID-JAG access claims: where the grouping changes

A claim is **not a grant**. It is a flat list of policies copied from the
grants an authority selects, with the grant boundary removed.

### Derivation (`DelegatedAccessClaimValidator.find`)

- Visible grants are those for the claim subject/client **and one storage**
  (`storage` is a claim-wide invariant; §5.2).
- The validator picks one **assigner edge**: app-specific grants
  (subject → client) win; otherwise `mostSpecificGrantEdge` groups the received
  grants (those granted to the subject) by assigner and keeps **all grants of
  the chosen assigner**, preferring a registration-level edge for a storage
  audience and the narrowest edge for a delegation hop.
- Every policy of every selected grant is copied verbatim
  (`grant.access.map(policy => ({...policy, inheritsFromGrant}))`). Selected
  grants keep their N permissions/targets; inheritance becomes a
  **policy-level** `inheritsFromGrant` pointing at the parent policy's
  `uid`/`id` (only when the parent grant is also in the selected set).
- Outgoing claims are bound to one assignee and have no assigner
  (`setAccessClaimAssignee`); re-issued claims keep policy/target structure and
  remap parent references and ids (`rewriteAccessClaim`).

So the assumption "all policies have the same storage, assignee and assigner;
policies may have different registrations/shape trees; inheritance is in the
same document" describes a **claim**, not a grant:

- one claim = one storage, one assigner edge, one assignee;
- it commonly spans several registrations and shape trees (e.g. the Project
  parent and the Task child, or several registrations of one assigner);
- parent and child policies live in the same claim, linked by
  `inheritsFromGrant`.

### 5.1 Coverage is matched per policy

`matchingAssigners` (`components/src/DelegatedAccessClaimValidator.ts`)
matches **each claim policy independently** against the grant set and
intersects the assigner sets. Different policies of one claim may therefore be
backed by different grants (parent and child, or different registrations), as
long as one assigner covers all of them. `grantCoversClaim` compares scope,
parties, shape tree, registration, storage, actions and selected instances
with the same coverage-not-equality rule as the grant chain. Scopes and access
modes are normalized before comparison (`asScopeTerm`/`asAccessModeTerm`
accept either the compact token or the absolute IRI), matching the `@vocab`
coercion of the access context.

### 5.2 Verification (`verifyAccessClaim`, `components/src/access-claim.ts`)

- the claim must contain at least one policy with a permission (policies are
  identified by `odrl:permission`); each of them has a `profile` and a
  supported `scopeOfGrant`, and `registeredShapeTree` must not be on the
  policy;
- every target has `interop:dataOwner`, `lws:storage`, `odrl:source`, and a
  `registeredShapeTree` unless the target is a `ShapeTree`;
- a selected `Asset` target must carry `interop:hasDataRegistration`;
- **all targets of the whole claim must share one `lws:storage`**;
- `odrl:assignee` is required per permission; an expected assignee must be the
  only one. Assigners are optional on ID-JAGs (legacy claims may carry one).

### 5.3 Evaluation on the storage (`SaiPermissionsEngine`)

`findAccessClaimData` re-groups the claim **per policy**: each policy gets its
own synthetic grant root (`urn:sai:ld:access-claim:N`) with `lws:access →
policy`, and `inheritsFromGrant` is remapped to the parent policy's synthetic
root. Evaluation then:

- `findGrant` matches a policy by its own `scopeOfGrant` and a permission
  target (`source` = registration, or `source` = resource plus
  `hasDataRegistration` for selected), and returns the first matching policy
  (`TODO: handle multiple valid grants`);
- `getAccessModes` unions `odrl:action` over **all permissions of that
  policy**;
- `findGrantTarget` (the inherited parent chain) reads the **first** target of
  the policy.

This is why the per-policy grouping must be honest: target matching is
per-permission, but the granted actions are the union of the whole policy. A
policy with heterogeneous targets/actions would over-grant on any match. Our
generator keeps one action set per policy, and the ODRL normalization note in
`docs/odrl.md` §6 ("one assignee, assigner, action and target per rule") is
the guard if external grants are ever ingested.

The unit test `policy-engine-claim.test.ts` "evaluates each policy of a
multi-policy claim independently" pins this: one policy's `read` does not leak
another policy's `modify`.

## 6. If you regroup (future work)

The model (`access: Array<OdrlPolicy>`) allows several policies per grant, but
nothing produces it and several assumptions would break:

- scalar reads take the first policy's first permission; a second policy with a
  different storage/owner/assigner would be silently ignored;
- `visibleGrants` filters **grants** by storage (derived from the first
  permission), then `find` copies **all** policies into the claim — a grant
  with policies for a second storage would produce a claim that
  `verifyAccessClaim` rejects (single-storage invariant), i.e. a broken or
  claimless ID-JAG;
- claim coverage is per policy, so multi-policy grants are already matched
  policy-by-policy there — but reconciliation (`grantFieldsEqual`) and the
  grant chain (`grantShapeTree`/`grantRegistration`) collapse a grant to its
  first registration/shape tree, so reuse and delegation would be wrong;
- inheritance is a grant-level link; grouping inherited children as policies
  inside the parent grant would change how claims, revocation and reuse walk
  the tree.

A safe regrouping keeps: one storage, one assigner, one assignee, one data
owner and one action set per grant; one registration per **policy**; policies
that differ only in registration/shape tree. Anything wider needs explicit
changes to the reads above.

## 7. Where this is tested

- `packages/data-model/test/pojo/access-grant.test.ts` — "uses one permission
  per selected resource", the exact wire terms per level, round-trip through
  `fromJsonLd`/`toJsonLd`;
- `packages/data-model/test/framing/grant.test.ts` — the seeded Project and
  Task grants (target facts, selected instances, inheritance links);
- `packages/data-model/test/framing/schema.test.ts` — the frame is the schema:
  framed keys are exactly `id`, `type` + `GRANT_TERMS`;
- `packages/components/test/grant-policy.test.ts` — per-policy coverage;
- `packages/components/test/delegated-access-claim-validator.test.ts` — edge
  selection, inherited links, registration-level vs asset-only preference;
- `packages/components/test/policy-engine-claim.test.ts` — claim evaluation,
  per-policy isolation, synthetic parent roots;
- `packages/components/test/admin-impersonation.test.ts` — read-only narrowing
  of the organisation claim;
- Dagger suite: `test/specific-instance-access-request.test.ts`,
  `test/share.test.ts`, `test/org-context.test.ts`,
  `test/federation-mirror.test.ts`, `test/impersonation.test.ts`.

## 8. Related documentation

- `docs/jsonld.md` — the JSON-LD layer behind this document: framing and
  `@explicit`, context composition (`accessContext`), language maps, the
  verified `jsonld@9.0.0` constraints and the write path.
- `docs/odrl.md` — ODRL alignment proposal; §2/§6 mention the one-permission-
  per-instance rule, §7 the target-copy instantiation pattern.
- `openwiki/architecture/id-jag-access-claims.md` — the ID-JAG chain, ODRL
  shape and claim-first evaluation. Its description of `GrantData` may lag the
  read model: treat `packages/data-model/src/grant.ts` as authoritative.
