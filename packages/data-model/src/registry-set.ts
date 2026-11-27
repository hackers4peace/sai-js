import { frameNode, projectNode, required } from '@janeirodigital/interop-utils'

import type { ActivityRegistryData } from './activity-registry.ts'
import type {
  ApplicationRegistryData,
  InvitationRegistryData,
  SocialAgentRegistryData,
} from './agent-registry.ts'
import type { AuthorizationRegistryData } from './authorization-registry.ts'
import { dataModelContext } from './context.ts'
import type { DataRegistryData } from './data-registry.ts'
import type { GrantRegistryData } from './grant-registry.ts'
import type { RoleRegistryData } from './role-registry.ts'

type FramedRegistrySet = {
  id: string
  type?: Array<string>
  hasAuthorizationRegistry?: string
  hasGrantRegistry?: string
  hasSocialAgentRegistry?: string
  hasApplicationRegistry?: string
  hasInvitationRegistry?: string
  hasRoleRegistry?: string
  hasDataRegistry: Array<string>
  hasActivityRegistry?: string
  hasAccessRequestRegistry?: string
}

const REGISTRY_SET_TERMS = [
  'hasAuthorizationRegistry',
  'hasGrantRegistry',
  'hasSocialAgentRegistry',
  'hasApplicationRegistry',
  'hasInvitationRegistry',
  'hasRoleRegistry',
  'hasDataRegistry',
  'hasActivityRegistry',
  'hasAccessRequestRegistry',
] as const

export type RegistrySetData = {
  id: string
  type: Array<string>
  hasAuthorizationRegistry: AuthorizationRegistryData
  hasGrantRegistry: GrantRegistryData
  hasSocialAgentRegistry: SocialAgentRegistryData
  hasApplicationRegistry: ApplicationRegistryData
  hasInvitationRegistry: InvitationRegistryData
  hasRoleRegistry: RoleRegistryData
  hasDataRegistry: Array<DataRegistryData>
  /** present once the Activity Registry is seeded; producers throw without it */
  hasActivityRegistry?: ActivityRegistryData
  /** present once the AccessRequestRegistry is seeded (authorization-granting.md §6.3) */
  hasAccessRequestRegistry?: AccessRequestRegistryData
}

export type AccessRequestRegistryData = {
  id: string
}

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * RegistrySetData POJO. The document can be in expanded, compacted, or
 * flattened form.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<RegistrySetData> {
  const framed = (await frameNode(doc, dataModelContext, id)) as unknown as FramedRegistrySet
  const node = projectNode(framed, REGISTRY_SET_TERMS)
  // The six core registries are REQUIRED and created by the account bootstrap
  // (`templates/RegistrySet.ts` — `registrySetTemplate`, used by
  // `postBootstrapTriG`). No `{ id: '' }` placeholder: a registry set without
  // one of them is malformed, not a lesser registry set.
  return {
    ...node,
    hasAuthorizationRegistry: { id: required(node, 'hasAuthorizationRegistry') },
    hasGrantRegistry: { id: required(node, 'hasGrantRegistry') },
    hasSocialAgentRegistry: { id: required(node, 'hasSocialAgentRegistry') },
    hasApplicationRegistry: { id: required(node, 'hasApplicationRegistry') },
    hasInvitationRegistry: { id: required(node, 'hasInvitationRegistry') },
    hasRoleRegistry: { id: required(node, 'hasRoleRegistry') },
    hasDataRegistry: node.hasDataRegistry.map((dataRegistryId) => ({ id: dataRegistryId })),
    // optional by design: seeded when their first member is written
    hasActivityRegistry: node.hasActivityRegistry ? { id: node.hasActivityRegistry } : undefined,
    hasAccessRequestRegistry: node.hasAccessRequestRegistry
      ? { id: node.hasAccessRequestRegistry }
      : undefined,
  }
}
