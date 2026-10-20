import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import type {
  AdminAuthorizationGranted,
  AdminAuthorizationRevoked,
} from '@janeirodigital/interop-data-model'
import { INTEROP, iriForContained } from '@janeirodigital/interop-utils'
import {
  AdminAuthorizationGrantedMessage,
  AdminAuthorizationRevokedMessage,
  IRI,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import { findSocialAgentRegistrationInContext } from './SocialAgentRegistry.js'

/**
 * Promote a registered social agent to org admin (activity-first step 5 — R1
 * re-decision): the RPC keeps the VALIDATION reads (registered + not-already-
 * admin) and pre-mints the AdminAuthorization id, then writes the
 * `adminAuthorizationGranted` activity (object = the AdminAuthorization-to-be,
 * real-id embedded projection at that id — `target` dropped). The `addAdmin`
 * workflow PUTs the resource at the pre-minted id, materializes the admin
 * grants + ACR rewrite, then completes. Runs on the signed-in user's AA — the
 * owner identity (`ctx.webId`) is the context (the org).
 */
export const addAdmin = async (
  ctx: ResolvedContext,
  webId: S.Schema.Type<typeof IRI>
): Promise<S.Schema.Type<typeof AdminAuthorizationGrantedMessage>> => {
  const registration = await findSocialAgentRegistrationInContext(ctx, webId)
  if (!registration) throw new Error(`Social Agent Registration for ${webId} not found`)

  const authorizationRegistry = ctx.registrySet.hasAuthorizationRegistry
  const existing = await ctx.session.findAdminAuthorization(webId, authorizationRegistry)
  if (existing) throw new Error(`Admin Authorization for ${webId} already exists`)

  // pre-mint the AdminAuthorization id — the workflow PUTs the resource there
  // (the same minting the AA's recordAdminAuthorization would do)
  const authorizationId = iriForContained(authorizationRegistry, ctx.session.randomUUID)

  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')
  const activity: Omit<AdminAuthorizationGranted, 'id'> = {
    type: ['Activity', 'AdminAuthorizationGranted'],
    actor: ctx.webId,
    object: {
      id: authorizationId,
      type: [INTEROP.AdminAuthorization],
      grantee: webId,
      grantedBy: ctx.webId,
      scopeOfAuthorization: INTEROP.All,
    },
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID },
    activity
  )
  // pending ack — echoes the pre-minted AdminAuthorization id (pending
  // handle) + the triggering activity id (the uniform UI claim anchor)
  return AdminAuthorizationGrantedMessage.make({
    id: IRI.make(authorizationId),
    activityId: IRI.make(created.id),
  })
}

/**
 * Demote a registered social agent from org admin (activity-first step 6 —
 * the R1 re-decision's remove half): the RPC keeps the VALIDATION reads
 * (registered, admin-exists, last-admin guard) and writes the
 * `adminAuthorizationRevoked` activity (object = the EXISTING
 * AdminAuthorization as a real-id embedded projection at its id — `target`
 * dropped). The `removeAdmin` workflow DELETEs the resource at that id,
 * revokes the admin grants + the ACR rewrite (re-guarding the last admin via
 * `syncAdminAcr`), then completes.
 */
export const removeAdmin = async (
  ctx: ResolvedContext,
  webId: S.Schema.Type<typeof IRI>
): Promise<S.Schema.Type<typeof AdminAuthorizationRevokedMessage>> => {
  const registration = await findSocialAgentRegistrationInContext(ctx, webId)
  if (!registration) throw new Error(`Social Agent Registration for ${webId} not found`)

  const authorizationRegistry = ctx.registrySet.hasAuthorizationRegistry
  const existing = await ctx.session.findAdminAuthorization(webId, authorizationRegistry)
  if (!existing) throw new Error(`Admin Authorization for ${webId} not found`)

  // last-admin guard — the org must never end up adminless; sails as a
  // RPC-time validation read (R1 re-decision) and is re-checked by the
  // workflow's syncAdminAcr. OWNER exception (Phase 5): in the personal
  // context (ctx.webId === ctx.userWebId) the signed-in user always remains
  // the operator of their own registry set, so demoting the only admin is
  // legitimate — the guard only protects org contexts from ending up
  // admin-less.
  const count = (await ctx.session.adminAuthorizations(authorizationRegistry)).length
  if (ctx.webId !== ctx.userWebId && count === 1) {
    throw new Error('can not remove the last admin')
  }

  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')
  // activity-first: the existing AdminAuthorization (alive at write) rides
  // as a real-id embedded projection at its real id — `target` dropped; the
  // workflow DELETEs the resource at object.id (404-tolerant, idempotent)
  const activity: Omit<AdminAuthorizationRevoked, 'id'> = {
    type: ['Activity', 'AdminAuthorizationRevoked'],
    actor: ctx.webId,
    object: {
      id: existing.id,
      type: existing.type,
      grantee: existing.grantee,
      grantedBy: existing.grantedBy,
      scopeOfAuthorization: existing.scopeOfAuthorization,
    },
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID },
    activity
  )
  // pending ack — echoes the revoked AdminAuthorization id (pending handle)
  // + the triggering activity id (the uniform UI claim anchor)
  return AdminAuthorizationRevokedMessage.make({
    id: IRI.make(existing.id),
    activityId: IRI.make(created.id),
  })
}
