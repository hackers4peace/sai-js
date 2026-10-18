---
type: data-model
title: JSON-LD read/write layer
description: The JSON-LD-first transport shared by the data-model and authorization-agent packages — framing-not-compacting, the selectNode whitelist, the loader factory, the read and write paths, the activity-registry class-gated decode, embedding semantics, manual helpers, and the self-graph SPARQL scoping hygiene.
tags: [json-ld, transport, framing, typescript, solid, sparql]
sources:
  - id: openwiki-source-82daddf07d8ad3efedbe52d2
    resource: repo://packages/authorization-agent/src/activity-registry.ts
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-5f3a5827ade0bebc11f29499
    resource: repo://packages/data-model/src/context.ts
  - id: openwiki-source-82fe23672fc8cac2a228f590
    resource: repo://packages/utils/src/container.ts
  - id: openwiki-source-d900b4364e5e03dbadc6c83e
    resource: repo://packages/utils/src/jsonld.ts
  - id: openwiki-source-ffa35cc9379c0d10f59dfee0
    resource: repo://packages/utils/src/notifications.ts
  - id: openwiki-source-5fb2d11486c54acb71821300
    resource: repo://packages/utils/src/sparql-update.ts
  - id: openwiki-source-228968b8fb4f70750899249e
    resource: repo://packages/utils/src/whatwg-fetch.ts
