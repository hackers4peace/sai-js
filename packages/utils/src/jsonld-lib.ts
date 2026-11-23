import * as jsonldNs from 'jsonld'

/**
 * jsonld.js is a CommonJS package: in an ESM bundle the namespace object
 * carries the full exports only on `.default`, while in CJS the namespace is
 * the module object directly. Resolve the interop once here so every call site
 * — in this package, in downstream packages, and in tests — uses the same
 * object (`fromRDF`, `toRDF`, `expand`, `frame`, … all available either way).
 */
export const jsonld = (jsonldNs as unknown as { default?: typeof jsonldNs }).default ?? jsonldNs
