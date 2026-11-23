import { frameNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import type { AccessDescriptionData, AccessDescriptionId } from './access-description.ts'
import { dataModelContext } from './context.ts'

export type AccessNeedDescriptionId = AccessDescriptionId

export type AccessNeedDescriptionData = AccessDescriptionData & {
  hasAccessNeed?: string
}

// ──────────────────────────
// Read path: JSON-LD → AccessNeedDescriptionData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into an
 * AccessNeedDescriptionData POJO. The document can be in expanded, compacted,
 * or flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<AccessNeedDescriptionData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    label: node.label as LanguageMap,
    definition: node.definition as LanguageMap | undefined,
    hasAccessNeed: (node.hasAccessNeed as Array<string> | undefined)?.[0],
  }
}
