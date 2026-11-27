import { replaceAdminGrantLinks } from '@janeirodigital/interop-authorization-agent'
import {
  getRegistryGrants,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import type {
  AdminAuthorizationData,
  AgentId,
  EmbeddedAdminAuthorization,
  SocialAgentId,
} from '@janeirodigital/interop-data-model'
import {
  AdminAuthorization,
  accessGrantAcrJsonLd,
  grantContext,
  grantGrantee,
  rewriteFullAdminAccess,
} from '@janeirodigital/interop-data-model'
import type { OdrlPolicy } from '@janeirodigital/interop-data-model'
import {
  CONTEXT,
  ACCESS_ACTIONS,
  INTEROP,
  LWS,
  discoverAccessResource,
  discoverAuthorizationAgent,
  fetchJsonLd,
  getAcl,
  putJsonLd,
  withContext,
} from '@janeirodigital/interop-utils'

import { buildSessionManager } from '../../builders/sessionManager.js'

/**
 * AdminGrant payload — mirrors the §3.6 seed shapes: one RegistrySet-scoped
 * grant (the admin marker, linked on the registration) + one Read-only
 * DataRegistry-scoped grant per data registry in the RegistrySet.
 */
export type AdminGrantData = {
  id?: string
  type: Array<string>
  storage: string
  access: Array<OdrlPolicy>
  grantedBy: string
  dataOwner: string
  scopeOfAdminGrant: string
}

/** Admin grants are read-only Storage-scoped ODRL agreements. */
function adminAccess(assignee: string, storage: string, owner: string): Array<OdrlPolicy> {
  const policyId = `urn:uuid:${crypto.randomUUID()}`
  const permissionId = `urn:uuid:${crypto.randomUUID()}`
  const targetId = `urn:uuid:${crypto.randomUUID()}`
  return [
    {
      id: policyId,
      uid: policyId,
      type: ['http://www.w3.org/ns/odrl/2/Agreement'],
      profile: CONTEXT.AccessProfile,
      permission: [
        {
          id: permissionId,
          uid: permissionId,
          assigner: owner,
          assignee,
          action: [ACCESS_ACTIONS.read],
          target: {
            id: targetId,
            uid: targetId,
            owner,
            storage,
            type: ['http://www.w3.org/ns/odrl/2/AssetCollection', LWS.Storage],
            source: [storage],
          },
        },
      ],
    },
  ]
}

export interface AdminActivityInput {
  webId: SocialAgentId
  /** the admin webId (typed SocialAgent) */
  admin: AgentId
  /** IRI of the activity that triggered this workflow — marked done on success */
  activityId?: string
}

export interface AdminGrantsData {
  registrySetGrant: AdminGrantData
  dataRegistryGrants: Array<AdminGrantData>
}

/**
 * The activity-first addAdmin leg (step 5): PUT the AdminAuthorization at the
 * PRE-MINTED id with the context's own session. Find-first by the STABLE
 * pre-minted id — idempotent under retries/reconcile: a re-run after a crash
 * sees the resource already materialized and skips (the `If-None-Match: *`
 * PUT would 412 on the second attempt). The grantee rides the embedded
 * object; the type is the constant AdminAuthorization class.
 */
export async function recordAdminAuthorizationAtId(payload: {
  webId: SocialAgentId
  authorization: EmbeddedAdminAuthorization
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const existing = await fetchJsonLd(payload.authorization.id, session.fetch).catch(
    (): undefined => undefined
  )
  if (existing) {
    return
  }
  const data: AdminAuthorizationData = {
    id: payload.authorization.id,
    type: [INTEROP.AdminAuthorization],
    grantee: payload.authorization.grantee,
    grantedBy: payload.authorization.grantedBy,
    scopeOfAuthorization: payload.authorization.scopeOfAuthorization,
  }
  await session.createIdentifierResource(
    session.registrySet.hasAuthorizationRegistry.id,
    payload.authorization.id,
    false,
    AdminAuthorization.toJsonLd(data)
  )
}

/**
 * The activity-first removeAdmin leg (step 6): DELETE the AdminAuthorization
 * at the EXISTING id with the context's own session. Find-first by the
 * STABLE id — idempotent under retries/reconcile: a retry after a crash
 * between the DELETE and the completion sees the resource already gone and
 * skips (must NOT throw — the affected set rides the embedded object).
 */
export async function deleteAdminAuthorizationAtId(payload: {
  webId: SocialAgentId
  authorization: EmbeddedAdminAuthorization
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const existing = await fetchJsonLd(payload.authorization.id, session.fetch).catch(
    (): undefined => undefined
  )
  if (!existing) {
    return
  }
  await session.deleteAdminAuthorization(payload.authorization.id)
}

/**
 * Build the admin's grant payloads in the org's GrantRegistry: the
 * RegistrySet-scoped admin marker first, then one Read-only DataRegistry-
 * scoped grant per data registry in the org's RegistrySet (the engine's
 * source for org-context data-registry iteration/labels).
 */
export async function buildAdminGrants(payload: {
  webId: SocialAgentId
  admin: AgentId
}): Promise<AdminGrantsData> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registry = session.registrySet.hasGrantRegistry

  const registryStorage = session.registrySet.id
  const registrySetGrant: AdminGrantData = {
    id: await session.mintIdentifier(registry.id),
    type: [INTEROP.AdminGrant, LWS.AccessGrant],
    storage: registryStorage,
    access: adminAccess(payload.admin.id, registryStorage, payload.webId.id),
    grantedBy: payload.webId.id,
    dataOwner: payload.webId.id,
    scopeOfAdminGrant: INTEROP.RegistrySet,
  }

  const dataRegistryGrants: Array<AdminGrantData> = []
  for (const dataRegistry of session.registrySet.hasDataRegistry) {
    dataRegistryGrants.push({
      id: await session.mintIdentifier(registry.id),
      type: [INTEROP.AdminGrant, LWS.AccessGrant],
      storage: dataRegistry.id,
      access: adminAccess(payload.admin.id, dataRegistry.id, payload.webId.id),
      grantedBy: payload.webId.id,
      dataOwner: payload.webId.id,
      scopeOfAdminGrant: INTEROP.DataRegistry,
    })
  }
  return { registrySetGrant, dataRegistryGrants }
}

/** Create an AdminGrant in the org's GrantRegistry (org session) as a flat member. */
export async function storeAdminGrant(grant: AdminGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(grant.dataOwner)
  await session.createIdentifierResource(
    session.registrySet.hasGrantRegistry.id,
    grant.id,
    false,
    withContext(grantContext, {
      id: grant.id,
      type: grant.type,
      scopeOfAdminGrant: grant.scopeOfAdminGrant,
      access: grant.access,
    })
  )
}

/**
 * ACR for an AdminGrant: org fullOwnerAccess (org + its UAS) + peerReadAccess
 * (the admin + their UAS) — same shape as the access-grant ACRs.
 */
export async function createAdminGrantAcr(payload: { grant: AdminGrantData }): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.grant.dataOwner)
  const grantee = grantGrantee(payload.grant) ?? ''
  const uasId = await discoverAuthorizationAgent(grantee, fetch)
  if (!uasId) {
    throw new Error(`no authorization agent for admin: ${grantee}`)
  }

  const headResponse = await session.fetch(payload.grant.id, {
    method: 'HEAD',
  })
  const acrId = getAcl(headResponse.headers.get('link'))
  if (!acrId) {
    throw new Error(`no acl link on admin grant: ${payload.grant.id}`)
  }

  await putJsonLd(
    acrId,
    session.fetch,
    accessGrantAcrJsonLd({
      id: acrId,
      resource: payload.grant.id,
      owner: {
        agent: session.webId,
        client: session.agentId,
      },
      peer: {
        agent: grantee,
        client: uasId,
      },
    })
  )
}

