import {
  type RoleData,
  type RoleRegistryData,
  dataModelContext,
} from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  type LanguageMap,
  type WhatwgFetch,
  createResource,
  mintResource,
  putJsonLd,
  withContext,
} from '@janeirodigital/interop-utils'

import type { DataModelDependencies } from './types.ts'

// ──────────────────────────
// Write path: RoleData → JSON-LD
// ──────────────────────────

/** Update an existing role (its IRI is already contained in the registry). */
export async function putRole(data: RoleData, fetch: WhatwgFetch): Promise<void> {
  // the shared context carries the `label` language-map container so the map
  // expands to proper literals on the wire
  await putJsonLd(data.id, fetch, withContext(dataModelContext, data))
}

/**
 * Materialize a role at its PRE-MINTED flat IRI: POST + `Slug` to the role
 * registry (the store records `lws:contains`/`lws:partOf`), idempotent under
 * workflow retries (an existing role is left alone).
 */
export async function createRoleAt(
  data: RoleRegistryData,
  fetch: WhatwgFetch,
  role: RoleData
): Promise<void> {
  const existing = await fetch(role.id, { method: 'HEAD' })
  if (existing.status === 200) return
  await createResource(data.id, role.id, { fetch }, false, withContext(dataModelContext, role))
}

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────

export async function createRole(
  data: RoleRegistryData,
  deps: DataModelDependencies,
  label: LanguageMap,
  members: string[]
): Promise<RoleData> {
  const iri = await mintResource(data.id, deps)
  const role: RoleData = { id: iri, label, members, type: [INTEROP.Role] }
  await createRoleAt(data, deps.fetch, role)
  return role
}

export async function updateRole(
  data: RoleRegistryData,
  fetch: WhatwgFetch,
  roleId: string,
  label: LanguageMap,
  members: string[]
): Promise<RoleData> {
  const role: RoleData = { id: roleId, label, members, type: [INTEROP.Role] }
  await putRole(role, fetch)
  return role
}

export async function deleteRole(
  data: RoleRegistryData,
  fetch: WhatwgFetch,
  roleId: string
): Promise<void> {
  const { ok } = await fetch(roleId, { method: 'DELETE' })
  if (!ok) {
    throw new Error('failed to delete role')
  }
}
