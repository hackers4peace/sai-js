import { frameNode, projectNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

// ──────────────────────────
// Types
// ──────────────────────────

/** Identity of a shape tree description resource. */
type FramedShapeTreeDescription = {
  id: string
  type?: Array<string>
  label?: LanguageMap
  definition?: LanguageMap
}

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

const SHAPE_TREE_DESCRIPTION_TERMS = ['label', 'definition'] as const

// ──────────────────────────
// Read path: JSON-LD → ShapeTreeDescriptionData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * ShapeTreeDescriptionData POJO. The document can be in expanded, compacted,
 * or flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<ShapeTreeDescriptionData> {
  const framed = (await frameNode(
    doc,
    dataModelContext,
    id
  )) as unknown as FramedShapeTreeDescription
  const node = projectNode(framed, SHAPE_TREE_DESCRIPTION_TERMS)
  return {
    ...node,
    label: node.label ?? {},
  }
}