/** Set the admin's registration hasAdminGrant links to exactly `grantIds`. */
export async function replaceAdminGrantLink(payload: {
  webId: SocialAgentId
  admin: AgentId
  grantIds: Array<string>
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registration = await session.findSocialAgentRegistration(payload.admin.id)
  if (!registration) {
    throw new Error(`social agent registration for admin ${payload.admin.id} not found`)
  }
  await replaceAdminGrantLinks(registration, session.fetch, payload.grantIds)
}

/** The admin's AdminGrants in the org's GrantRegistry (by grantee). */
export async function findAdminGrants(payload: {
  webId: SocialAgentId
  admin: AgentId
}): Promise<Array<{ id: string; type: Array<string> }>> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registry = session.registrySet.hasGrantRegistry
  // the grant registry over the plane (listing + one graph read per grant)
  const grants = await getRegistryGrants(localSparqlTransport(session.sparqlEndpoint), registry.id)
  return grants
    .filter((grant) => grant.type.includes(CONTEXT.AdminGrant))
    .filter((grant) => grantGrantee(grant) === payload.admin.id)
    .map((grant) => ({ id: grant.id, type: grant.type }))
}

/** Delete the admin's AdminGrant resources (and their ACRs); 404 is tolerated. */
export async function deleteAdminGrants(payload: {
  webId: SocialAgentId
  grants: Array<{ id: string; type: Array<string> }>
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  for (const grant of payload.grants) {
    const headResponse = await session.fetch(grant.id, { method: 'HEAD' })
    if (headResponse.ok) {
      const acrId = getAcl(headResponse.headers.get('link'))
      if (acrId) {
        const acrResponse = await session.fetch(acrId, { method: 'DELETE' })
        if (!acrResponse.ok && acrResponse.status !== 404) {
          throw new Error(`failed to delete admin grant acr: ${acrResponse.status}`)
        }
      }
    }
    const response = await session.fetch(grant.id, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete admin grant: ${response.status}`)
    }
  }
}

/**
 * Rewrite the registry-set `.acr` `#fullAdminAccess` access control from the
 * current admin list (idempotent derived rewrite; the AuthorizationRegistry
 * is the single source of truth). Also wires the control into the access
 * control resource's `#root` (`acp:accessControl`/`acp:memberAccessControl`)
 * so it applies to the registry set and its members — contexts whose seed
 * never wired it (e.g. a personal registry set) get the enforcement on the
 * first promotion. An EMPTY admin list is legitimate for the personal
 * context (Phase 5 — the owner remains the operator after demoting their
 * only admin): the rewrite then removes the `#fullAdminAccess` control
 * entirely. For orgs the RPC last-admin guard prevents reaching this state
 * through the UI.
 */
export async function syncAdminAcr(payload: { webId: SocialAgentId }): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)

  const admins = await session.adminAuthorizations(session.registrySet.hasAuthorizationRegistry)

  const matchers: Array<{ agent: string; client: string }> = []
  for (const admin of admins) {
    const uasId = await discoverAuthorizationAgent(admin.grantee, fetch)
    if (!uasId) {
      throw new Error(`no authorization agent for admin: ${admin.grantee}`)
    }
    matchers.push({ agent: admin.grantee, client: uasId })
  }

  const acrId = await discoverAccessResource(session.registrySet.id, session.fetch)
  if (!acrId) {
    throw new Error(`no acl link on registry set: ${session.registrySet.id}`)
  }

  // idempotent remove-then-add of the #fullAdminAccess control (and its #root
  // wiring) — an empty admin list removes the control entirely
  const doc = await fetchJsonLd(acrId, session.fetch)
  await putJsonLd(acrId, session.fetch, rewriteFullAdminAccess(doc, acrId, matchers))
}
