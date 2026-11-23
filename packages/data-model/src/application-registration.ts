import { frameNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

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
  const node = await frameNode(doc, dataModelContext, id)
  const hasDataGrant = (node.hasDataGrant as Array<string> | undefined) ?? []
  return {
    id: node.id ?? node['@id'],
    type: node.type ?? [],
    registeredAgent: node.registeredAgent as string,
    hasDataGrant,
    granted: hasDataGrant.length > 0,
  }
}
