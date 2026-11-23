import { type LanguageMap, frameNode, opt } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type SocialAgentInvitationId = {
  id: string
  type: Array<string>
}

export type SocialAgentInvitationData = SocialAgentInvitationId & {
  capabilityUrl: string
  /** language map — the untagged label under `@none`, translations under their tags */
  label: LanguageMap
  note?: string
  registeredAgent?: string
}

// ──────────────────────────
// Read path: JSON-LD → SocialAgentInvitationData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * SocialAgentInvitationData POJO.
 *
 * The document can be in expanded, compacted, or flattened form.
 * Uses jsonld.frame with the shared data model context: node references
 * (`capabilityUrl`, `registeredAgent`) are coerced to strings via
 * `@type: '@id'`, literals to plain strings, and the rdf:type (from framing)
 * to a string array.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<SocialAgentInvitationData> {
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id,
    type: node.type ?? [],
    capabilityUrl: node.capabilityUrl as string,
    label: (node.label as LanguageMap | undefined) ?? {},
    note: opt(node, 'note'),
    registeredAgent: opt(node, 'registeredAgent'),
  }
}
