# Data model — JSON-LD / framing plan

> **Status:** proposal, not implemented. A review of `packages/data-model` and
> the JSON-LD helpers in `packages/utils`, with behaviour verified against the
> installed `jsonld@9.0.0` (framing, compaction and expansion probes).
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

- context composition is a flat merge that loses to **type-scoped contexts**
  from the bundled LWS context (a read-shape bug);
- framing is used as "return one node", not as a schema — one kitchen-sink
  context, `@embed: '@never'` everywhere, `@default` in one model only, and a
  large manual normalization layer (`selectNode`, `resolveIri`,
  `referencePairs`, `documentValues`, `asArray`, `canonicalType`) that
  re-implements what JSON-LD 1.1 specifies.

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
`grant.ts` compensates with `asArray`/`resolveIri`.

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
carries a fallback (`access-request.ts` group default, `grant.ts` `asArray`).

- Merge instead: `{ ...base, ...overrides[key] }`.
- Derive `{ '@default': [] }` for terms whose context definition has
  `@container: '@set'`; keep `{ '@omitDefault': true }` for the rest.
- `@default` is ignored when `@omitDefault: true` is also present — set exactly
  one per term.
- Acceptance: no `?? []` / `asArray` needed for declared set terms; no `null`
  values in framed nodes.

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

`grant.ts` `resolveIri` re-implements prefix/term expansion because the frame
yields a mix of bare terms (`AccessGrant`), compact IRIs
(`interop:AllFromRegistry`, from `@type: @id`) and vocab tokens (`read`, from
`@type: @vocab`).

- Prefer tokens in POJOs: make enum terms vocab-coerced
  (`required`/`accessNecessity`, `scopeOfGrant`, `scopeOfAuthorization`,
  `accessMode`) and keep action terms as they are.
- Then delete `resolveIri` and the `PREFIX_IRI` table; update comparisons
  (`access-need.ts` `required`, access-mode consumers) and tests.
- Bare terms such as `AllFromRegistry` are inert for `@type: @id` compaction —
  IRI compaction only uses `@vocab`/prefix terms.
- Acceptance: `Grant.fromJsonLd` output uses one representation only; no
  `resolveIri`; grant/access-claim tests updated.

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

1. Item 1 (bug) + regression test.
2. Item 2 (frame defaults) — removes fallbacks used by items 3–6.
3. Item 8 (base) — correctness, independent.
4. Item 4 (nested framing) — deletes code, no POJO change.
5. Item 3 (`@explicit` + `*_TERMS`) — deletes `selectNode` where possible.
6. Item 5 (representation) — POJO contract change; do together with tests.
7. Item 6 (activity decode) — authorization-agent side.
8. Items 7, 9, 10 — cleanup / follow-up, can land independently.

## Out of scope

- Replacing `documentValues` with `@graph` frames (verified unreliable).
- Global `@vocab`.
- Changing the wire vocabulary or the frozen grant/access-claim shapes.
