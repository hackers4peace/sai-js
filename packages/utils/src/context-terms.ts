/**
 * Turn a JSON-LD context into term maps.
 *
 * The context is the single source of truth for term names and their IRIs:
 * `contextTerms` produces the token enum (`{ AllFromRegistry: 'AllFromRegistry',
 * AccessGrant: 'AccessGrant', … }`) and `contextIndex` resolves each term's IRI
 * and the reverse lookup used to map framed values back to tokens.
 *
 * Only terms with a definite IRI are indexed: keywords (`@…`), the `id`/`type`
 * aliases, and reverse terms are skipped (a reverse term points at a property
 * IRI, not at a vocabulary value). A term value may be an absolute IRI, a
 * compact IRI resolved through the context's own prefixes, or a term object
 * with `@id`.
 */

type AbsoluteIri = string

export type ContextTerm<C> = Exclude<keyof C, `@${string}`> & string

export type ContextTerms<C> = { [K in ContextTerm<C>]: K }

export interface ContextIndex {
  /** term -> absolute IRI */
  iriByTerm: Record<string, AbsoluteIri>
  /** absolute IRI -> term (first definition wins; contexts should not duplicate) */
  termByIri: Map<AbsoluteIri, string>
}

const ABSOLUTE_IRI = /^(https?:|urn:)/
const PREFIX_VALUE = /[#/]$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTermKey(key: string): boolean {
  return !key.startsWith('@') && key !== 'id' && key !== 'type'
}

function expandIri(value: string, prefixes: Record<string, AbsoluteIri>): string | undefined {
  if (ABSOLUTE_IRI.test(value)) {
    return value
  }
  const separator = value.indexOf(':')
  if (separator <= 0) {
    return undefined
  }
  const namespace = prefixes[value.slice(0, separator)]
  return namespace === undefined ? undefined : namespace + value.slice(separator + 1)
}

/** Prefix terms (string values ending in `#` or `/`) of a context. */
function prefixesOf(context: Record<string, unknown>): Record<string, AbsoluteIri> {
  const prefixes: Record<string, AbsoluteIri> = {}
  for (const [term, definition] of Object.entries(context)) {
    if (
      typeof definition === 'string' &&
      ABSOLUTE_IRI.test(definition) &&
      PREFIX_VALUE.test(definition)
    ) {
      prefixes[term] = definition
    }
  }
  return prefixes
}

/** The term → token map of a context (`{ Term: 'Term' }`). */
export function contextTerms<C extends Record<string, unknown>>(context: C): ContextTerms<C> {
  const terms: Record<string, string> = {}
  for (const term of Object.keys(context)) {
    if (isTermKey(term)) {
      terms[term] = term
    }
  }
  return terms as ContextTerms<C>
}

/** Term IRIs and the reverse IRI → term lookup of a context. */
export function contextIndex<C extends Record<string, unknown>>(context: C): ContextIndex {
  const prefixes = prefixesOf(context)
  const iriByTerm: Record<string, string> = {}
  const termByIri = new Map<string, string>()
  for (const [term, definition] of Object.entries(context)) {
    if (!isTermKey(term)) {
      continue
    }
    const raw =
      typeof definition === 'string'
        ? definition
        : isRecord(definition) && typeof definition['@id'] === 'string'
          ? definition['@id']
          : undefined
    if (raw === undefined || raw.startsWith('@')) {
      continue
    }
    const iri = expandIri(raw, prefixes)
    if (iri === undefined) {
      continue
    }
    iriByTerm[term] = iri
    if (!termByIri.has(iri)) {
      termByIri.set(iri, term)
    }
  }
  return { iriByTerm, termByIri }
}

/** Pick a subset of context terms — used for the typed vocabularies. */
export function pickTerms<C extends Record<string, unknown>, K extends keyof C>(
  context: C,
  keys: ReadonlyArray<K>
): { [P in K]: C[P] } {
  const picked = {} as { [P in K]: C[P] }
  for (const key of keys) {
    picked[key] = context[key]
  }
  return picked
}

/** Token for a term or absolute IRI (`undefined` for an unknown value). */
export function contextTerm(index: ContextIndex, value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }
  return Object.hasOwn(index.iriByTerm, value) ? value : index.termByIri.get(value)
}

/** Absolute IRI of a term (the value itself when it is not a known term). */
export function contextIri(index: ContextIndex, value: string): string {
  return index.iriByTerm[value] ?? value
}
