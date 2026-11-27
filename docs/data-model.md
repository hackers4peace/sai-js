# Data model — JSON-LD / framing plan

> **Status:** in progress. Items 1 and 5 are landed; the grant read model
> normalization was removed. A review of `packages/data-model` and the JSON-LD
> helpers in `packages/utils`, with behaviour verified against the installed
> `jsonld@9.0.0` (framing, compaction and expansion probes).
> **Last reviewed:** 2026-11-26.

## Current state

The package is already framing-first:

- reads are `frameNode`/`frameDoc` (`jsonld.frame`) over fetched
  `application/ld+json`; writes are expanded once and PUT without `@context`
  (`packages/utils/src/jsonld.ts`);
- `@reverse` relationships, `@container: '@set'`, and `@container: '@language'`
  language maps are used deliberately (`packages/data-model/src/context.ts`);
- quads survive only at the SPARQL boundary and in the not-yet-migrated
  `authorization-agent/src/access-description-set.ts`.

What remains is structural, not incremental:

- framing is still used as "return one node", not as a schema — one
  kitchen-sink context, `@embed: '@never'` everywhere, and `@default` only in
  `data-registration`;
- `shape-tree.ts` still walks the expanded document for `references` and
  `descriptionLanguages`, and the authorization-agent activity decode still
  canonicalizes `type` by hand;
- write paths are projections (`toJsonLd` in grant, `withContext` in the other
  models) rather than a wire-shaped read model (see the open question).

Landed: the type-scoped container fix, the `CONTEXT` term maps, and the typed
`Framed*` + `projectNode` read paths (see the progress log). `selectNode` and
the per-field normalizers are no longer used by `packages/data-model`.


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

### 2. `buildFrame`: merge overrides, derive `@default` from `@container`

Today `buildFrame` sets `frame[key] = overrides[key] ?? { '@embed': '@never',
'@omitDefault': true }` — an override **replaces** the safe default, so
`{'@embed': '@always'}` on an absent property yields `null` and every model
carries a fallback (`access-request.ts` group default).

- Merge instead: `{ ...base, ...overrides[key] }`.
- Derive `{ '@default': [] }` for terms whose context definition has
  `@container: '@set'`; keep `{ '@omitDefault': true }` for the rest.
- `@default` is ignored when `@omitDefault: true` is also present — set exactly
  one per term.
- Acceptance: no `?? []` needed for declared set terms; no `null` values in
  framed nodes.

### 3. Frame-as-schema: `@explicit` + the existing `*_TERMS`

Framing emits every property of the focus node; `selectNode` then re-filters.
`@explicit: true` does that in the algorithm. The `*_TERMS` constants
(`data-authorization.ts`, `admin-authorization.ts`, `client-id-document.ts`,
`access-request.ts`, `data-registration.ts`, `role.ts`) are already the frame
property list.

- Add `frameFor(context, iri, terms, overrides)` to `packages/utils` producing
  `{ '@context', '@id', '@explicit': true, ...termFrame }`.
- Apply to models **without** language-map terms; keep `selectNode` for
  `Role`, `WebIdProfile`, `SocialAgentRegistration`, `SocialAgentInvitation`,
  the two description models, and the invitation snapshot decode.
- Verified limitation: `@explicit` is incompatible with `@container:
  '@language'` in jsonld@9 (field dropped; `{}`/`[]` throw; `{'@embed':
  '@never'}` emits `null` under the full IRI). Do not attempt to include
  language-map terms in an `@explicit` frame.
- Acceptance: framed keys are exactly `id`, `type` + the term list (except
  language-map models); a test asserts no `http…` keys in framed output.

### 4. Nested framing instead of expanded-document walks

`@embed: '@never'` is applied to every term, so child-node shapes fall back to
`jsonld.expand` walks.

