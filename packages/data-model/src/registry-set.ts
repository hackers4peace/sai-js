import { frameNode } from '@janeirodigital/interop-utils'

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
  const node = await frameNode(doc, dataModelContext, id)
  return {
    id,
    type: node.type ?? [],
    hasAuthorizationRegistry: { id: node.hasAuthorizationRegistry as string },
    hasGrantRegistry: { id: node.hasGrantRegistry as string },
    hasSocialAgentRegistry: { id: node.hasSocialAgentRegistry as string },
    hasApplicationRegistry: { id: node.hasApplicationRegistry as string },
    hasInvitationRegistry: { id: node.hasInvitationRegistry as string },
    hasRoleRegistry: { id: node.hasRoleRegistry as string },
    hasDataRegistry: ((node.hasDataRegistry as Array<string> | undefined) ?? []).map(
      (dataRegistryId) => ({ id: dataRegistryId })
    ),
    hasActivityRegistry: node.hasActivityRegistry
      ? { id: node.hasActivityRegistry as string }
      : undefined,
    hasAccessRequestRegistry: node.hasAccessRequestRegistry
      ? { id: node.hasAccessRequestRegistry as string }
      : undefined,
  }
}
