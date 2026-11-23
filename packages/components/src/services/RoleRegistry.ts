import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import { Role as RoleModel } from '@janeirodigital/interop-data-model'
import type {
  RoleCreated,
  RoleData,
  RoleDeleted,
  RoleMembershipChanged,
} from '@janeirodigital/interop-data-model'
const loadRole = loader(RoleModel.fromJsonLd)

import { INTEROP, loader, pickLanguage } from '@janeirodigital/interop-utils'
import {
  IRI,
  Role,
  RoleCreatedMessage,
  RoleDeletedMessage,
  RoleMembershipChangedMessage,
} from '@janeirodigital/sai-api-messages'
import type { Schema } from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import { getRole, listContained, sparqlTransportFor } from './queries/org.js'

/**
 * The context's roles via SPARQL — personal context reads the session's
 * internal endpoint, org context the org's `/sparql-admin`
 * (`sparqlTransportFor`): role bodies live in their own graphs (keyed by
 * the role IRI), so the listing is `listContained` + one graph read per
 * role (docs/sparql.md step 1). Write paths (create/update/delete) stay
 * REST/LDP via the data-model RoleRegistry.
 */
export const getRoles = async (ctx: ResolvedContext, lang: string) => {
  const transport = sparqlTransportFor(ctx)
  const iris = await listContained(transport, ctx.registrySet.hasRoleRegistry.id)
  const registrations = (await Promise.all(iris.map((iri) => getRole(transport, iri)))).filter(
    (role): role is RoleData => role !== undefined
  )
  return registrations.map((registration) =>
    Role.make({
      id: IRI.make(registration.id),
      // the stored label is a language map — surface the plain string for
      // the preferred language (untagged `@none` as the fallback)
      label: pickLanguage(registration.label, lang) ?? '',
      members: (registration.members ?? []).map((m) => IRI.make(m)),
    })
  )
}

export const createRole = async (
  ctx: ResolvedContext,
  label: string,
  members: ReadonlyArray<Schema.Type<typeof IRI>>
): Promise<Schema.Type<typeof RoleCreatedMessage>> => {
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) {
    throw new Error('activity registry not found in registry set')
  }
  // activity-first (step 9 — the createInvitation pattern): the RPC mints
  // the role id and writes `roleCreated` (object = the role-to-be at the
  // minted id, real-id embedded projection) — the createRole workflow PUTs
  // the role there and completes. No derived work: no authorizations can
  // exist before the role exists (the PUT IS the create).
  const roleId = await ctx.session.mintIdentifier(ctx.registrySet.hasRoleRegistry.id)
  const object: RoleData = {
    id: roleId,
    type: [INTEROP.Role],
    // the activity object (real-id embedded projection) carries the label as
    // a language map — the activity write context expands it to literals
    label: { '@none': label },
    members: [...members],
  }
  const activity: Omit<RoleCreated, 'id'> = {
    type: ['Activity', 'RoleCreated', 'as:Add'],
    actor: ctx.webId,
    object,
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    {
      fetch: ctx.session.fetch,
      randomUUID: ctx.session.randomUUID,
      identifierStrategies: ctx.session.identifierStrategies,
    },
    activity
  )
  // pending ack — echoes the role-to-be (pending handle) + the triggering
  // activity id (the uniform UI claim anchor)
  return RoleCreatedMessage.make({
    id: IRI.make(roleId),
    label,
    members: [...members],
    activityId: IRI.make(created.id),
  })
}

export const updateRole = async (
  ctx: ResolvedContext,
  id: Schema.Type<typeof IRI>,
  label: string,
  members: ReadonlyArray<Schema.Type<typeof IRI>>
): Promise<Schema.Type<typeof RoleMembershipChangedMessage>> => {
  // guard read: the role must exist — the workflow re-loads the before-image
  // and PATCHes; a missing role would else leave the activity pending forever
  await loadRole(id, ctx.session.fetch)
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) {
    throw new Error('activity registry not found in registry set')
  }
  // activity-first (step 2): the RPC writes the intended change only — the
  // role-to-be as a real-id embedded projection (id + type + label + full
  // members; `target` dropped — the id rides object.id). The updateRole
  // workflow PATCHes the role to this state, derives the affected diff
  // (before vs after members from the before-image it loads) and regenerates.
  const object: RoleData = {
    id,
    type: [INTEROP.Role],
    // the activity object (real-id embedded projection) carries the label as
    // a language map — the activity write context expands it to literals
    label: { '@none': label },
    members: [...members],
  }
  const activity: Omit<RoleMembershipChanged, 'id'> = {
    type: ['Activity', 'RoleMembershipChanged', 'as:Update'],
    actor: ctx.webId,
    object,
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    {
      fetch: ctx.session.fetch,
      randomUUID: ctx.session.randomUUID,
      identifierStrategies: ctx.session.identifierStrategies,
    },
    activity
  )
  // pending ack — echoes the role-to-be (pending handle) + the triggering
  // activity id (the uniform UI claim anchor)
  return RoleMembershipChangedMessage.make({
    id,
    label,
    members: [...members],
    activityId: IRI.make(created.id),
  })
}

export const deleteRole = async (
  ctx: ResolvedContext,
  id: Schema.Type<typeof IRI>
): Promise<Schema.Type<typeof RoleDeletedMessage>> => {
  // guard read + the write-time snapshot: the role is alive here, so the
  // full RoleData (members incl.) embeds as the activity's real-id object —
  // the retry backstop once the workflow has deleted the resource
  const roleData = await loadRole(id, ctx.session.fetch)
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) {
    throw new Error('activity registry not found in registry set')
  }
  // activity-first (step 3): the RPC writes the intended deletion only —
  // `target` dropped, the role-to-be-deleted rides `object` (real-id
  // embedded projection); the deleteRole workflow loads first (find-first),
  // DELETEs the role (404-tolerant), regenerates and completes
  const activity: Omit<RoleDeleted, 'id'> = {
    type: ['Activity', 'RoleDeleted'],
    actor: ctx.webId,
    object: {
      id,
      type: [INTEROP.Role],
      label: roleData.label,
      members: roleData.members,
    },
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    {
      fetch: ctx.session.fetch,
      randomUUID: ctx.session.randomUUID,
      identifierStrategies: ctx.session.identifierStrategies,
    },
    activity
  )
  // pending ack — echoes the deleted role id (pending handle) + the
  // triggering activity id (the uniform UI claim anchor)
  return RoleDeletedMessage.make({ id, activityId: IRI.make(created.id) })
}
