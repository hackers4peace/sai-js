# Reconsider the `n3` package — keep vs drop

> **Status:** 📋 decision needed / not started. This is the remaining **phase 7**
> of the completed Turtle-removal work, now tracked on its own. The former
> drop-n3-dependency work is folded in here. The completed Turtle-removal plan
> is removed; its landed design is in the OpenWiki
> (`data-model/json-ld-layer.md`, `services/activity-lifecycle.md`, and
> `data-model/entities.md`).

## Why this is a reconsideration

Phases 0–6 of the Turtle removal landed: `parseTurtle`/`serializeTurtle` are
gone, SPARQL patches are JSON-LD → N-Quads, ACRs are JSON-LD, `/sparql-admin`
CONSTRUCT returns JSON-LD, and notifications are NDJSON JSON-LD. The original
phase 7 goal was to remove `n3` from every manifest. Before doing that, decide
whether it is worth it:

- `n3` is still used for **RDF/JS `Store`/`DataFactory`** in a handful of
  modules — a mechanical swap to `@rdfjs/dataset`/`@rdfjs/data-model`.
- Two sites need a **parser/writer**, not just a store: the reciprocal-mirror
  N-Quads → `GRAPH`-block conversion, and the test/seed TriG splitter. `n3` is
  the only TriG/N-Quads implementation already in the tree.
- `fetch-sparql-endpoint` uses `n3` internally, so a full manifest removal does
  **not** remove `n3` from `node_modules`; it only removes our direct deps.
- `@rdfjs/dataset` and `@rdfjs/data-model` are currently transitive
  (`1.1.1` / `1.3.4`); a swap adds them as direct deps.

The choice is therefore **dependency hygiene vs. churn**, not a functional
requirement.

## Current footprint (authoritative)

### Production/tooling `from 'n3'`

| Site | Uses |
| --- | --- |
| `packages/utils/src/jsonld.ts` (`toStore`) | `new Store()` |
| `packages/utils/src/jsonld-parser.ts` (`parseJsonld`) | `new Store()` |
| `packages/authorization-agent/src/sparql.ts` (`localSparqlTransport`) | `new Store()` + `addQuads` |
| `packages/authorization-agent/src/access-description-set.ts` | `DataFactory.namedNode` / `literal` |
| `packages/data-model/src/shape-tree.ts` | `DataFactory.namedNode` |
| `packages/components/src/SaiPermissionsEngine.ts` | `new Store([...data])` |
| `packages/components/src/services/ReciprocalMirror.ts` | `Parser` (N-Quads), `Writer` (N-Triples), `DataFactory`, `Quad` — converts `toNQuads` output to `GRAPH` blocks |
| `packages/test-utils/src/fuseki.ts` | `Parser` (TriG), `Writer` (TriG), `Quad` — fixture split/seed |

`packages/application/README.md` still shows an `n3` example; `application` has
no source usage.

### Test `from 'n3'`

`utils/test/{jsonld-parser,match}.test.ts`;
`authorization-agent/test/{write-paths,get-role,authorization-agent,store-data-authorizations}.test.ts`;
`components/test/grants.test.ts`;
`data-model/test/framing/helpers.ts` (TriG fixture parse);
`data-model/test/pojo/{data-grant,data-authorization}.test.ts`.

### Manifests

- `n3`: `utils`, `test-utils`, `data-model`, `components`, `authorization-agent`,
  `application`.
- `@types/n3`: `utils`, `test-utils`, `data-model`, `authorization-agent`,
  `application` (not `components`).
- `@rdfjs/types` stays (types only).

## Options

### A. Keep `n3`, drop only the dead manifest

Remove `n3`/`@types/n3` from `application` (no usage), update the README
example. Keep `n3` elsewhere, documented as the tree's RDF/JS + TriG/N-Quads
implementation. Lowest churn; `n3` remains transitively via
`fetch-sparql-endpoint` anyway.

### B. Partial drop (recommended default)

Do the mechanical runtime swaps:

- `utils`, `authorization-agent`, `data-model`, and `SaiPermissionsEngine`:
  `Store` → `@rdfjs/dataset`, `DataFactory` → `@rdfjs/data-model`; migrate the
  unit tests.
- Drop `n3`/`@types/n3` from those packages and from `application`.
- **Keep `n3`** in `components` (only `ReciprocalMirror`) and `test-utils`
  (TriG split/seed) unless/until a replacement parser/writer is chosen; keep the
  TriG test fixture on `n3` as a dev dependency.

