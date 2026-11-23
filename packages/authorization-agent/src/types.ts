import type { IdentifierStrategyResolver, WhatwgFetch } from '@janeirodigital/interop-utils'

/**
 * Plain dependencies for data-model functions (replaces the factories):
 * functions that read/write pass `fetch`; writers that mint or create new
 * resource identifiers pass the full `DataModelDependencies` (the resolver is
 * optional so callers can share a storage-strategy cache).
 */
export interface DataModelDependencies {
  fetch: WhatwgFetch
  randomUUID: () => string
  identifierStrategies?: IdentifierStrategyResolver
}
