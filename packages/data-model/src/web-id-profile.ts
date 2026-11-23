import { type LanguageMap, frameNode, opt } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

// ──────────────────────────
// Types
// ──────────────────────────

/** Identity of a WebID profile document. */
export type WebIdProfileId = {
  id: string
  /** rdf:type IRIs — captured from framing on read */
  type: Array<string>
}

/** Plain JSON representation of a WebID profile document. */
export type WebIdProfileData = WebIdProfileId & {
  /** language map — the untagged label under `@none`, translations under their tags */
  label?: LanguageMap
  oidcIssuer?: string
}

// ──────────────────────────
// Read path: JSON-LD → WebIdProfileData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * WebIdProfileData POJO. The document can be in expanded, compacted, or
 * flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<WebIdProfileData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    label: node.label as LanguageMap | undefined,
    oidcIssuer: opt(node, 'oidcIssuer'),
  }
}
