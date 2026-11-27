import type { DatasetCore, Quad } from '@rdfjs/types'
import { Parser, Store } from 'n3'

import { isAuxiliaryResource } from './container.ts'
import { jsonld } from './jsonld-lib.ts'
import { localDocumentLoader } from './jsonld-parser.ts'
import { LDP, LWS } from './namespaces.ts'
import { withSpan } from './tracing/shared.ts'
import type { WhatwgFetch } from './whatwg-fetch.ts'
export { localDocumentLoader }

export type JsonLdContext = Record<string, unknown>

/** A framed document: the well-known keys plus any framed node graph. */
type FramedDocument = Record<string, unknown> & {
  '@graph'?: Array<Record<string, unknown>>
}

/**
 * `@types/jsonld` only describes the callback API, so the promise form used by
 * this package needs one explicit cast per entry point. Typing the wrappers also
 * keeps the awaited values narrow instead of `any`.
 */
export const expandJsonLd = jsonld.expand as unknown as (
  doc: unknown,
  options: Record<string, unknown>
) => Promise<Array<unknown>>

const frameJsonLd = jsonld.frame as unknown as (
  doc: unknown,
  frame: unknown,
  options: Record<string, unknown>
) => Promise<FramedDocument>

/** The IRIs in a JSON-LD `@set` container: strings only, everything else dropped. */
function irisOf(value: unknown): Array<string> {
  return Array.isArray(value) ? value.filter((iri): iri is string => typeof iri === 'string') : []
}

/**
 * Children of a container, from its `ldp:contains` (hierarchical/Solid storage)
 * and `lws:contains` (flat LWS storage) listings — the union, so the same
 * helper works for both. The container document is fetched once. Auxiliary
 * resources (`.acr`/`.acl`/`.meta`) are not members and are filtered out.
 */
export async function containedIrisJsonLd(id: string, fetch: WhatwgFetch): Promise<Array<string>> {
  const context: JsonLdContext = {
    contains: { '@id': LDP.contains, '@type': '@id', '@container': '@set' },
    lwsContains: { '@id': LWS.contains, '@type': '@id', '@container': '@set' },
  }
  const node = await frameDoc(await fetchJsonLd(id, fetch), context, id)
  return [...new Set([...irisOf(node.contains), ...irisOf(node.lwsContains)])].filter(
    (iri) => !isAuxiliaryResource(iri)
  )
}

/**
 * Document loader that resolves known remote contexts (OIDC, notifications)
 * from bundled local copies instead of fetching them over the network.
 * SAI data never needs remote contexts beyond those two.
 */
const documentLoader = localDocumentLoader as any

export { documentLoader }

/**
 * Build a JSON-LD frame that resolves the node at `iri` with all its
 * properties as plain node references (no embedding of referenced nodes).
 *
 * Each property in the context gets `@embed: "@never"` so that the
 * framing algorithm produces `@type: @id`-compacted plain IRI strings
 * instead of embedding full child graphs. This also resolves @reverse
 * relationships automatically.
 *
 * **Absent properties** (JSON-LD 1.1 Framing §2.2 "Default content"): a frame
 * property that the node does not have is emitted with `null` unless the
 * omit-default flag is set, so every non-array term gets `@omitDefault: true`
 * and is omitted instead — framed nodes never carry `null` and POJO readers
 * use `required()` for the terms the model requires.
 *
 * **Set terms** get no `@default` — `@container: '@set'` already guarantees the
 * array (`[]` when absent, verified against jsonld@9), and `@default: []` is
 * silently ignored for `@reverse` and `@type: '@vocab'` terms, which therefore
 * keep `@omitDefault: true`. `frameNode` fills those two shapes afterwards, so
 * the "declared set term is always an array" contract holds for readers.
 *
 * `overrides` merges over the computed entry for selected keys — e.g.
 * `{ object: { '@embed': '@always' } }` for activity reads, where in-document
 * snapshot nodes embed while out-of-document live-link nodes stay plain-IRI
 * strings (no dereference). Merging (not replacing) keeps the omit-default
 * behaviour, so an override on an absent property still yields no key.
 */
