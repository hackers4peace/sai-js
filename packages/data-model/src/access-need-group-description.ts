import { frameNode, projectNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import type { AccessDescriptionData, AccessDescriptionId } from './access-description.ts'
import { dataModelContext } from './context.ts'

export type AccessNeedGroupDescriptionId = AccessDescriptionId

type FramedAccessNeedGroupDescription = {
  id: string
  type?: Array<string>
  label?: LanguageMap
  definition?: LanguageMap
  hasAccessNeedGroup?: string
}

const ACCESS_NEED_GROUP_DESCRIPTION_TERMS = ['label', 'definition', 'hasAccessNeedGroup'] as const

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
  const framed = (await frameNode(
    doc,
    dataModelContext,
    id
  )) as unknown as FramedAccessNeedGroupDescription
  const node = projectNode(framed, ACCESS_NEED_GROUP_DESCRIPTION_TERMS)
  return {
    ...node,
    label: node.label ?? {},
    hasAccessNeedGroup: node.hasAccessNeedGroup ?? '',
  }
}
