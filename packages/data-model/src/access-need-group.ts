import { frameNode } from '@janeirodigital/interop-utils'

import type { AccessNeedData } from './access-need.ts'
import { dataModelContext } from './context.ts'

export type AccessNeedGroupId = {
  id: string
  type: Array<string>
}

export type AccessNeedGroupData = AccessNeedGroupId & {
  hasAccessNeed: Array<string>
  /** The group's access needs, loaded recursively (see the AA `accessNeedGroup` composed read). */
  accessNeeds: Array<AccessNeedData>
}

// ──────────────────────────
// Read path: JSON-LD → AccessNeedGroupData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into an
 * AccessNeedGroupData POJO. The document can be in expanded, compacted, or
 * flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<AccessNeedGroupData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    hasAccessNeed: (node.hasAccessNeed as Array<string> | undefined) ?? [],
    accessNeeds: [],
  }
}
