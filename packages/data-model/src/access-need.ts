import {
  CONTEXT,
  INTEROP,
  asAccessNecessityTerm,
  documentValues,
  frameNode,
  projectNode,
  required,
} from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedAccessNeed = {
  id: string
  type?: Array<string>
  registeredShapeTree?: string
  inheritsFromNeed?: string
  hasInheritingNeed: Array<string>
  accessMode: Array<string>
  required?: string
  hasDataInstance?: Array<string>
  hasDataRegistration?: string
}

const ACCESS_NEED_TERMS = [
  'registeredShapeTree',
  'inheritsFromNeed',
  'hasInheritingNeed',
  'accessMode',
  'required',
  'hasDataInstance',
  'hasDataRegistration',
] as const

export type AccessNeedId = {
  id: string
  type: Array<string>
}

export type AccessNeedData = AccessNeedId & {
  registeredShapeTree: string
  inheritsFromNeed?: string
  hasInheritingNeed: Array<string>
  accessMode: Array<string>
  /** Whether the need is required (interop:accessNecessity = interop:AccessRequired). */
  required: boolean
  /** Inheriting needs, loaded recursively (see the AA `accessNeed` composed read). */
  children: Array<AccessNeedData>
  /** Languages used by description sets in the access needs document. */
  descriptionLanguages: Array<string>
  /**
   * Requested data instances (`interop:hasDataInstance`).
   *
   * Only request projections use it — a client-id/access-need-group document
   * normally carries none. It is optional so a plain access need (shape-tree
   * scope) remains unchanged.
   */
  hasDataInstance?: Array<string>
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
  const framed = (await frameNode(doc, dataModelContext, id)) as unknown as FramedAccessNeed
  const node = projectNode(framed, ACCESS_NEED_TERMS)
  return {
    ...node,
    registeredShapeTree: required(node, 'registeredShapeTree'),
    required: asAccessNecessityTerm(required(node, 'required')) === CONTEXT.AccessRequired,
    children: [],
    descriptionLanguages: await documentValues(doc, id, INTEROP.usesLanguage),
  }
}
