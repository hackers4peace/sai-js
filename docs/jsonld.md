# JSON-LD layer — framing, contexts and writes

> **Status:** current behaviour plus the context decisions taken while closing
> the data-model plan. **Last reviewed:** 2026-11-27.
> Scope: the JSON-LD helpers in `packages/utils/src/jsonld.ts` /
> `jsonld-parser.ts`, the bundled wire contexts in
> `packages/utils/src/*-context.ts`, and the model-facing contexts and term
> lists in `packages/data-model/src/context.ts` and the `*_TERMS` constants.
> Behaviour tagged *verified* was measured against the installed `jsonld@9.0.0`
> (framing, compaction and expansion probes); everything else describes code.

## 1. Pipeline

**Reads.** `fetchJsonLd` fetches `application/ld+json` and returns the
document **expanded**, with `base = response.url` (the final URL after
redirects) and `assertAbsoluteIris` applied. Every reader then frames that
expanded document — `frameNode`/`frameDoc` (`jsonld.frame`) — and projects the
framed node with `projectNode`. No reader expands or walks the document itself
except the deliberate `documentValues` document-wide lookup.

**Writes.** A builder hands a POJO to `withContext`, `expandedJsonLd` expands
it once and `putJsonLd`/`createResource` PUT the **expanded** body. The
`@context` never reaches the wire; a storage only ever sees expanded JSON-LD.

**Base IRIs.**

- `fetchJsonLd` is the only place a base is *derived* (from a response). It
  throws when the response has no `url` — a test double must model the final
  URL — and `assertAbsoluteIris` rejects anything that stays relative (e.g. a
  document declaring `"@base": null`, which suppresses resolution even with a
  base supplied — verified).
- `frameDoc` passes `compactToRelative: false`; with a base, compaction would
  otherwise emit relative references (`https://…/y` → `"y"` — verified).
- Write payloads carry no base and assert absolute IRIs
  (`relative IRI #fragment in write payload`).
- `documentValues` (second argument), `findNodeIdByType`, `toStore` and
  `toNQuads` still take a base for *expanding / converting input that is not
  pre-expanded*. They never create relative IRIs; only `fetchJsonLd` derives a
  base from a response.

## 2. Contexts

| context | module | used by |
| --- | --- | --- |
| `dataModelContext` | `packages/data-model/src/context.ts` | every data-model read/write except grants, ACRs and data instances (82 keys / 78 terms) |
| `accessContext` = `odrlAccessContext` (aliases `grantContext`, `lwsGrantContext`) | `packages/utils/src/odrl-id-jag-context.ts` | grants (read + write), the ID-JAG `access` claim, and the `CONTEXT`/`CONTEXT_IRI` term maps derived from it (`packages/utils/src/terms.ts`) |
| `acrContext` | `packages/data-model/src/context.ts` | ACR builders and `rewriteFullAdminAccess` |
| `dataInstanceContext(shapeTree)` | `packages/data-model/src/data-instance.ts` | one data-instance document, per shape tree |
| bundled wire contexts (`lwsV1Context`, `odrlContext`, `saiContext`, `odrlIdJagContext`, OIDC) | `packages/utils/src/*-context.ts` | resolved by URL through `localDocumentLoader`; never fetched |

**`accessContext`** is `{...lwsV1Context, ...odrlContext, ...saiContext,
...accessClaimTerms}` — a spread composition, so later sources win silently.
The composed definitions that matter:

- `type` and `access` are `@container: '@set'` at the top level **and** inside
  the bundled LWS `AccessGrant`/`AccessRequest` scoped contexts. Without the
  scoped containers a grant frames with a scalar `type` and an object `access`
  (type-scoped contexts shadow the top level; `@propagate: false` does not
  prevent that — verified).
- `action`, `profile`, `scopeOfGrant` are `@type: '@vocab'` (bare tokens);
  `assigner`, `assignee`, `uid`, `source`, `owner`, `storage`,
  `registeredShapeTree`, `hasDataRegistration` are `@type: '@id'`;
  `permission`, `access`, `source`, `action` are always arrays.
- `uid` maps to `odrl:uid` and is **distinct** from the node `id`; claim-derived
  policies may lack it, which is why the grant writer fills `uid ?? id`.