generated: { by: "pi", at: "2026-10-18T21:45:34.463Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-18T21:45:34.463Z
---

# JSON-LD read/write layer

The entity POJOs (see [Data model entities](entities.md)) are carried to and
from the Solid servers through a JSON-LD transport in `packages/utils`. Quad
machinery now survives only at the SPARQL boundary: JSON-LD documents are
serialized to N-Quads for `INSERT/DELETE DATA`, and CONSTRUCT results are
converted back with `jsonld.fromRDF`. There is no Turtle parse/serialize layer.

## Core helpers (`packages/utils/src/jsonld.ts`)

- `fetchJsonLd(iri, fetch)` — a raw GET with `Accept: application/ld+json`,
  returning `response.json()` and throwing on a non-OK response.
- `putJsonLd(iri, fetch, doc, headers?)` — expands the doc via
  `expandedJsonLd` (a context-stripping `jsonld.expand`), JSON-stringifies it,
  and PUTs with `Content-Type: application/ld+json`. The expanded form means
  the wire body never carries a client `@context`.
- `frameDoc(doc, context, iri, overrides?)` — frames one node with
  `jsonld.frame(buildFrame(...))` (default `@embed: '@never'` /
  `@omitDefault: true`) and throws if the node is absent. `frameNode` is its
  typed front, and `frameDataset` wraps `jsonld.fromRDF`.
- `linkedIrisJsonLd(id, fetch, propertyIri)` — builds a per-call
  `@type:@id`/`@set` context, frames a fetched document, and returns
  `node[propertyIri] ?? []`.
- `withContext(context, node)` — attaches the `@context` to a POJO for the
  `toJsonLd` write path.
- `toNQuads(doc, base?)` — serializes a JSON-LD document to N-Quads via
  `jsonld.toRDF`. A default-graph document yields N-Triples (valid Turtle data
  for `INSERT DATA`); a `{ '@id': graph, '@graph': doc }` wrapper yields
  N-Quads with the graph label in the fourth term.

## Framing invariants

The shared `dataModelContext` aliases `id` to `@id` and maps `@type` to a
`@set` container, so `type` is always a `string[]` on reads and on expanded
writes. Reads use **framing, not compacting** — compaction cannot filter to one
node in a multi-node document, resolve `@reverse`, or omit absent keys.
`buildFrame` gives every property `@embed: '@never'` / `@omitDefault: true`, so
node refs stay plain-IRI references and `@reverse` children resolve on the
top-level matched node.

## Selection and loaders

Framing emits **every** property of the focus node, so frame entries govern
embedding/omission but not inclusion. The per-model whitelist is
`selectNode(node, terms)`: `id`/`type` plus exactly the model's terms, present
values only, with **no defaults** (absent means `undefined`; empty `@set`
arrays round-trip as absent and consumers coalesce with `?? []`).
Language-tagged literals compact to `{ '@value', '@language' }`, read through
the `opt(node, key)` unwrapper.

There are no `loadX` exports; consumers compose the generic
`loader(fromJsonLd)` factory at module top, which infers `T` from the reader's
return type and threads `fetchJsonLd` through it.

## Activity decode (class-gated framing)

`frameActivity` (`packages/authorization-agent/src/activity-registry.ts`)
sniffs the raw doc's `@type` and picks a frame per class:

- `AuthorizationGranted` — **two-phase**: the default frame makes `as:object`
  plain-IRI strings; a second frame re-frames the same doc once per object id
  via `DataAuthorizationFromJsonLd`, giving each embedded object a uniform
  top-level read (so `@reverse` children resolve) without dereferencing.
- Need-based classes — the **deep** frame embeds the complete
  access-need group (`@embed: '@always'`) so the approval workflow resolves
  inherited children from the activity graph.
- Everything else — the wildcard `{ '@embed': '@always' }` on `object`:
  snapshot objects embed from the same document; a live-link object stays a
  plain-IRI string.

## Embedding semantics

- Single values collapse to scalars/objects unless the term has
  `@container: '@set'` (`type` is solved; `object` is not — mappers wrap with
  a scalar-or-array helper).
- `@reverse` resolves only on the top-level matched node, not on wildcard-
  embedded nodes.
- `@type` is an **unordered set** — class discrimination is by set membership,
  never tuple position.
- IRI-valued terms are coerced (`@type: '@id'`), so `client_id`-style values
  are always IRIs; a literal under a coerced term is a document defect.

## Manual helpers

- `documentValues(doc, iri, predicate)` — collects a predicate's values across
  **all** nodes of a document (frames only reach other nodes via a known path).
- `findNodeIdByType(doc, typeIri, base)` — first node of a type via a wildcard
  `{ '@type' }` frame.

## Container creation

`createContainer(id, fetch, doc)` PUTs an empty container first (CSS ignores
the body), then `applyPatch`es the **JSON-LD document** serialized as
`INSERT DATA { ... }` onto the discovered description resource. The
container-creating callers route through it.

## Fetch boundary

`packages/utils/src/whatwg-fetch.ts` is the single `WhatwgFetch` type. Resource
CRUD uses raw JSON-LD. The SPARQL-patch layer (`sparql-update.ts`) now takes
**JSON-LD documents** and serializes them with `toNQuads` — `insertPatch`,
`deletePatch`, `addStatement`, `removeStatement`, and `replaceStatement` no
longer accept `DatasetCore`/`Quad`. The authorization-agent `sparql.ts` still
keeps quad machinery (`N3 Store`, `graphDoc` via `jsonld.fromRDF`) to turn
transport results back into JSON-LD for the framed POJO path. `text/turtle`
survives only as an output representation (the id service `Accept` branch and
`@jeswr/pretty-turtle` there), while ACP/ACR is JSON-LD and the bootstrap seed
is TriG.

## Notification helpers

`packages/utils/src/notifications.ts` replaces the external
`@solid-notifications/*` packages. `ChannelType` names the `WebhookChannel2023`
and `WebSocketChannel2023` channel-type IRIs; `discoverSubscriptionService`
HEADs a topic for its storage description, GETs that description as JSON-LD,
and finds the `notify:channelType` match; `subscribeToNotificationChannel` POSTs
a compacted JSON-LD channel request and returns the server-assigned channel.

## SPARQL graph scoping

Every resource's document body lives in its own named graph (`GRAPH <iri>`,
name == resource IRI); `meta:` graphs hold mirror metadata. The **activity
registry is the exception**: an activity's `as:object` may embed a projection
of a real resource, putting the embedded node's `rdf:type`/properties inside
the activity's graph — one graph, two subjects. Type-matching queries across
the dataset must therefore scope to the subject's own graph
(`FILTER(?g = ?s)`) or they return embedded (non-authoritative) "phantom"
claims — e.g. `findRolesWithMember` uses `FILTER(?g = ?role)` so a
`roleMembershipChanged` projection of a to-be role (activities are immutable)
cannot keep asserting stale membership.

## Known debt

- `packages/authorization-agent/src/access-description-set.ts` is still
  quad-based (`parseJsonl` + `DatasetCore`), not yet moved to the framed POJO
  path.
- `parseJsonl` (`jsonld-parser.ts`) and `toStore` (`jsonld.ts`) overlap — both
  run `jsonld.toRDF` and copy quads into a new N3 `Store`.
- `linkedIrisJsonLd` takes a `propertyIri` and builds its own minimal context,
  but does not accept a caller-supplied context.
