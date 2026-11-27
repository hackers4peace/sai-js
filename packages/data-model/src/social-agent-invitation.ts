import { frameNode, projectNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedSocialAgentInvitation = {
  id: string
  type?: Array<string>
  capabilityUrl?: string
  label?: LanguageMap
  note?: string
  registeredAgent?: string
}

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

const SOCIAL_AGENT_INVITATION_TERMS = ['capabilityUrl', 'label', 'note', 'registeredAgent'] as const

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
  const framed = (await frameNode(
    doc,
    dataModelContext,
    id
  )) as unknown as FramedSocialAgentInvitation
  const node = projectNode(framed, SOCIAL_AGENT_INVITATION_TERMS)
  return {
    ...node,
    capabilityUrl: node.capabilityUrl ?? '',
    label: node.label ?? {},
  }
}