- `target` carries no coercion: the ODRL target is an embedded node, and a
  scoped context there maps its `value` to `lws:value`.

**`dataModelContext`** is the data-model dictionary: interop/SAI terms, LWS
containment, shapetrees, SKOS labels, SOLID/OIDC, NFO, ActivityStreams and the
activity class terms. It is a superset of every data-model model's needs
(extra definitions are inert for expansion and, with `@explicit`, for frames).

**`dataInstanceContext`** is the documented special case: the shape tree
supplies the predicates, so the context is built per instance from the tree and
"owns" no fixed label term (see §6.6).

## 3. Read path: the frame is the schema

A model declares its wire terms once (`*_TERMS`) and frames with
`frameNode(doc, context, id, { terms })`; `frameFor` then builds

```
{ '@context': context, '@id': id, '@explicit': true, <term>: entry … }
```

`@explicit: true` restricts the framed output to the listed terms — foreign
predicates never reach the POJO, and `projectNode` becomes a type assertion
rather than a filter. Absent set-container terms still frame as `[]`; absent
`@reverse`/`@vocab` set terms are omitted by the algorithm, so `frameNode`
fills `[]` for every declared set term of the frame's list. There is no
`@default` anywhere: `@container: '@set'` already guarantees the array, and
`@default: []` is silently ignored for `@reverse`/`@vocab` terms.

Frame entries default to `{ '@embed': '@never' }` for node references and add
`{ '@omitDefault': true }` for everything that is not a forward set term;
per-call overrides **merge** (a `{ '@embed': '@always' }` override does not
lose `@omitDefault`). Consequences:

- a nested subframe's property list is a **match requirement**: a child without
  any listed term does not match, and the parent property frames as `null`
  (`access-request.ts` relies on this: a group without needs throws instead of
  producing an empty group);
- a nested restatement of a reference as `{ '@embed': '@once' }` keeps a
  dangling reference as an id-only node instead of dropping it;
