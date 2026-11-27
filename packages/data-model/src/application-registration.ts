import { frameNode, projectNode, required } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedApplicationRegistration = {
  id: string
  type?: Array<string>
  registeredAgent?: string
  hasDataGrant: Array<string>
}

const APPLICATION_REGISTRATION_TERMS = ['registeredAgent', 'hasDataGrant'] as const

export type ApplicationRegistrationId = {
  id: string
  type: Array<string>
}

export type ApplicationRegistrationData = ApplicationRegistrationId & {
  registeredAgent: string
  /** `interop:hasDataGrant` — the registration's link predicate to `lws:AccessGrant` resources (the wire term is kept for Interop compatibility). */
  hasDataGrant: Array<string>
  /** Derived: whether the registration has any access grants. */
  granted: boolean
}

export type ApplicationId = {
  id: string
  type: Array<string>
}

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into an
 * ApplicationRegistrationData POJO. The document can be in expanded, compacted,
 * or flattened form. `granted` is derived from the presence of access grants.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<ApplicationRegistrationData> {
  const framed = (await frameNode(
    doc,
    dataModelContext,
    id
  )) as unknown as FramedApplicationRegistration
  const node = projectNode(framed, APPLICATION_REGISTRATION_TERMS)
  return {
    ...node,
    registeredAgent: required(node, 'registeredAgent'),
    granted: node.hasDataGrant.length > 0,
  }
}