This removes most direct deps without inventing an N-Quads/TriG implementation.

### C. Full drop

Everything in B plus:

- Replace `ReciprocalMirror`'s N-Quads parser/N-Triples writer/GRAPH-block
  formatter. Candidate approaches: a small local N-Quads line splitter +
  `@rdfjs/data-model` + a local N-Triples writer; `jsonld.toRDF` returning
  RDF/JS quads and a serializer; or a different RDF/JS parser package.
- Resolve the TriG fixture in `data-model/test/framing/helpers.ts` (convert the
  fixture to JSON-LD, or move the TriG parse behind a test-only dependency).
- Replace the `test-utils` TriG writer/parser (seed splitter) with a
  non-`n3` serializer/parser or a test-only dependency.
- Remove `n3`/`@types/n3` from every manifest and gate on
  `rg "from 'n3'" packages --glob '!**/node_modules/**' --glob '!**/dist/**'`.

## Recommendation

Take **B** first: it is mechanical, removes the direct dependency from the
runtime packages where `n3` is only a store/factory, and leaves the two
parser/writer sites explicit. Revisit **C** only if direct-dependency purity is
a goal; note that `fetch-sparql-endpoint` keeps `n3` in the tree regardless.
If **C** is chosen, prototype the `ReciprocalMirror` N-Quads → `GRAPH` block
replacement before touching manifests — it is the only production parser use.

## Steps (B)

1. **`application`** — remove `n3`/`@types/n3`; update the README example.
2. **`utils`** — `toStore`/`parseJsonld` use `dataset()` from
   `@rdfjs/dataset` (keep the `DatasetCore` return type); migrate the two tests;
   declare `@rdfjs/dataset`; drop `n3`/`@types/n3`.
3. **`authorization-agent`** — `localSparqlTransport` collects quads into
   `dataset()` (or a quad array where only `jsonld.fromRDF` follows);
   `access-description-set` uses `@rdfjs/data-model`; migrate the four tests;
   drop `n3`/`@types/n3`.
4. **`data-model`** — `shape-tree` uses `@rdfjs/data-model`; keep the TriG
   fixture on `n3` as a dev dependency (B) or convert it (C); migrate the two
   POJO tests and `framing/helpers.ts` imports; drop `n3`/`@types/n3` from
   runtime deps.
5. **`components`** — `SaiPermissionsEngine` uses `dataset(data)`; migrate
   `components/test/grants.test.ts`; `ReciprocalMirror` remains on `n3` in B
   (document the exception) or is replaced in C.
6. **`test-utils`** — keep `n3` for the TriG splitter/writer in B (dev/test
   tooling) or replace it in C.
7. **Grep/build gate** — `rg "from 'n3'"` should show only the documented
   exceptions (B) or nothing (C); `npm run build` + `npm test` green; final
   dagger `test/` suite as the end-to-end guard.

## Verification

- Per step: `npm run build` (turbo) + `npm test` (turbo, packages) green.
- Behavior parity: `@rdfjs/dataset`/`@rdfjs/data-model` must not change produced
  triples; existing JSON-LD framing, match, permissions-engine, and SPARQL
  transport tests are the guard.
- Final full drop (C): dagger `test/` suite with no `n3` in manifests.

## Open questions

1. **`ReciprocalMirror` N-Quads → `GRAPH` blocks** — local formatter vs a new
   RDF/JS parser/writer; prototype first.
2. **TriG fixture** (`data-model/test/framing/helpers.ts` and
   `test-utils/src/fuseki.ts`) — keep `n3` as a test/tooling dependency or
   convert the fixture/serializer.
3. **`@rdfjs/dataset` v1 vs v3** — the tree has `1.1.1`; confirm `dataset()`
   and `DatasetCore` behavior before pinning.
4. **`toStore`/`parseJsonld` shape** — keep `DatasetCore` initially; narrowing
   to document-only is a separate change.

## References

- Completed Turtle-removal design in the OpenWiki:
  `data-model/json-ld-layer.md`, `services/activity-lifecycle.md`,
  `data-model/entities.md`, `services/org-context.md`.
- `fetch-sparql-endpoint` uses `n3` internally — its dependency does not keep
  `n3` in our manifests.
