import { frameNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import type { AccessDescriptionData, AccessDescriptionId } from './access-description.ts'
import { dataModelContext } from './context.ts'

export type AccessNeedGroupDescriptionId = AccessDescriptionId

export type AccessNeedGroupDescriptionData = AccessDescriptionData & {
  // TODO handle missing value
  hasAccessNeedGroup: string
}

// ──────────────────────────
// Read path: JSON-LD → AccessNeedGroupDescriptionData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into an
 * AccessNeedGroupDescriptionData POJO. The document can be in expanded,
 * compacted, or flattened form.
 */
export async function fromJsonLd(
  doc: unknown,
  id: string
): Promise<AccessNeedGroupDescriptionData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    label: node.label as LanguageMap,
    definition: node.definition as LanguageMap | undefined,
    hasAccessNeedGroup: node.hasAccessNeedGroup as string,
  }
}
