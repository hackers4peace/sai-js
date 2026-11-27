import { readFileSync } from 'node:fs'

import { jsonld } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { DataFactory, Parser } from 'n3'
import type { Quad, Term } from 'n3'

// A local mock TriG fixture for unit tests. It is a trimmed copy of the full
// stack seed (environments/data/registry.trig), so package tests never read the
// integration fixture. Each graph is a resource document; `meta:*` graphs carry
// the CSS container metadata and the plain graph the resource itself.
const fixtureTrig = readFileSync(new URL('./fixtures.trig', import.meta.url), 'utf8')

// Keep the parser's quad array (document order) — the N3 Store reorders quads
// internally (numeric-id indexes), which would scramble multi-valued output.
const fixtureQuads = new Parser({ format: 'application/trig' }).parse(fixtureTrig)

/** Unique key for a term — distinct for literals with the same lexical value
 * but different language / datatype. */
function termKey(term: Term): string {
  return `${term.termType}|${term.value}|${term.language}|${(term as any).datatype?.value ?? ''}`
}

/**
 * Build an expanded JSON-LD document — the shape a GET with
 * Accept: application/ld+json returns — from one or more named graphs of the
 * local fixture.
 *
 * Quads are deduplicated (an RDF graph is a set; the fixture repeats the same
 * containment in the meta and resource graphs of a container) and flattened to
 * the default graph so `fromRDF` yields a flat node array.
 */
export async function docFromGraphs(graphIris: Array<string>): Promise<Array<unknown>> {
  const seen = new Set<string>()
  const quads: Array<Quad> = []
  for (const quad of fixtureQuads) {
    if (!graphIris.includes(quad.graph.value)) {
      continue
    }
    const quadKey = [quad.subject, quad.predicate, quad.object].map(termKey).join('|')
    if (seen.has(quadKey)) {
      continue
    }
    seen.add(quadKey)
    // strip the graph component -> default graph (flat expanded doc)
    quads.push(DataFactory.quad(quad.subject, quad.predicate, quad.object))
  }
  return jsonld.fromRDF(quads)
}

/** A tiny fetch mock that serves one graph as an expanded JSON-LD document. */
export const fixtureFetch: WhatwgFetch = (async (url: string) => {
  const doc = await docFromGraphs([url.replace(/#.*$/, '')])
  return {
    ok: true,
    status: 200,
    // a real response carries its final URL; `fetchJsonLd` uses it as the base
    url,
    headers: new Headers({ 'content-type': 'application/ld+json' }),
    json: async () => doc,
    text: async () => JSON.stringify(doc),
  } as unknown as Response
}) as WhatwgFetch
