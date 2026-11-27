# Data model — JSON-LD / framing plan

> **Status:** in progress. Items 1, 2, 3, 4, 5 and 8 are landed; the grant read
> model normalization was removed and the read paths are absolute-IRI-only. A
> review of `packages/data-model` and the JSON-LD helpers in `packages/utils`,
> with behaviour verified against the installed `jsonld@9.0.0` (framing,
> compaction and expansion probes).
> **Last reviewed:** 2026-11-26.

## Current state

The package is already framing-first:

- reads are `frameNode`/`frameDoc` (`jsonld.frame`) over fetched
  `application/ld+json`; writes are expanded once and PUT without `@context`
  (`packages/utils/src/jsonld.ts`);
- `fetchJsonLd` is the **only** place a base IRI enters: it expands against the
  response's final URL and rejects anything that stays relative;
- `@reverse` relationships, `@container: '@set'`, and `@container: '@language'`
  language maps are used deliberately (`packages/data-model/src/context.ts`);
- quads survive only at the SPARQL boundary and in the not-yet-migrated
  `authorization-agent/src/access-description-set.ts`.

What remains is structural, not incremental:

- the authorization-agent activity decode still canonicalizes `type` by hand
  and re-frames the same document once per embedded object (item 6);
- `shape-tree.ts` still resolves `descriptionLanguages` with a document-wide
  `documentValues` lookup (the description sets are separate nodes);
- write paths are projections (`toJsonLd` in grant, `withContext` in the other
  models) rather than a wire-shaped read model (see the open question).

Landed: the type-scoped container fix, the `CONTEXT` term maps, the typed
`Framed*` + `projectNode` read paths, the frame defaults, and the absolute-IRI
fetch boundary (see the progress log). `selectNode` is gone — framing plus
`frameNode`'s set defaults are the only filter the read paths need.


## Progress log

### Landed — item 1: type-scoped context shadowing

- The bundled LWS `AccessGrant`/`AccessRequest` scoped contexts now declare
  `@container: '@set'` on `type` and `access`. Without it, the type-scoped
  context shadowed the composed grant terms and grants framed with a scalar
  `type` and an object `access`.
- Regression tests: structural (scoped definitions equal `accessClaimTerms`)
  and behavioural (the grant fixture frames `type`/`access` as arrays, and an
  `AdminGrant` typed grant keeps both classes).

### Landed — item 5: one IRI representation

- `packages/utils/src/context-terms.ts` derives term maps from a context:
  `contextTerms` (token object), `contextIndex` (term→IRI and IRI→term),
  `pickTerms` (typed subset), `contextTerm`/`contextIri`.
- `packages/utils/src/terms.ts` builds `CONTEXT` and `CONTEXT_IRI` from
  `odrlAccessContext`; `ScopeOfGrant`, `AccessMode`, `AccessNecessity`,
  `AccessProfile`, `GrantClass` are typed subsets of the same object. Code
  uses `CONTEXT.AllFromRegistry`, `CONTEXT.AccessGrant`, `CONTEXT.read`, …;
  `CONTEXT_IRI[token]` is the absolute IRI.
- `accessContext` is now exactly `odrlAccessContext` (one composition, no
  duplicate spread); there is no separate term→IRI map to maintain.
- `scopeOfGrant`/`profile` are `@type: '@vocab'`; `resolveIri`/`PREFIX_IRI`
  were deleted from `grant.ts`. `asScopeTerm`/`asAccessModeTerm`/… normalize a
  token or an absolute IRI; `scopeIri`/`accessModeIri` resolve through
  `CONTEXT_IRI`.
- `dataModelContext` (`accessMode`, `required`, class terms) intentionally
  stays IRI-valued for now — separate follow-up.

### Landed — item 2: frame defaults (no `@default`)

- `buildFrame` builds each entry as `{ '@embed': '@never', ...(isForwardSet ?
  {} : { '@omitDefault': true }), ...overrides[key] }` — overrides **merge**,
  so `{'@embed': '@always'}` on an absent single-valued term is omitted, not
  `null`.
