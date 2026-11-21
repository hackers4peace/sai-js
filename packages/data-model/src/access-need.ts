import { INTEROP, documentValues, frameNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type AccessNeedId = {
  id: string
  type: string[]
}

export type AccessNeedData = AccessNeedId & {
  registeredShapeTree: string
  inheritsFromNeed?: string
  hasInheritingNeed: string[]
  accessMode: string[]
  /** Whether the need is required (interop:accessNecessity = interop:AccessRequired). */
  required: boolean
  /** Inheriting needs, loaded recursively (see the AA `accessNeed` composed read). */
  children: AccessNeedData[]
  /** Languages used by description sets in the access needs document. */
  descriptionLanguages: string[]
  /**
   * Requested data instances (`interop:hasDataInstance`).
   *
   * Only request projections use it — a client-id/access-need-group document
   * normally carries none. It is optional so a plain access need (shape-tree
   * scope) remains unchanged.
   */
  hasDataInstance?: string[]
  /**
   * The requested data registration, when the request is registration-scoped
   * rather than shape-tree or instance scoped. Request projections only.
   */
  hasDataRegistration?: string
}

// ──────────────────────────
// Read path: JSON-LD → AccessNeedData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into an
 * AccessNeedData POJO. The document can be in expanded, compacted, or
 * flattened form.
 *
 * Uses jsonld.frame with the dataModelContext to resolve the @reverse
 * relationship (hasInheritingNeed) automatically. `descriptionLanguages` is
 * collected from the whole document (flattened), since it lives on the
 * description sets, not on the need node itself. `required` is a derived
 * boolean (`interop:accessNecessity = interop:AccessRequired`).
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<AccessNeedData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    registeredShapeTree: node.registeredShapeTree as string,
    inheritsFromNeed: node.inheritsFromNeed as string | undefined,
    hasInheritingNeed: (node.hasInheritingNeed as string[] | undefined) ?? [],
    accessMode: (node.accessMode as string[] | undefined) ?? [],
    required: node.required === INTEROP.AccessRequired,
    children: [],
    descriptionLanguages: await documentValues(doc, id, INTEROP.usesLanguage),
    ...(node.hasDataInstance ? { hasDataInstance: node.hasDataInstance as string[] } : {}),
    ...(node.hasDataRegistration
      ? { hasDataRegistration: node.hasDataRegistration as string }
      : {}),
  }
}