export function buildFrame(
  context: JsonLdContext,
  iri: string,
  overrides: Record<string, Record<string, unknown>> = {}
): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    '@context': context,
    '@id': iri,
  }
  for (const [key, val] of Object.entries(context)) {
    if (key === 'id' || key === 'type' || key.startsWith('@')) {
      continue
    }
    if (typeof val === 'object' && val !== null && !isLanguageMapTerm(val)) {
      frame[key] = {
        '@embed': '@never',
        ...(alwaysArrayTerm(val as Record<string, unknown>) ? {} : { '@omitDefault': true }),
        ...overrides[key],
      }
    }
  }
  return frame
}

/**
 * Whether an absent property is guaranteed to frame as `[]` by the set
 * container alone. Holds for forward `@set` terms; `@reverse` terms and
 * `@type: '@vocab'` terms never get a container default from the framing
 * algorithm (verified against jsonld@9 — the property is omitted instead).
 */
function alwaysArrayTerm(definition: Record<string, unknown>): boolean {
  return (
    isSetContainer(definition) &&
    definition['@reverse'] === undefined &&
    definition['@type'] !== '@vocab'
  )
}

/** Whether a term definition declares `@container: '@set'`. */
function isSetContainer(definition: unknown): boolean {
  const container = (definition as { '@container'?: string | Array<string> } | null)?.['@container']
  return Array.isArray(container) ? container.includes('@set') : container === '@set'
}

/**
 * Whether a term definition carries `@container: '@language'` — the framed
 * values of such a term compact into a language map (JSON-LD 1.1 §4.6.2), so
 * the standard `{ '@embed': '@never', '@omitDefault': true }` frame entry
 * would be parsed as the map itself (language-map values MUST be strings,
 * §9.8) and jsonld.js rejects it. Language-map terms are skipped like
 * `id`/`type`/`@version`: the map values still leak through framing and
 * compact correctly.
 */
function isLanguageMapTerm(definition: unknown): boolean {
  const container = (definition as { '@container'?: string | Array<string> } | null)?.['@container']
  return Array.isArray(container) ? container.includes('@language') : container === '@language'
}

/**
 * IRI scheme prefix (`https:`, `urn:`, `did:`, …) — the shape of every IRI the
 * package accepts in an IRI position. Blank node identifiers (`_:b0`) are the
 * one non-IRI value the expanded form may carry.
 */
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * Assert that every IRI in an expanded JSON-LD document is absolute.
 *
 * Expanded form holds every IRI position as `@id` or `@type` (node references,
 * node identifiers, datatypes), so one recursive walk covers the document. The
 * package never creates relative IRIs: reads resolve document-relative
 * references against the response URL (`fetchJsonLd`), writes carry none — so a
 * relative IRI here is either a fetched document that suppressed resolution
 * (`"@base": null`, JSON-LD 1.1 §4.1.3) or a bug in a write payload.
 */
export function assertAbsoluteIris(expanded: unknown, source: string): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (!value || typeof value !== 'object') {
      return
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((key === '@id' || key === '@type') && typeof entry === 'string') {
        if (entry.startsWith('_:') || ABSOLUTE_IRI.test(entry)) {
          continue
        }
        throw new Error(`relative IRI ${entry} in ${source}`)
      }
      walk(entry)
    }
  }
  walk(expanded)
}

/**
 * Convert a parsed RDF dataset into a framed JSON-LD node.
 *
 * Uses jsonld.fromRDF + jsonld.frame to resolve @reverse relationships
 * automatically, without embedding child nodes.
 * Throws if the node is not in the framed output.
 */
