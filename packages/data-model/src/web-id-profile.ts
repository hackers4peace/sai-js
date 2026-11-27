import { frameNode, projectNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

// ──────────────────────────
// Types
// ──────────────────────────

/** Identity of a WebID profile document. */
type FramedWebIdProfile = {
  id: string
  type?: Array<string>
  label?: LanguageMap
  oidcIssuer?: string
}

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

const WEB_ID_PROFILE_TERMS = ['label', 'oidcIssuer'] as const

// ──────────────────────────
// Read path: JSON-LD → WebIdProfileData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * WebIdProfileData POJO. The document can be in expanded, compacted, or
 * flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<WebIdProfileData> {
  const framed = (await frameNode(doc, dataModelContext, id)) as unknown as FramedWebIdProfile
  return projectNode(framed, WEB_ID_PROFILE_TERMS)
}
