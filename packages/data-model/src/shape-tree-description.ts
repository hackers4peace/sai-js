import { type LanguageMap, frameNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

// ──────────────────────────
// Types
// ──────────────────────────

/** Identity of a shape tree description resource. */
export type ShapeTreeDescriptionId = {
  id: string
  /** rdf:type IRIs — captured from framing on read */
  type: Array<string>
}

/** Plain JSON representation of a shape tree description resource. */
export type ShapeTreeDescriptionData = ShapeTreeDescriptionId & {
  // TODO: handle missing labels
  /** language map — the untagged label under `@none`, translations under their tags */
  label: LanguageMap
  /** language map — the untagged definition under `@none`, translations under their tags */
  definition?: LanguageMap
}

// ──────────────────────────
// Read path: JSON-LD → ShapeTreeDescriptionData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * ShapeTreeDescriptionData POJO. The document can be in expanded, compacted,
 * or flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<ShapeTreeDescriptionData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    label: node.label as LanguageMap,
    definition: node.definition as LanguageMap | undefined,
  }
}