export async function frameDataset(
  dataset: DatasetCore,
  context: JsonLdContext,
  iri: string
): Promise<Record<string, unknown>> {
  const expanded = await jsonld.fromRDF(dataset)
  assertAbsoluteIris(expanded, `dataset ${iri}`)
  return frameDoc(expanded, context, iri)
}

/**
 * Strip the embedded `@context` from a framed node — the payload-only form
 * model POJOs consume (`frameNode`); used for the `sai.jsonld.framed` span
 * attribute so dumps don't carry the shared context (~40 lines per span).
 */
function withoutContext(doc: Record<string, unknown>): Record<string, unknown> {
  const { '@context': _context, ...rest } = doc
  return rest
}

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * framed node. The document can be in expanded, compacted, or flattened form.
 * Uses jsonld.frame to resolve @reverse relationships automatically, without
 * embedding child nodes.
 * Throws if the node is not in the framed output.
 *
 * Tracing: emits a `frameDoc` span carrying the FRAMED payload
 * (`sai.jsonld.framed`) — the decoded form consumers actually read; for GETs
 * this is the framed version of a `fetchJsonLd` raw document (the two appear
 * as siblings under the same RPC/RPC-adjacent span). Recording-only:
 * no-op spans cost zero when tracing is off.
 */
export async function frameDoc(
  doc: unknown,
  context: JsonLdContext,
  iri: string,
  overrides: Record<string, Record<string, unknown>> = {}
): Promise<Record<string, unknown>> {
  return withSpan('sai-jsonld', 'frameDoc', async (span) => {
    span.setAttribute('sai.jsonld.uri', iri)
    // compactToRelative: false — compaction would otherwise emit relative IRI
    // references (shorter than the absolute form) wherever a base is available
    const framed = await frameJsonLd(doc, buildFrame(context, iri, overrides), {
      documentLoader,
      compactToRelative: false,
    })
    if (!framed.id && !framed['@id']) {
      throw new Error(`Node ${iri} not found in framed output`)
    }
    // the framed node — @context stripped for the payload (frameNode does
    // the same for the model POJOs); the span attribute set before end()
    if (span.isRecording()) {
      span.setAttribute('sai.jsonld.framed', JSON.stringify(withoutContext(framed)))
    }
    return framed
  })
}

/**
 * A framed JSON-LD node from the shared data-model context: the well-known
 * keys are typed (`id`/`@id` — the `id` alias; `type` — the `@type` alias
 * with `@container: '@set'`, so always a string[], never a scalar), while
 * every other term key is `unknown`: node references compact to plain IRI
 * strings (`@type: '@id'` coercion), set terms to string arrays, literals to
 * plain strings or `{ '@value', … }` objects (unwrapped by the accessor
 * family), and absent properties are omitted (`@omitDefault`).
 */
export type FramedNode = {
  id: string
  '@id'?: string
  type?: Array<string>
} & Record<string, unknown>

/**
 * Typed front for `frameDoc` — the uniform mapper entry replacing the
 * repeated `(await frameDoc(...)) as any` / `Record<string, unknown>` casts
 * across the data-model `fromJsonLd`s. The `str`/`opt`/`strs` accessors
 * handle per-field reads; `id`/`type` are read directly off the typed
 * `FramedNode`.
 */
export async function frameNode(
  doc: unknown,
  context: JsonLdContext,
  iri: string,
  overrides: Record<string, Record<string, unknown>> = {}
): Promise<FramedNode> {
  const node = (await frameDoc(doc, context, iri, overrides)) as Record<string, unknown> & {
    '@context'?: unknown
  }
  // the frame embeds its @context in the output — strip it so the node is
  // pure POJO data (term keys, plain-IRI/literal values only)
  const { '@context': _context, ...rest } = node
  const id = (rest.id ?? rest['@id']) as string | undefined
  if (!id) {
    throw new Error(`framed node ${iri} has no id`)
  }
  return withSetDefaults({ ...rest, id }, context)
}