- **No `@default` anywhere.** Verified against the real `dataModelContext` and
  `accessContext`: with `@omitDefault` dropped, `@container: '@set'` alone
  yields `[]` for forward set terms (`contains`, `lwsContains`, `accessMode`,
  `access`). `@default: []` is silently ignored for `@reverse` and
  `@type: '@vocab'` terms, so it buys nothing.
- `frameNode` fills `[]` for **every** declared `@set` term the frame left out,
  including the `@reverse` (`hasInheritingNeed`) and `@vocab` (`action`) shapes
  the algorithm omits. Contract: *a declared set term is always an array*.
  `Framed*` types declare set terms as required arrays and `projectNode`
  returns `T` (not `Partial<Pick<T>>`), so the mappers no longer default them.
- Embedded nodes (policies, permissions, targets inside a grant) are not focus
  nodes and keep their local set defaults in `toOdrlPolicy`.
- The `[]` fill is restricted to the frame's term list (`frameNode` with
  `terms`), so a model never receives empty arrays for set terms of the shared
  context it does not read.
- Consequence in `access-request.ts`: a nested subframe
  (`hasAccessNeedGroup: { '@embed': '@always', hasAccessNeed: … }`) is a match
  requirement, so a group without needs frames as `null` — the case the old
  `EMPTY_GROUP` fallback papered over. The fallback is gone: a request without
  a group, or with a group that has no needs, throws.

### Landed — item 8: absolute IRIs, base only at the fetch boundary

