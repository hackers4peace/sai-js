import { frameNode, projectNode, required } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import type { AgentRegistrationId } from './agent-registration.ts'
import { dataModelContext } from './context.ts'

type FramedSocialAgentRegistration = {
  id: string
  type?: Array<string>
  registeredAgent?: string
  hasDataGrant?: Array<string>
  hasAdminGrant?: Array<string>
  label?: LanguageMap
  note?: string
  reciprocalRegistration?: string
}

export type SocialAgentRegistrationId = AgentRegistrationId

export type SocialAgentRegistrationData = SocialAgentRegistrationId & {
  registeredAgent: string
  /** `interop:hasDataGrant` — the registration's link predicate to `lws:AccessGrant` resources (the wire term is kept for Interop compatibility). */
  hasDataGrant?: Array<string>
  hasAdminGrant?: Array<string>
  /** language map — the untagged label under `@none`, translations under their tags */
  label: LanguageMap
  note?: string
  reciprocalRegistration?: string
}

const SOCIAL_AGENT_REGISTRATION_TERMS = [
  'registeredAgent',
  'hasDataGrant',
  'hasAdminGrant',
  'label',
  'note',
  'reciprocalRegistration',
] as const

export type SocialAgentId = {
  id: string
  type: Array<string>
}

// ──────────────────────────
// Read path: JSON-LD → SocialAgentRegistrationData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * SocialAgentRegistrationData POJO.
 *
 * The document can be in expanded, compacted, or flattened form. Uses
 * jsonld.frame with the shared data model context: node references
 * (`registeredAgent`, `reciprocalRegistration`) are
 * coerced to strings via `@type: '@id'`, `hasDataGrant` to a string array via
 * `@type: '@id'` + `@container: '@set'`, literals to plain strings, and the
 * rdf:type (from framing) to a string array.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<SocialAgentRegistrationData> {
  const framed = (await frameNode(
    doc,
    dataModelContext,
    id
  )) as unknown as FramedSocialAgentRegistration
  const node = projectNode(framed, SOCIAL_AGENT_REGISTRATION_TERMS)
  return {
    ...node,
    registeredAgent: required(node, 'registeredAgent'),
    label: node.label ?? {},
  }
}

export function getAdminGrantIris(data: SocialAgentRegistrationData): Array<string> {
  return data.hasAdminGrant ?? []
}