/**
 * Fill `[]` for every `@container: '@set'` term the framed node does not carry.
 *
 * A forward set term already frames as `[]` when absent; `@reverse` and
 * `@type: '@vocab'` set terms are omitted by the framing algorithm instead
 * (verified against jsonld@9, no `@default` applies). Filling here makes the
 * package contract uniform — **every declared set term is an array** — so POJO
 * readers never default a set field and `Framed*` types can declare them as
 * required.
 */
function withSetDefaults(node: FramedNode, context: JsonLdContext): FramedNode {
  const out: FramedNode = { ...node }
  for (const [term, definition] of Object.entries(context)) {
    if (typeof definition !== 'object' || definition === null || !isSetContainer(definition)) {
      continue
    }
    if (out[term] === undefined) {
      out[term] = []
    }
  }
  return out
}

/**
 * Project a framed node to `id`, `type` and the model's terms, dropping every
 * other framed property. The model's `Framed*` type states the POJO contract —
 * set-container terms as required arrays (`frameNode` fills `[]`), single
 * valued terms optional — so the projection is returned as `T` itself; models
 * pass their complete term list.
 */
export function projectNode<T extends object, K extends keyof T & string>(
  node: T,
  terms: ReadonlyArray<K>
): { id: string; type: Array<string> } & T {
  const source = node as Record<string, unknown>
  const out: Record<string, unknown> = {
    id: source.id,
    type: source.type ?? [],
  }
  for (const term of terms) {
    const value = source[term]
    if (value !== undefined && value !== null) {
      out[term] = value
    }
  }
  return out as { id: string; type: Array<string> } & T
}

/** Optional single value — string when present, `undefined` when absent. */
export function opt(node: Record<string, unknown>, key: string): string | undefined {
  return framedValue(node[key])
}

/**
 * A single value the model requires. Frames omit absent single-valued terms
 * (see `buildFrame`), so a missing value is a malformed document, not a POJO
 * default: throw instead of coercing to `''`.
 */
export function required(node: Record<string, unknown>, key: string): string {
  const value = opt(node, key)
  if (value === undefined) {
    const id = (node.id ?? node['@id']) as string | undefined
    throw new Error(`node ${id} is missing required term ${key}`)
  }
  return value
}

/**
 * Array value — set-container terms frame as string arrays, but the
 * accessor also absorbs scalar-or-array and literal-object members;
 * `[]` when absent.
 */
export function strs(node: Record<string, unknown>, key: string): Array<string> {
  const value = node[key]
  if (value === undefined || value === null) {
    return []
  }
  return (Array.isArray(value) ? value : [value]).map((item) => framedValue(item) ?? '')
}

/**
 * A JSON-LD language map (JSON-LD 1.1 §4.6.2): literals indexed by language
 * tag — the untagged value under `@none`, translations under their tags.
 * Label fields carry one value per language (a per-model assumption), so
 * every entry is a plain string.
 */
export type LanguageMap = Record<string, string> & { '@none'?: string }

/**
 * Pick a single value from a language map for a preferred language — the
 * RPC-facing projection of a language-map field: the requested language
 * first, then the untagged default (`@none`), then any remaining entry.
 * `undefined` when the map is absent or empty.
 */
export function pickLanguage(map: LanguageMap | undefined, preferred?: string): string | undefined {
  if (!map) {
    return undefined
  }
  if (preferred && typeof map[preferred] === 'string') {
    return map[preferred]
  }
  if (typeof map['@none'] === 'string') {
    return map['@none']
  }
  const first = Object.values(map)[0]
  return typeof first === 'string' ? first : undefined
}

/**
 * Find the `@id` of the first node in a JSON-LD document whose `@type`
 * includes `typeIri` — the JSON-LD replacement for
 * `getOneMatchingQuad(dataset, null, RDF.type, typeIri).subject`.
 * Throws when no such node exists.
 *
 * Matching is delegated to the framing algorithm: a frame with only
 * `{'@type': typeIri}` matches the FIRST node of that type as the focus —
 * single match frames as the node itself, multiple matches wrap in
 * `@graph`, none yields `{}`. A `@graph` pattern inside a frame is a single
 * object and does not filter, so it cannot be used as a selector.
 */