- `fetchJsonLd` returns the document **expanded**, with `base = response.url`
  (the final URL after redirects — JSON-LD 1.1 §4.1.3, RFC 3986 §5.1), then
  `assertAbsoluteIris`. A response without `url` throws: a test double must
  model the final URL (helpers pass the document's `@id`).
- No base anywhere else: `frameDoc`/`frameNode`/`frameDataset`,
  `expandedJsonLd`/`putJsonLd`, `documentValues`, `toStore`, `toNQuads`. Write
  payloads assert absolute IRIs, so a relative IRI in a POJO fails loudly
  (`relative IRI #fragment in write payload`).
- `frameDoc` passes `compactToRelative: false`: with a base, compaction would
  otherwise emit relative IRI references (verified — a base plus default
  options compacts `https://…/grants/1/y` to `"y"`).
- Expansion drops a node that carries only `@id` (no statements); that matches
  the wire form, since PUT bodies are expanded.
- Identifier minting stays absolute: `${storageRoot}${uuid}`,
  `new URL(location, step.url)`, and the `CSS_*` templates now throw when
  `CSS_BASE_URL` is unset instead of minting `undefined.sai/...`.
- Mapper coercions became errors: `required(node, term)` for the terms the
  model requires (`registeredShapeTree`, `registeredAgent`,
  `hasAccessNeedGroup`, `grantee`, `grantedBy`, `dataOwner`,
  `scopeOfAuthorization`, `assigner`, `profile`), and `must(value, what, id)`
  for `storage`/`grantedBy`/`dataOwner` on a grant. The unit suite plus the
  Dagger integration suite confirm all of them on real data. Deliberate
  tolerances, each established by a failing document:
  - **`GrantData.scopeOfGrant` is optional.** An `AdminGrant` carries
    `interop:scopeOfAdminGrant`, never a data scope; the same reader
    (`Grant.fromJsonLd`) serves admin grants from the grant registry.
    `scopeCovers` now fails closed on an absent scope instead of comparing
    `undefined === undefined` and calling two scopeless grants cover each other.
  - **`registeredShapeTree` / `hasDataRegistration` stay `''`** when the grant
    is not shape-tree/registration-scoped (registry-set and data-registry admin
    grants target storage, not a shape tree).
  - **`DataAuthorization` validates only when the node is typed
    `interop:DataAuthorization`** — the same decoder doubles as a container
    probe (`getDataAuthorization` in `authorization-agent/src/sparql.ts`),
    where foreign nodes frame with empty fields and are filtered by type.
  - **`RegistrySet` registries are required — no `{ id: '' }` sentinel.** The
    account bootstrap (`templates/RegistrySet.ts` via `postBootstrapTriG`)
    creates all six core registries, so a registry set without one is
    malformed and throws (`required`). `hasActivityRegistry` /
    `hasAccessRequestRegistry` stay optional (seeded with their first member).
    A framing test round-trips the bootstrap TriG through
    `RegistrySet.fromJsonLd`, so template and read model cannot drift.
  - **`formatAccessNeed` emits `dataInstances` only for a non-empty array** —
    the set-term contract made `[]` always present, which would have added an
    empty RPC field to every shape-tree need.

### Landed — grant read-model normalization removed

`normalizeTarget` / `normalizePermission` / `normalizePolicy` in `grant.ts`
were doing four jobs: typing untyped framed nodes, filling set-container
defaults, whitelisting fields, and deriving the policy-level convenience
fields (`assignee`, `action`, `target`). The first three are now redundant:

- `access: { '@embed': '@always' }` embeds policy → permission → target;
- the access context guarantees the set containers (arrays) and tokens;
- `FramedTarget`/`FramedPermission`/`FramedPolicy`/`FramedGrant` types make the
  framed node typed with one boundary cast;
- one mapper, `toOdrlPolicy`, only fills defaults and lifts the first
  permission to the policy convenience fields. `deriveFields` stays — it
  derives the flat grant fields that are not on the wire.
- Behaviour note: extras framed on policies/permissions/targets are now
  preserved instead of dropped; `toJsonLd` still serializes only known fields.

The equivalent change for the other models (typed `Framed*` types, spread the
framed shape, keep only derived fields) is item 11 below.

### Landed — the other data-model read paths

Every data-model reader now declares a `Framed*` type for the framed shape and
casts the frame once (`frameNode(...) as unknown as Framed*`). `projectNode`
projects the framed node to `id`, `type` and the model's wire terms, so exact
POJO shapes are preserved without field-by-field copying; `selectNode` is no
longer used by `packages/data-model`.

Only the derivation stays:

- grant — `toOdrlPolicy` (convenience fields/defaults) + `deriveFields`;
- access need — `required`, `children`, `descriptionLanguages`;
- application registration — `granted`;
- data registration — `contains`/`partOf`;
- registry set — the registry wrappers;
- shape tree — `references`/`descriptionLanguages` (still extracted from the
  expanded document; nested framing is a later item).

## Principles

1. **A frame is the schema.** Each model declares its term set once; the same
   declaration drives framing, defaults and (where possible) the POJO
   projection. No second whitelist in `selectNode`.
2. **One IRI representation per POJO.** Either compact tokens or absolute
   IRIs — never "whatever compaction produced", re-expanded by hand.
3. **Context composition is explicit.** Terms that must survive on a typed node
   are declared *inside* that node's scoped context; a top-level merge is not
   enough and fails silently.
4. **Do not hand-walk expanded JSON-LD** for shapes that framing can express.
   Keep `documentValues` only for genuinely document-wide lookups.

## Work items

### 1. Fix type-scoped context shadowing (bug)

> **Status:** landed — the bundled `lwsV1Context` declares the set containers
> in both scoped contexts, and `grant.ts` no longer unwraps scalars.

`accessContext` is `{...lwsV1Context['@context'], ...odrlContext, ...saiContext,
...accessClaimTerms}`. `lwsV1Context` defines `AccessGrant` (and `AccessRequest`)
with a **type-scoped context**:

```ts
AccessGrant: {
  '@id': LWS.AccessGrant,
  '@context': { '@protected': true, id: '@id', type: '@type',
                storage: { '@id': LWS.storage, '@type': '@id' },
                inbox: {…}, access: LWS.access },
}
```

Any node typed `lws:AccessGrant` activates that context, which **wins over the
top-level** `type: {'@container':'@set'}` and `access: {'@container':'@set'}`
from `accessClaimTerms`. Result: `type` is a scalar, `access` is an object, and
`grant.ts` used to compensate with `asArray`/`resolveIri` (both gone).

Fix in the bundled context (add to its documented "local fixes" list), so both
`accessContext` and `odrlAccessContext` inherit it:

```ts
const withSetContainers = (def) => ({
  ...def,
  '@context': {
    ...def['@context'],
    type: { '@id': '@type', '@container': '@set' },
    access: { '@id': LWS.access, '@container': '@set' },
  },
})
patchedLws = {
  ...lws,
  AccessGrant: withSetContainers(lws.AccessGrant),
  AccessRequest: withSetContainers(lws.AccessRequest),
}
```

- Alternative: drop the two scoped terms from the composed context (simpler,
  loses the scoped `inbox` term).
- Do **not** rely on `@propagate: false` — it does not stop node-level
  shadowing.
- `@type: '@id'` is orthogonal to `@embed`: it only decides string-vs-IRI
  expansion and whether an emitted reference compacts to `"iri"` or `{ id }`;
  a frame's `@embed: '@always'` still embeds a coerced term.
- Acceptance: `grant.type` and `grant.access` are arrays from `fromJsonLd`;
  remove the now-redundant `asArray` calls in `grant.ts`; add a regression test
  that frames the grant fixture and asserts both containers.

### 2. `buildFrame`: merge overrides, set-container defaults

> **Status:** landed — no `@default`; overrides merge; `frameNode` fills `[]`
> for every declared set term.

An override used to **replace** the safe default, so `{'@embed': '@always'}`
on an absent property yielded `null`. Now entries are built as
`{ '@embed': '@never', ...(isForwardSet ? {} : { '@omitDefault': true }),
...overrides[key] }`, and `@container: '@set'` provides the array.

- `@default` is not used at all: `@container: '@set'` yields `[]` for forward
  set terms, and `@default: []` is ignored for `@reverse`/`@vocab` terms.
- `frameNode` fills `[]` for the shapes the algorithm omits (see the progress
  log), so the invariant "declared set term → array" holds everywhere.
- Acceptance met: no `?? []` for declared set terms, no `null` in framed nodes
  (a test asserts `Object.values(framed)` has no `null`).

### 3. Frame-as-schema: `@explicit` + the existing `*_TERMS`

> **Status:** landed.

Framing emitted every property of the focus node, so foreign predicates leaked
as raw-IRI keys and `frameNode` filled `[]` for set terms the model never reads.
`@explicit: true` restricts the output to the frame's property list in the
algorithm, and each model's `*_TERMS` constant is that list.

- `frameFor(context, iri, terms, overrides)` in `packages/utils` builds the
  frame: `{ '@context', '@id', '@explicit': true }` plus one entry per listed
  term with the same defaults as `buildFrame` (no `@default`; `@omitDefault`
  for single-valued/`@reverse`/`@vocab` terms). It throws for a term the
  context does not define and for a language-map term.
- `frameNode(doc, context, iri, { terms, overrides })` builds that frame and
  restricts its `[]` fill (`withSetDefaults`) to the same terms.
- Applied to `DataRegistration`, `DataAuthorization`, `AdminAuthorization`,
  `ApplicationRegistration`, `RegistrySet`, `ShapeTree`, `ClientIdDocument`,
  `AccessNeed`/`AccessNeedGroup`, `NeedBasedAccessRequest` (nested group
  overrides) and `Grant` (new `GRANT_TERMS`).
- Language-map models keep the context-wide frame and `projectNode`:
  `Role`, `WebIdProfile`, `SocialAgentRegistration`, `SocialAgentInvitation`,
  the two access-need description models and `ShapeTreeDescription`. So does
  `data-instance.ts`, whose term set is per shape tree.
- Verified: `@explicit` keeps `@type` without listing it, absent forward
  `@set` terms still frame as `[]`, absent `@reverse`/`@vocab` set terms are
  omitted (the `[]` fill covers them), and the flag does **not** restrict
  embedded child nodes (a nested `{'@embed': '@always'}` subframe keeps all of
  the child's properties).
- Verified limitation: `@explicit` combined with a `@container: '@language'`
  term throws in jsonld@9 (`reading '@value'` of undefined).
- Verified for nested frames (items 4/6): `@explicit: true` + `@requireAll:
  false` + a full term list yields `[]` for absent set terms, **but** a
  subframe whose listed properties are all absent still fails to match — the
  parent property becomes `null`. A nested child must carry at least one
  listed term, or be framed separately by `@id`.
- Acceptance met: `packages/data-model/test/framing/schema.test.ts` asserts
  framed keys are exactly `id`, `type` + the term list and that no `http…` key
  survives; `packages/utils/test/jsonld.test.ts` covers `frameFor` itself.

### 4. Nested framing instead of expanded-document walks

> **Status:** landed.

`@embed: '@never'` applied to every term, so child-node shapes fell back to
`jsonld.expand` walks.

- `shape-tree.ts` `fromJsonLd` frames the references with
  `references: { '@embed': '@once' }`; `referenceNodes` pairs
  `hasShapeTree`/`viaPredicate` from the embedded nodes and dedupes by
  (shape tree, predicate). `expandedNodes`, `referencePairs` and the `byId` map
  are gone.
- `shape-tree.ts` `getDescription` uses two selector frames via the new
  `frameMatches(doc, context, patterns)`: nodes carrying `descriptionLanguages`
  (the tree document does not type the sets — `a shapetrees:DescriptionSet`
  lives in the set's own graph), then the descriptions that `describes` the tree
  (filtered by `inDescriptionSet`).
- `descriptionLanguages` in `fromJsonLd` stays a `documentValues` lookup: the
  language tags sit on separate nodes, and no single frame can select
  "description sets of this tree" (there is no forward link from the tree).
- Verified: `@requireAll: true` on a **multi-property selector** does not
  restrict matches in jsonld@9 — every node matching any pattern is returned
  (non-matching properties come back `null`), so the exact description is
  filtered in the mapper.
- Verified: a nested reference subframe with property patterns
  (`hasShapeTree`/`viaPredicate`) drops a **dangling** reference silently; a
  bare `{ '@embed': '@once' }` keeps it as an id-only node, which the mapper
  rejects.
- Acceptance met: `shape-tree.ts` has no `jsonld.expand` call; the reference
  and description tests are unchanged (plus new dedupe/dangling cases).

### 5. One IRI representation (`resolveIri` removal)

> **Status:** landed — `CONTEXT` is generated from the combined access context
> (`context-terms.ts`), grant POJOs carry tokens, and `resolveIri`/`PREFIX_IRI`
> are gone.

`jsonld.frame` compacts vocabulary positions differently: `@type` values to
class terms (`AccessGrant`), `@type: @id` values to compact IRIs
(`interop:AllFromRegistry`), `@type: @vocab` values to vocab terms (`read`).
The grant POJO contract is now **compact tokens for vocabulary positions,
absolute IRIs for IRI positions** (`storage`, `source`, grant links, …).

**How the tokens work.** `context-terms.ts` turns the combined context into
term maps: `contextTerms` yields the token object, `contextIndex` resolves the
term IRIs and the reverse IRI→term lookup. `CONTEXT` is the whole access/grant
context, `CONTEXT_IRI` its token→IRI table:

```ts
// packages/utils/src/terms.ts
const INDEX = contextIndex(odrlAccessContext)
export const CONTEXT = contextTerms(odrlAccessContext)      // { AllFromRegistry: 'AllFromRegistry', … }
export const CONTEXT_IRI = INDEX.iriByTerm                  // token → absolute IRI

// typed views select the terms of one position; values still come from CONTEXT
export const ScopeOfGrant = pickTerms(CONTEXT, [
  'All', 'AllFromAgent', 'AllFromRegistry', 'AllFromRole',
  'SelectedFromRegistry', 'Inherited',
] as const)
export type ScopeOfGrantTerm = (typeof ScopeOfGrant)[keyof typeof ScopeOfGrant]
```

So code uses `CONTEXT.AllFromRegistry`, `CONTEXT.AccessGrant`,
`CONTEXT.read`; `CONTEXT_IRI[CONTEXT.AllFromRegistry]` is the IRI.
`asScopeTerm` / `asAccessModeTerm` / `asGrantClassTerm` normalize a token or
an absolute IRI through `contextTerm`; `scopeIri` / `accessModeIri` resolve
through `CONTEXT_IRI`.

- The context is the only source: no separate term→IRI maps are maintained,
  and no map is spread back into the context.
- `scopeOfGrant` and `profile` are `@type: '@vocab'` in the access context,
  which is what makes those values frame as tokens.
- `GrantData`/`OdrlPolicy`/`OdrlPermission`/`OdrlTarget` type the vocabulary
  positions as token unions; `type` stays open so domain classes are accepted.
- The grant-chain predicates (`scopeCovers`, `accessModesCover`,
  `selectedInstancesCover`, …) normalize both sides with the `as*Term`
  helpers.
- `dataModelContext` (`accessMode`, `required`, `type` class terms) stays
  IRI-valued for now — a separate follow-up, not needed to delete
  `resolveIri`.
- Acceptance: `Grant.fromJsonLd` output is tokens + absolute IRIs only; no
  `resolveIri`; package and integration tests updated.

### 6. Activity decode: one frame, and preserve `@type`

- `AuthorizationGranted` re-frames the same document once per object id
  (N+1 `jsonld.frame`). A single frame with `@id: [activityIri, ...objectIris]`
  returns `@graph` with every match top-level and resolves `@reverse` per node
  — replacing the two-phase decode.
- Replace `canonicalType = ['Activity', cls, ...asvOnly]` with a class
  discriminant derived by set membership (`activityClass`) and keep the
  document's other `rdf:type` values; do not drop unknown types.
- Acceptance: one frame call per activity; `type` contains every non-storage
  type from the document; activity tests unchanged.

### 7. Context architecture (follow-up, larger blast radius)

- Per-model **type-scoped contexts** instead of the 65-term union; each model
  owns its terms and its reverse/container definitions.
- `@protected: true` on the shared context. The blocker is
  `data-instance.ts`'s `delete context.label`: introduce a distinct
  `instanceLabel` term (mapped to the shape tree's `describesInstance`) and
  drop the mutation.
- Replace `{...lws, ...odrl, ...sai}` spreads with `@import` over the bundled
  context documents (works with the local `documentLoader`). This also makes
  item 1 visible at composition time.
- Do **not** add a global `@vocab`; scope vocab coercion to enum terms and
  type-scoped contexts.
- Acceptance: `duplicate/conflicting term definitions` test passes; data
  instance framing keeps working without context mutation; no term is defined
  twice with different definitions.

### 8. Base IRI: absolute IRIs only

> **Status:** landed — the base enters at `fetchJsonLd` and nowhere else.

The package never creates relative IRIs. The only source is a retrieved
document, so `fetchJsonLd` expands the payload against `response.url` (the
final URL after redirects) and `assertAbsoluteIris` rejects anything that stays
relative — e.g. a document declaring `"@base": null`, which suppresses
resolution even when a base is supplied (verified).

- No `base` option on `frameDoc`/`frameNode`/`frameDataset`, `expandedJsonLd`,
  `putJsonLd`, `documentValues`, `toStore`, `toNQuads`; write payloads assert
  absolute IRIs instead.
- `frameDoc` always passes `compactToRelative: false` (a base would otherwise
  make compaction emit `"y"` for `https://…/y`).
- `response.url` is required: no fallback to the requested IRI, so the base is
  always the resource's final URL. Test doubles report the document's `@id`.
- Acceptance met: a document with `@id: '#me'` expands to
  `<final-url>#me`; a surviving relative IRI throws; PUT bodies are absolute.

### 9. ACR layer: root ids and read/write symmetry

- `agentRegistrationAcrJsonLd` writes `${acr}#registration`,
  `accessGrantAcrJsonLd` writes `${id}#grant`, while `rewriteFullAdminAccess`
  expects `${acrId}#root` — a rewrite adds a second root node instead of
  wiring the existing one. Standardise on `#root` or locate the root by
  `acp:resource` + `acp:AccessControlResource`.
- `rewriteFullAdminAccess` hand-edits expanded JSON-LD; consider a typed ACR
  read model + `toJsonLd` so read and write use the same shape.
- `templates/RegistrySet.ts` still emits the ACR as TriG, duplicating `acr.ts`.
  Generate it from the same builder or assert quad equality in a test.

### 10. Hygiene

> **Status:** mostly landed. `viaPredicate` stays an RDFJS `NamedNode`.

- **Landed** — `jsonld` dropped from `packages/data-model` and
  `packages/authorization-agent` (and `@types/jsonld` from data-model): both
  packages only ever reached it through `@janeirodigital/interop-utils`, tests
  included. `packages/utils` is the one package that depends on it.
- **Kept deliberately** — `ShapeTreeReference.viaPredicate` stays an RDFJS
  `NamedNode`; `n3`/`@rdfjs/types` therefore stay dependencies.
- **Landed** — the nonexistent `docs/jsonld.md` references were removed from
  code comments, and comments state the constraint inline instead of pointing
  at a plan document (this file is temporary, so nothing references it).
- **Landed** — `selectNode` is removed (unused since `projectNode`). The
  `openwiki/data-model/json-ld-layer.md` page still describes it; OpenWiki has
  no automatic refresh configured, so the page needs an explicit update run.
- Note: this document is working material and will be deleted once the plan is
  finished — nothing in the code may reference it.


### 11. Apply the grant simplification to the other models

> **Status:** landed for the data-model readers (typed `Framed*` + `projectNode`)
> and for `shape-tree.ts` (nested references, framed description lookup).
> Remaining: the authorization-agent activity decode.

The grant read path is now the template:

- declare the framed shape (`Framed*`) once per model instead of
  `Record<string, unknown>` + per-field casts;
- spread the framed object, default only the set-container fields;
- keep a mapper only for derived values that are not on the wire
  (`deriveFields`) and for policy/POJO convenience fields (`toOdrlPolicy`).

Remaining targets:

- activities (`authorization-agent/activity-registry.ts`) — typed framed
  union; keep only the class discriminant/canonical `type` and embedded
  snapshot normalization; replace the N+1 re-framing with one multi-`@id`
  frame;
- write paths: see the open question below (`toJsonLd` projection in grant,
  `withContext` in the other models).


## Open question — the grant write path (`toJsonLd`)

`toJsonLd` is **not** a compaction step; it is a projection from the read model
to the wire model. It drops values that exist only in the POJO:

- grant-level derived fields (`storage`, `grantedBy`, `dataOwner`,
  `registeredShapeTree`, `hasDataRegistration`, `hasDataInstance`);
- policy-level convenience fields (`assignee`, `action`, `target` — the wire
  representation is the `permission` array);
- it adds the envelope class (`AccessGrant`), defaults `uid ?? id`, and keeps
  the optional `inheritsFromGrant`/`hasInheritingGrant` links.

`jsonld.compact` cannot drop properties — it emits everything present in the
input; omitting a term from the context only turns a key into a full IRI, it
does not remove it. `jsonld.frame` *can* select properties with
`@explicit: true`, but that needs a **write frame** (the same schema as the
read frame), an extra expand→frame pass, and makes `toJsonLd` async. It would
be the declarative end state, not a drop-in replacement.

Options, in increasing order of change:

1. **Keep the projection, make it structural** (current): explicit
   `toJsonLd`, typed `FinalGrantData` input. It is the only place that knows
   which POJO fields are derived; tests pin the wire shape (`toStore`
   assertions).
2. **Typed write projection**: define `GrantWire` (the exact serializable
   shape) and build it with a spread/`pick` of wire terms; `toJsonLd` becomes
   `withContext(accessContext, pick(grant, WIRE_TERMS))` plus the nested
   policy/permission/target selection. Same behaviour, less hand-written field
   copying.
3. **Wire-shaped read model**: move the derived grant fields out of
   `GrantData` (`grantStorage`, `grantDataOwner`, … already exist as helpers)
   so the POJO *is* the wire shape; then `withContext(accessContext, grant)`
   suffices and `toJsonLd` disappears. This is the cleanest end state but
   touches every consumer that reads `grant.storage`/`grant.hasDataRegistration`
   directly.
4. **Declarative write frame**: a `grantWriteFrame` with `@explicit: true`
   at every level, reusing the read term lists; `toJsonLd` becomes async.
   Best if we want one frame/schema for both directions.

Recommendation: keep (1) until item 11 has migrated the other models, then do
(3) together with the write-path cleanup; fall back to (2) if moving derived
fields is too invasive.

## Verified `jsonld@9.0.0` constraints

| Feature | Behaviour |
| --- | --- |
| `@explicit: true` | output restricted to frame-listed properties; `@type` is kept without listing it |
| `@explicit` + nested `{'@embed': '@always'}` subframe | the embedded child keeps all its properties — the flag does not restrict embedded nodes |
| `@requireAll: true` on a selector with several property patterns | does **not** restrict the match: nodes matching any pattern are returned, non-matching properties are `null` |
| nested reference subframe with property patterns | a dangling reference matches nothing and is dropped silently; a bare `{ '@embed': '@once' }` keeps it as an id-only node |
| `@explicit` + `@container: '@language'` | throws (`reading '@value'` of undefined) |
| `@explicit` + absent forward `@set` term | `[]` (same as without `@explicit`) |
| `@explicit` + absent `@reverse`/`@vocab` set term | omitted — `frameNode` must fill `[]` |
| `@default: []` | yields `[]` when absent (forward set terms only) |
| `@default` + `@omitDefault: true` | `@default` ignored, property omitted |
| set container + no `@omitDefault` | `[]` for forward `@set` terms (`@type: '@id'`, literals) |
| set container on `@reverse` / `@vocab` term, no `@omitDefault` | property **omitted** — no `[]`, and `@default` cannot rescue it |
| single-valued term, no `@omitDefault` | `null` (so every non-set term keeps `@omitDefault: true`) |
| nested subframe property list | acts as a **match requirement** (`@requireAll` default false): a child without the listed term yields `null` for the parent property; nested `@default`/`@omitDefault` do not help |
| nested frame with no matchable property | the child compacts to a bare IRI **string**, not an object |
| `@explicit: true` + `@requireAll: false` + full term list | absent set term frames as `[]`, child still matches — the recipe for item 3 |
| expansion of a node with only `@id` | node dropped (no statements) |
| `@base: null` + `base` option | relative IRIs survive expansion (no error) → caught by `assertAbsoluteIris` |
| `frame` with `base`, default options | compacts IRIs to relative references (why `compactToRelative: false` is mandatory) |
| `@embed: '@once'` | dedupes repeated references |
| `@embed: '@always'` on a nested node | frames the child with terms; `@reverse` does not resolve inside it |
| multi-`@id` frame | returns `@graph`, each match top-level, `@reverse` resolves per node |
| `@graph` in a frame | must be a single object; property patterns do not filter — not a reliable selector |
| `@type: '@vocab'` | bare tokens (`AccessRequired`) |
| `@type: '@id'` | IRI/compact-IRI only (`interop:AllFromRegistry`), never a value term |
| type-scoped context | shadows top-level terms for typed nodes; `@propagate: false` does not prevent node-level shadowing |
| `@protected` | redefinition throws; identical redefinition allowed |
| `@import` | works through the bundled `documentLoader` |
| `jsonld.frame` without `base` | relative `@id`s never match an absolute frame `@id` |
| `base` + `compactToRelative: false` | absolute ids in framed output |

## Landing order

1. Item 1 (bug) + regression test. — **landed**
2. Item 2 (frame defaults) — removes fallbacks used by items 3–6. — **landed**
3. Item 8 (base) — correctness, independent. — **landed**
4. Item 5 (representation) — POJO contract change. — **landed**
5. Item 3 (`@explicit` + `*_TERMS`) — prerequisite for the nested frames in
   items 4 and 6. — **landed**
6. Item 4 (nested framing in `shape-tree.ts`) — deletes the expanded-document
   walks. — **landed**
7. Item 6 (activity decode) — authorization-agent side; one multi-`@id` frame.
8. Items 7, 9, 10 — cleanup / follow-up, can land independently.

## Out of scope

- Replacing `documentValues` with `@graph` frames (verified unreliable).
- Global `@vocab`.
- Changing the wire vocabulary or the frozen grant/access-claim shapes.