- embedded children are **not** restricted by `@explicit` — a child keeps all
  of its properties (this is why activity snapshots can carry fields that are
  not in the activity's own term list).

Models without a `terms` list use `buildFrame`, which frames every non-keyword
entry of the context. Seven read models do this because their label is a
language map (§4): `Role`, `WebIdProfile`, `SocialAgentRegistration`,
`SocialAgentInvitation` and the three description models. Data instances are a
separate special case (§6.6).

**Selector frames.** `frameMatches(doc, context, patterns)` frames *without*
an `@id`, so the patterns select nodes (`@explicit` keeps the output narrow).
Verified constraints for selectors: `@requireAll: true` on a multi-property
selector does **not** restrict the match (nodes matching any pattern are
returned, non-matching properties `null`), and a `@graph` pattern inside a
frame is a single object that does not filter. Use absolute-IRI keys in
patterns where the context has no term — an IRI-keyed frame entry works with no
term definition (verified).

## 4. Language values

`label`/`definition` are SKOS `@container: '@language'` language maps; the
untagged value lands under `@none`, translations under their tags. `pickLanguage`
is the single selection helper (preferred tag → `@none` → first value).

**Framing cannot select a language.** This is a property of the Framing
algorithm, not a gap in our code:

- §4.2.3/§4.2.4 of the Framing spec only use `@language` inside *value
  patterns*, which decide whether a node matches; the recursive algorithm
  copies literal values verbatim. Matching is unordered set membership — there
  is no "preferred language" (or fallback) concept.
- `@container: '@language'` cannot appear in a frame at all: jsonld@9 throws
  while compacting the map (`reading '@value'` of undefined). `buildFrame`
  therefore *skips* language-map terms and `frameFor` refuses them.
- jsonld@9 does filter literal values by a value pattern, but only
  `subframe[0]` is consulted (`frame.js` `_valueMatch(subframe[0], o)`), and
  `@value` must be present as a wildcard `{}` or the frame expansion throws.
  `@language: []` (the spec's "match none" for untagged values) fails frame
  expansion (`invalid language-tagged string`), so "en, else untagged" is not
  expressible. A language *list* (`['en','de']`) filters to those languages and
  drops untagged values.
- Putting `@language` on a term (`label: { '@id': skos:prefLabel,
  '@language': 'en' }`) makes matching values compact to plain strings but
  moves every other language to the **raw IRI key** — a silent property rename
  that `projectNode` would drop (verified).

Consequence: keep the maps and pick at the consumer (or in the model), never in
the frame. The container is a compaction/expansion convenience, not a wire
fact: a document is expanded with its *own* context, so our read path is
unaffected by whether our context carries the container.

If a language-map model ever needs `@explicit`, the recipe is a derived **frame
context** that strips the container for the label term, and a one-line
conversion in the model:

```ts
const framed = await frameNode(doc, frameContext, id, { terms: ['label', 'members'] })
// label: ['R', { '@language': 'en', '@value': 'Reviewers' }]
label: toLanguageMap(framed.label)   // { '@none': 'R', en: 'Reviewers' }
```

Writes keep the container (a `LanguageMap` expands to tagged literals), so only
the frame context differs. Verified in both directions.

## 5. Write paths

- `withContext(context, node)` inlines a context object; `expandedJsonLd`
  expands once and `assertAbsoluteIris` guards it. A key the context does not
  define is **silently dropped** by expansion (`"@vocab"` is deliberately not
  set), so a write payload must be the wire shape, not a read POJO.
- `GrantData` is the wire shape and `toJsonLd` (`packages/data-model/src/grant.ts`)
  is a per-level `pick` of wire terms plus two normalizations a builder may not
  have applied: the `AccessGrant` envelope class and `uid ?? id` at policy,
  permission and target level. See `docs/grants.md` §1/§3.
- The counter-example this taught: `DataRegistrationData` is a **read** model
  (`contains` merges `ldp:contains` with `lws:contains`, `partOf` is lifted
  from `lws:partOf`). `createDataRegistration` writes it verbatim, so `partOf`
  vanishes (no term) and storage containment is re-written as `ldp:contains`.
  The fix is an explicit wire pick, not a wider context.
- Guard worth adding: assert that every top-level key of a write payload maps
  to a predicate in the expanded output (the mapping is available from
  `contextIndex`). That closes the whole "silently dropped key" class for every
  writer at once.

## 6. Context rules and decisions

### 6.1 One definition per term

A term has exactly one definition; identical redefinition is allowed
(verified), a different one is a bug. The exported contexts currently share
eight IRIs: `Storage`, `dataOwner`, `NeedBasedAccessRequest`, `scopeOfGrant`,
`scopeOfAdminGrant`, `inheritsFromGrant`, `inheritsFromNeed`,
`hasInheritingGrant`. Only `scopeOfGrant`/`scopeOfAdminGrant` genuinely differ
(`@id` in `dataModelContext` vs `@vocab` in the access context), and `Storage`
differs in shape (a class with a type-scoped context in LWS, a bare class term
in SAI; no model reads it). All three are **dead weight** in `dataModelContext`:
`scopeOfGrant` is read only by `grant.ts` (the `@vocab` family),
`scopeOfAdminGrant` has no users, and `Storage` is never used as a term. Dropping
them from the data-model dictionary makes the duplicate-definition check
passable without touching the published SAI wire context.

### 6.2 `@protected`

Protection is narrower than it looks (all verified):

- it throws only when an **applied type-scoped context** redefines a protected
  term differently (`Invalid JSON-LD syntax; tried to redefine a protected
  term`); identical redefinition is allowed;
- it does **not** fire for a JS-level merge (`{...ctx}` then assigning the
  term), regardless of whether the object carries `@protected`;
- it does **not** fire when a term imported via `@import` is overridden in the
  importing context.

So `@protected` catches the item-1 failure mode (a wire document's type scope
shadowing a composed term) and nothing else. Cross-context drift needs the
duplicate-definition test.

### 6.3 `@import`

- an imported context document must **not** contain `@import`
  (`Invalid JSON-LD syntax: imported context must not include @import`);
- an **array** of `@import`s works, so several bundles can be composed per
  document;
- overriding an imported term from the importing context is silently accepted
  (see §6.2).

Composition by `@import` therefore buys the local-loader path and a single
source per bundle, not conflict detection.

### 6.4 Type-scoped contexts

Used where the wire defines them (LWS `AccessGrant`/`AccessRequest`) and where
a composed term must survive on a typed node (item 1). Keep them **additive**:
a scope that narrows the term set breaks any node whose class is absent or
unexpected — `ClientIdDocument` frames as `type: []`, data instances are
untyped by design, and activity `as:object` snapshots are embedded nodes.

### 6.5 Global context: object vs URL

`localDocumentLoader` maps context URLs to bundled documents and **falls back
to `fetch`** for unknown URLs, so a URL typo silently hits the network. A URL
`@context` works in `jsonld.frame`/`expand` (verified, including `@protected`
enforcement through the loader), and the framed output then carries the URL
(`toFramedNode` strips it). But frame construction must stay synchronous:
`buildFrame`/`frameFor`/`withSetDefaults`/`contextTerms` iterate the term map,
so the object must exist in-process regardless. Registering the **same object**
under a versioned URL (`localContexts[url] = { '@context': dataModelContext }`)
gives document-level references without a second copy; a URL-only world is not
possible. Since writes are expanded, the URL never reaches the wire today.

### 6.6 Data instances (special case)

The shape tree supplies the label predicate (`st:describesInstance`) and the
child-link predicates (`viaPredicate`), so the instance context is built from
the tree. The label predicate stays an **IRI key** — no `label`/`instanceLabel`
term is mapped to it — and an absolute-IRI frame key needs no definition
(verified). The child links do need terms for `@type: '@id'` +
`@container: '@set'` coercion. Never mutate a shared context per instance.

### 6.7 Per-model frames vs per-model contexts (open item)

One global dictionary plus a per-model frame is the current architecture and
covers 12 of ~20 read models (11 in `packages/data-model` plus the activity
decode). The rest are the seven language-map models (§4) plus
data instances. The remaining options, in increasing churn:

1. **Global dictionary + per-model frames** (extend the `terms` list to the
   seven language-map models with a container-stripped frame context, §4).
   POJOs and the 16 `pickLanguage` call sites stay unchanged; the union's
   `withSetDefaults` noise (`contains`, `references`, `accessMode`, …)
   disappears per model.
2. **Per-model contexts** — the same declaration plus definitions
   (`pickTerms`/`modelContext`). Adds closure ("this model cannot reference
   another model's term") but no capability over (1); the write paths need an
   audit, because a narrowed context makes an unlisted write key expand to
   nothing.
3. **URL + loader registration** — orthogonal to 1/2, see §6.5.

Frames constrain **reads only**. Whatever is chosen, writes stay
global-context + explicit wire picks (or the dropped-key assertion, §5).

## 7. Verified `jsonld@9.0.0` constraints

| Feature | Behaviour |
| --- | --- |
| `@explicit: true` | output restricted to frame-listed properties; `@type` is kept without listing it |
| `@explicit` + nested `{ '@embed': '@always' }` subframe | the embedded child keeps all its properties — the flag does not restrict embedded nodes |
| `@requireAll: true` on a selector with several property patterns | does **not** restrict the match: nodes matching any pattern are returned, non-matching properties are `null` |
| nested reference subframe with property patterns | a dangling reference matches nothing and is dropped silently; a bare `{ '@embed': '@once' }` keeps it as an id-only node |
| `@explicit` + `@container: '@language'` | throws (`reading '@value'` of undefined) |
| `@container: '@language'` term in any frame | throws in compaction |
| `@explicit` + absent forward `@set` term | `[]` (same as without `@explicit`) |
| `@explicit` + absent `@reverse`/`@vocab` set term | omitted — `frameNode` must fill `[]` |
| `@default: []` | yields `[]` when absent (forward set terms only) |
| `@default` + `@omitDefault: true` | `@default` ignored, property omitted |
| set container + no `@omitDefault` | `[]` for forward `@set` terms (`@type: '@id'`, literals) |
| set container on `@reverse` / `@vocab` term, no `@omitDefault` | property **omitted** — no `[]`, and `@default` cannot rescue it |
| single-valued term, no `@omitDefault` | `null` (so every non-set term keeps `@omitDefault: true`) |
| nested subframe property list | acts as a **match requirement** (`@requireAll` default false): a child without the listed term yields `null` for the parent property; nested `@default`/`@omitDefault` do not help |
| nested frame with no matchable property | the child compacts to a bare IRI **string**, not an object |
| `@explicit: true` + `@requireAll: false` + full term list | absent set term frames as `[]`, child still matches |
| expansion of a node with only `@id` | node dropped (no statements) |
| `@base: null` + `base` option | relative IRIs survive expansion (no error) → caught by `assertAbsoluteIris` |
| `frame` with `base`, default options | compacts IRIs to relative references (why `compactToRelative: false` is mandatory) |
| `@embed: '@once'` | dedupes repeated references |
| `@embed: '@always'` on a nested node | frames the child with terms; `@reverse` does not resolve inside it |
| multi-`@id` frame | returns `@graph`, each match top-level, `@reverse` resolves per node |
| `@graph` in a frame | must be a single object; property patterns do not filter — not a reliable selector |
| absolute-IRI property key in a frame | works with no term definition; output key is the IRI |
| `@type: '@vocab'` | bare tokens (`AccessRequired`) |
| `@type: '@id'` | IRI/compact-IRI only (`interop:AllFromRegistry`), never a value term |
| type-scoped context | shadows top-level terms for typed nodes; `@propagate: false` does not prevent node-level shadowing |
| `@protected` | redefinition throws **only when the type scope is applied** (identical redefinition allowed); JS merges and `@import` overrides are silent |
| `@import` | resolved through the bundled `documentLoader`; the imported document must not contain `@import`; an array of imports works; imported terms may be overridden silently |
| `jsonld.frame` without `base` | relative `@id`s never match an absolute frame `@id` |
| `base` + `compactToRelative: false` | absolute ids in framed output |
| value pattern, one object | filters literal values to the pattern's languages; `@value` must be a wildcard `{}` or expansion throws |
| value pattern, several objects | only the **first** is consulted (matching and filtering) — no union |
| `@language: []` in a value pattern | frame expansion throws `invalid language-tagged string` — untagged values cannot be selected |
| term `@language: 'en'` in the frame context | en values compact to plain strings; other languages move to the raw-IRI key (silent rename) |
| URL `@context` + `documentLoader` | works in `frame`/`expand`; `@protected` is enforced through the loader; framed output carries the URL |
| `@context` with `@import` + local term | local definition wins silently (no protection error) |

## 8. Open items

1. **Frames for the seven language-map models** — container-stripped frame
   context + `toLanguageMap` (§4). No POJO or consumer change.
2. **Duplicate-definition test** — walk every exported/bundled context and the
   per-model contexts; fail on the same term defined differently, allow
   identical redefinitions and distinct term names for the same IRI. Pending
   the `scopeOfGrant`/`scopeOfAdminGrant` cleanup (§6.1).
3. **`@protected` rollout** — add it to `dataModelContext`/`accessContext`
   once data instances no longer mutate `label` (§6.2, §6.6).
4. **Dropped write keys** — assert expansion produced a predicate for every
   payload key (§5).
5. **Global context object vs URL** — register the same object under a
   versioned URL if documents should reference it; keep the object for frames
   (§6.5).
6. **`@import` composition** — replaces the spreads only if each family gets a
   single merged bundle (no chained imports); it does not detect conflicts.

## 9. Where tested

- `packages/utils/test/jsonld.test.ts` — `frameFor`/`buildFrame`, set defaults,
  `projectNode`, language maps, `frameMatches`.
- `packages/utils/test/jsonld-parser.test.ts` — the bundled loader.
- `packages/data-model/test/framing/schema.test.ts` — framed keys are exactly
  `id`, `type` + the model's terms; no raw-IRI key survives.
- `packages/data-model/test/framing/regressions.test.ts` — type-scoped context
  containers, grant/access-request framing.
- `packages/data-model/test/acr.test.ts`, `test/framing/registry-set.test.ts` —
  ACR builders, template isomorphism.
- `packages/authorization-agent/test/activity-registry.test.ts` — the
  single-frame activity decode and preserved types.

Related: `docs/grants.md` (grant wire shape, read model, claims), `docs/odrl.md`
(ODRL alignment), `openwiki/data-model/json-ld-layer.md` (narrative overview;
may lag `selectNode`/frame details — this file and the source are authoritative).