export async function findNodeIdByType(
  doc: unknown,
  typeIri: string,
  base?: string
): Promise<string> {
  // compactToRelative: false — frame() compacts its output against base by
  // default and would return relative @ids for absolute-id documents
  const options: any = { documentLoader, compactToRelative: false }
  if (base) {
    options.base = base
  }
  const framed = await frameJsonLd(doc, { '@type': typeIri }, options)
  const node = framed['@id'] ? framed : framed['@graph']?.[0]
  if (typeof node?.['@id'] !== 'string') {
    throw new Error(`no node of type ${typeIri} in document`)
  }
  return node['@id']
}

/**
 * Collect the values of a predicate (as literal `@value` / node `@id`) across
 * every node of a JSON-LD document (expanded form, walked recursively).
 *
 * Replaces document-wide quad scans where the values live on other nodes than
 * the framed one (e.g. `interop:usesLanguage` on the description sets of an
 * access need document). The predicate is matched by its full IRI.
 */
export async function documentValues(
  doc: unknown,
  iri: string,
  predicate: string
): Promise<Array<string>> {
  const expanded = await expandJsonLd(doc, { base: iri, documentLoader })
  const values = new Set<string>()
  const nodes: Array<any> = []
  const collectNodes = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectNodes)
      return
    }
    if (value && typeof value === 'object') {
      nodes.push(value)
      for (const nested of Object.values(value)) {
        collectNodes(nested)
      }
    }
  }
  collectNodes(expanded)
  for (const node of nodes) {
    const matches = node[predicate]
    if (Array.isArray(matches)) {
      for (const match of matches) {
        if (typeof match === 'string') {
          values.add(match)
        } else if (typeof match?.['@value'] === 'string') {
          values.add(match['@value'])
        } else if (typeof match?.['@id'] === 'string') {
          values.add(match['@id'])
        }
      }
    }
  }
  return [...values]
}

/**
 * Convert a JSON-LD document (with embedded context) to an N3 Store.
 *
 * Uses jsonld.toRDF to convert the JSON-LD object directly to RDF quads
 * and collects them into an N3 Store.
 */
export async function toStore(doc: Record<string, unknown>, base?: string): Promise<Store> {
  const dataset = await jsonld.toRDF(doc, {
    base,
    documentLoader,
  })
  const store = new Store()
  for (const quad of dataset as unknown as Iterable<Quad>) {
    store.add(quad)
  }
  return store
}

/**
 * Serialize a JSON-LD document (with embedded context) to N-Quads text via
 * `jsonld.toRDF`. Default-graph documents yield N-Triples (valid Turtle data
 * block bodies for SPARQL `INSERT DATA`/`DELETE DATA`); a named-graph document
 * `{ '@id': graphIri, '@graph': doc }` yields N-Quads with the graph label in
 * the 4th term.
 */
export async function toNQuads(doc: Record<string, unknown>, base?: string): Promise<string> {
  return (await jsonld.toRDF(doc, {
    format: 'application/n-quads',
    base,
    documentLoader,
  })) as unknown as string
}

/**
 * A non-2xx response from a JSON-LD GET. Carries the status so callers can
 * classify the failure — e.g. the mirror sync treats `404`/`410` on a peer's
 * registration as "peer gone" (terminal) while everything else retries.
 * The message is unchanged (`failed to fetch <iri>: <status>`) so existing
 * string assertions and logs keep reading the same.
 */
export class HttpStatusError extends Error {
  public readonly iri: string
  public readonly status: number

  public constructor(iri: string, status: number) {
    super(`failed to fetch ${iri}: ${status}`)
    this.name = 'HttpStatusError'
    this.iri = iri
    this.status = status
  }
}