- `shape-tree.ts` `referencePairs`: replace with
  `references: { '@embed': '@once', hasShapeTree: {'@embed': '@never'},
  viaPredicate: {'@embed': '@never'} }`; framing returns the reference objects
  and dedupes repeated ids. Delete `expandedNodes`/`byId`.
- `shape-tree.ts` `getDescription`: two expanded scans become frames —
  a type-only frame for the description set, then
  `{ '@type': Description, describes: { '@id': tree },
  inDescriptionSet: { '@id': set } }` with `@requireAll: true`.
- Use `@embed: '@once'` (not `@always`) for deep frames so shared nodes are not
  duplicated; keep `@never` for pure reference fields.
- Known limit: `@reverse` does not resolve on **embedded** children even when
  named in the subframe; a multi-`@id` frame returns each match top-level and
  does resolve them (see item 6).
- Acceptance: `shape-tree` read has no `jsonld.expand`; reference and
  description tests unchanged.

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

### 8. Base IRI: thread `base` through framing and expansion

`frameDoc` calls `jsonld.frame` without `base`/`compactToRelative`, so a
document using document-relative `@id`s never matches the absolute frame `@id`
(verified). `putJsonLd` expands without a base, so relative IRIs are stored
relative and re-based by the server.

- `frameDoc(doc, context, iri)` → options `{ documentLoader, base: iri,
  compactToRelative: false }`.
- `putJsonLd(iri, …)` → `expandedJsonLd(doc, iri)`.
- `expandJsonLd`/`expandedJsonLd` gain an optional `base` (like
  `parseJsonld`/`toNQuads`/`toStore` already have).
- Acceptance: a document with `@id: '#me'` frames against the resource IRI and
  yields absolute ids; PUT bodies contain absolute IRIs.

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

- `packages/data-model` depends on `jsonld` but never imports it (all via
  `interop-utils`) — drop the dependency.
- `ShapeTreeReference.viaPredicate` is an RDFJS `NamedNode`; make it a string
  and drop `n3`/`@rdfjs/types` from the package.
- Code comments reference `docs/jsonld.md` (TODO 2/4/6), which does not exist.
  Restore it or point at `openwiki/data-model/json-ld-layer.md`.


### 11. Apply the grant simplification to the other models

> **Status:** landed for the data-model readers (typed `Framed*` + `projectNode`).
> Remaining: `shape-tree.ts` reference/description extraction and the
> authorization-agent activity decode.

The grant read path is now the template:

- declare the framed shape (`Framed*`) once per model instead of
  `Record<string, unknown>` + per-field casts;
- spread the framed object, default only the set-container fields;
- keep a mapper only for derived values that are not on the wire
  (`deriveFields`) and for policy/POJO convenience fields (`toOdrlPolicy`).

Remaining targets:

- `ShapeTree` — nested-frame `references` (`@embed: '@once'`), then
  `referencePairs`/`expandedNodes` go; `getDescription` scans become frames;
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
| `@explicit: true` | output restricted to frame-listed properties |
| `@explicit` + `@container: '@language'` | field dropped; `{}`/`[]` throw; `{'@embed':'@never'}` → `null` under the full IRI |
| `@default: []` | yields `[]` when absent |
| `@default` + `@omitDefault: true` | `@default` ignored, property omitted |
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
2. Item 2 (frame defaults) — removes fallbacks used by items 3–6.
3. Item 8 (base) — correctness, independent.
4. Item 4 (nested framing) — deletes code, no POJO change.
5. Item 3 (`@explicit` + `*_TERMS`) — deletes `selectNode` where possible.
6. Item 5 (representation) — POJO contract change. — **landed**
7. Item 6 (activity decode) — authorization-agent side.
8. Items 7, 9, 10 — cleanup / follow-up, can land independently.

## Out of scope

- Replacing `documentValues` with `@graph` frames (verified unreliable).
- Global `@vocab`.
- Changing the wire vocabulary or the frozen grant/access-claim shapes.
