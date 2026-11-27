import { frameNode, projectNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import type { AccessDescriptionData, AccessDescriptionId } from './access-description.ts'
import { dataModelContext } from './context.ts'

export type AccessNeedDescriptionId = AccessDescriptionId

type FramedAccessNeedDescription = {
  id: string
  type?: Array<string>
  label?: LanguageMap
  definition?: LanguageMap
  hasAccessNeed?: Array<string>
}

const ACCESS_NEED_DESCRIPTION_TERMS = ['label', 'definition', 'hasAccessNeed'] as const

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
  const framed = (await frameNode(
    doc,
    dataModelContext,
    id
  )) as unknown as FramedAccessNeedDescription
  const node = projectNode(framed, ACCESS_NEED_DESCRIPTION_TERMS)
  return {
    ...node,
    label: node.label ?? {},
    hasAccessNeed: node.hasAccessNeed?.[0],
  }
}