/**
 * The LWS profile parameter for JSON-LD requests (LWS, §Containers and
 * resources). Servers that support it return the LWS RDF view (with
 * `lws:contains` / `lws:partOf`); servers that only speak Solid ignore the
 * parameter or reject it, in which case `fetchJsonLd` retries without it.
 */
const LWS_PROFILE = 'https://www.w3.org/ns/lws/v1'
const LWS_JSON_LD_ACCEPT = `application/ld+json; profile="${LWS_PROFILE}"`
const JSON_LD_ACCEPT = 'application/ld+json'

/**
 * The LWS JSON container representation (`application/lws+json`, and the
 * `application/ld+json`/`application/json` equivalents). It is a page listing
 * (`id`, `type`, `totalItems`, `items`), not the RDF document of the
 * container, so the data model can not frame it.
 */
function isLwsContainerDocument(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return false
  }
  const record = doc as Record<string, unknown>
  const context = record['@context']
  const contexts = Array.isArray(context) ? context : [context]
  return (
    contexts.includes(LWS_PROFILE) && Array.isArray(record.items) && typeof record.id === 'string'
  )
}

/**
 * Fetches the RDF document of a container as expanded JSON-LD.
 *
 * An LWS-only server answers `application/ld+json` for containers with the
 * LWS JSON page listing, which loses the container's own RDF (e.g. the
 * `interop:hasDataRegistry` links of a registry set). Plain `text/turtle` is
 * not one of the LWS JSON output types, so the generic converter serializes
 * the stored RDF — the representation the data model expects.
 */
async function fetchContainerRdf(iri: string, fetch: WhatwgFetch): Promise<unknown> {
  const response = await fetch(iri, { headers: { Accept: 'text/turtle' } })
  if (!response.ok) {
    throw new HttpStatusError(iri, response.status)
  }
  const store = new Store()
  store.addQuads(new Parser({ baseIRI: iri }).parse(await response.text()))
  return jsonld.fromRDF(store)
}

/**
 * Fetch a JSON-LD resource and return it in **expanded** form with every IRI
 * absolute — the only place a base IRI enters the package.
 *
 * Relative IRI references in a retrieved document resolve against the
 * document base (JSON-LD 1.1 §4.1.3, RFC 3986 §5.1), which is the response's
 * final URL after redirects — not the IRI that was requested. Expanding here
 * means every downstream consumer (framing, `documentValues`, `toStore`, the
 * quad readers) works on absolute IRIs and never needs a base.
 *
 * Throws `HttpStatusError` when the response is not ok, when the response
 * carries no URL (a test double or a custom `fetch` that does not model the
 * final URL — there is no safe base without it), and when a relative IRI
 * survives expansion (`"@base": null` in the document suppresses resolution).
 *
 * The request prefers the LWS profile; if the server does not support it
 * (406/415) the request is retried with plain `application/ld+json`. A
 * container that comes back as the LWS JSON page listing is re-fetched as RDF
 * (see `fetchContainerRdf`).
 *
 * Tracing: emits a `fetchJsonLd` span carrying the RAW wire document
 * (`sai.jsonld.raw` — no envelope). The auto HTTP client span (undici/http
 * instrumentation) nests inside as the actual GET. Recording-only.
 */
export async function fetchJsonLd(iri: string, fetch: WhatwgFetch): Promise<unknown> {
  return withSpan('sai-jsonld', 'fetchJsonLd', async (span) => {
    span.setAttribute('sai.jsonld.uri', iri)
    let response = await fetch(iri, {
      headers: { Accept: LWS_JSON_LD_ACCEPT },
    })
    if (response.status === 406 || response.status === 415) {
      response = await fetch(iri, { headers: { Accept: JSON_LD_ACCEPT } })
    }
    if (!response.ok) {
      throw new HttpStatusError(iri, response.status)
    }
    const base = response.url
    if (!base) {
      throw new Error(`fetch response for ${iri} has no url`)
    }
    let doc: unknown = await response.json()
    if (isLwsContainerDocument(doc)) {
      doc = await fetchContainerRdf(base, fetch)
    }
    if (span.isRecording()) {
      span.setAttribute('sai.jsonld.raw', JSON.stringify(doc))
    }
    const expanded = await expandJsonLd(doc, { base, documentLoader })
    assertAbsoluteIris(expanded, base)
    return expanded
  })
}

