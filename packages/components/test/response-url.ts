/**
 * The URL a mock response would carry as `response.url` in a real fetch.
 *
 * `fetchJsonLd` uses the response's final URL as the base IRI for expansion
 * (JSON-LD 1.1 §4.1.3) and rejects a response without one, so a test double
 * must model it. Test documents are absolute-IRI fixtures, so the document's
 * own `@id` is the correct URL to report — no expansion depends on it.
 */
export function responseUrl(body: unknown): string {
  const candidate = Array.isArray(body) ? body[0] : body
  if (candidate && typeof candidate === 'object') {
    const id = (candidate as { '@id'?: unknown })['@id']
    if (typeof id === 'string') {
      return id
    }
  }
  return ''
}