/**
 * Generic fetch+decode loader — the uniform `loadX` wrapper factory that
 * replaces the per-model `loadX = fromJsonLd(await fetchJsonLd(id, fetch), id)`
 * pairs. The generic `T` is instantiated by inference
 * from `decode`'s return type at each use site; `WhatwgFetch` stays in the
 * factory signature, away from the model files:
 *
 * ```ts
 * export const loadRole = loader(fromJsonLd) // (id, fetch) => Promise<RoleData>
 * ```
 */
export function loader<T>(decode: (doc: unknown, id: string) => Promise<T>) {
  return async (id: string, fetch: WhatwgFetch): Promise<T> =>
    decode(await fetchJsonLd(id, fetch), id)
}

/**
 * Expand a JSON-LD document (with embedded context) to the expanded form —
 * full-IRI property keys, node references as `{ '@id' }`, literals as
 * `{ '@value' }` — with no `@context` on the result. The write path uses this
 * so PUT bodies carry no context (and are context-version-proof).
 *
 * No base is used: the package never creates relative IRIs (minted identifiers
 * are absolute, reads resolve at `fetchJsonLd`), so a relative IRI in a write
 * payload is a bug — `assertAbsoluteIris` throws on it.
 */
export async function expandedJsonLd(doc: Record<string, unknown>): Promise<Array<unknown>> {
  const expanded = await jsonld.expand(doc, { documentLoader })
  assertAbsoluteIris(expanded, 'write payload')
  return expanded
}

/**
 * Raw JSON-LD PUT of a document — the body is sent in expanded form (see
 * `expandedJsonLd`; the document's embedded context is only used to expand).
 * Throws if the request fails. Extra headers (e.g. If-None-Match) can be
 * passed through.
 *
 * Tracing: emits a `putJsonLd` span carrying BOTH the framed POJO the
 * caller wrote (`sai.jsonld.framed`, @context stripped) and the expanded
 * wire body actually PUT (`sai.jsonld.expanded`). Recording-only.
 */
export async function putJsonLd(
  iri: string,
  fetch: WhatwgFetch,
  doc: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<void> {
  await withSpan('sai-jsonld', 'putJsonLd', async (span) => {
    span.setAttribute('sai.jsonld.uri', iri)
    const expanded = await expandedJsonLd(doc)
    const body = JSON.stringify(expanded)
    if (span.isRecording()) {
      span.setAttribute('sai.jsonld.framed', JSON.stringify(withoutContext(doc)))
      span.setAttribute('sai.jsonld.expanded', body)
    }
    const response = await fetch(iri, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/ld+json', ...headers },
    })
    if (!response.ok) {
      throw new Error(`failed to put ${iri}: ${response.status}`)
    }
  })
}

/**
 * Unwrap a value from framed JSON-LD output to a plain string.
 *
 * Plain strings pass through; language-tagged and typed literals frame to
 * `{ @value, @language }` / `{ @value, @type }` objects; node references
 * (IRI values without `@type: '@id'` coercion) frame to `{ id }` objects.
 */
export function framedValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj['@value'] === 'string') {
      return obj['@value']
    }
    if (typeof obj.id === 'string') {
      return obj.id
    }
    if (typeof obj['@id'] === 'string') {
      return obj['@id']
    }
  }
  return undefined
}

/** Attach a context to a node POJO (used by the toJsonLd functions). */
export function withContext(
  context: JsonLdContext,
  node: Record<string, unknown>
): Record<string, unknown> {
  return {
    '@context': context,
    ...node,
  }
}
