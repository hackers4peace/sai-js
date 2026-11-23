import {
  type DataInstanceFacts,
  type ShareContextFacts,
  type ShareDataInstanceStructure,
  type WhoHasAccess,
  accessForResource,
  scopeFacts,
} from '@janeirodigital/interop-authorization-agent'
import {
  ActivityRegistry,
  computeChildren,
  loadDataInstance,
  accessNeedGroup as resolveAccessNeedGroup,
} from '@janeirodigital/interop-authorization-agent'
import {
  type AccessNeedData,
  type AccessNeedGroupData,
  type AuthorizationGranted,
  ClientIdDocument,
  type DataAuthorizationData,
  type DataInstanceData,
  type DataRegistrationData,
  DataRegistration,
  type EmbeddedNeedBasedAccessRequest,
  type NeedBasedAccessRequestGroup,
  type NeedBasedAccessRequestSent,
  type RoleData,
  ShapeTree,
  isBlob,
  labelFromNode,
} from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)
const loadClientIdDocument = loader(ClientIdDocument.fromJsonLd)

import { INTEROP, loader, pickLanguage } from '@janeirodigital/interop-utils'
import {
  IRI,
  NeedBasedAccessRequestSentMessage,
  Resource,
  type ShareAuthorization,
  type ShareAuthorizationConfirmation,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import { ownStorageOf } from './Context.js'
import { fetchPeerDocument, peerInstanceNode, peerRegistrationOfInstance } from './peerData.js'
import {
  getDataAuthorization,
  containingContainer,
  contextPod,
  getDataRegistration,
  getRole,
  listContained,
  listRegistrationsByShapeTrees,
  sparqlTransportFor,
  sparqlTransportForPod,
} from './queries/org.js'
import { listSocialAgentRegistrations } from './SocialAgentRegistry.js'

/**
 * Grantees whose org-side data authorizations cover the resource — the
 * org-context counterpart of `AA.findWhoHasAccess`, evaluated over the ORG's
 * authorization registry (via SPARQL) instead of the session's own. Pure —
 * exported for unit tests; the scope rule itself is the AA's
 * `accessForResource` (the rule lives in the AA, not here).
 */
export function whoHasAccessMatching(
  authorizations: DataAuthorizationData[],
  resource: DataInstanceFacts,
  ownerWebId: string,
  roles: RoleData[] = []
): WhoHasAccess {
  return accessForResource(authorizations, resource, ownerWebId, scopeFacts(roles, authorizations))
}

/** `whoHasAccessMatching` projected to its direct agent grantees. */
export function agentsWithAccessMatching(
  authorizations: DataAuthorizationData[],
  resource: DataInstanceFacts,
  ownerWebId: string,
  roles: RoleData[] = []
): string[] {
  return whoHasAccessMatching(authorizations, resource, ownerWebId, roles).agents.map(
    ({ agent }) => agent
  )
}

/**
 * "Who has access": data authorizations of the *context* authorization
 * registry, matched like `AA.findWhoHasAccess` (with `ctx.webId` as the
 * owner) — direct agent grantees filtered to agents registered with the
 * context, role grantees with their members expanded. Reads via SPARQL
 * (`queries/org.ts`) — personal context via the session's internal endpoint,
 * org context over `/sparql-admin` (`sparqlTransportFor`); the admin session
 * HTTP-derefs no peer document and holds no access grants.
 */
async function orgWhoHasAccess(
  ctx: ResolvedContext,
  resource: DataInstanceFacts
): Promise<WhoHasAccess> {
  const transport = sparqlTransportFor(ctx)
  const authorizationIris = await listContained(
    transport,
    ctx.registrySet.hasAuthorizationRegistry.id
  )
  const authorizations = await Promise.all(
    authorizationIris.map((iri) => getDataAuthorization(transport, iri))
  )
  // roles carry the membership the scope rule needs (`AllFromRole` coverage,
  // role grantees of any scope)
  const roleIris = ctx.registrySet.hasRoleRegistry?.id
    ? await listContained(transport, ctx.registrySet.hasRoleRegistry.id)
    : []
  const roles = (await Promise.all(roleIris.map((iri) => getRole(transport, iri)))).filter(
    (role): role is RoleData => Boolean(role)
  )
  const access = whoHasAccessMatching(authorizations, resource, ctx.webId, roles)
  const registered = new Set(
    (await listSocialAgentRegistrations(ctx)).map((registration) => registration.registeredAgent)
  )
  return {
    agents: access.agents.filter(({ agent }) => registered.has(agent)),
    roles: access.roles,
  }
}

/**
 * Org-context data-instance read: the instance (+ its registration) are
 * peer data — the admin's session holds no grants on the peer's server, so
 * both docs are fetched with the context's storage fetch (the org's
 * with the org's session) and framed from the fetched docs. Shape trees
 * are public and stay on the admin-session factory. JSON-LD only: blob
 * instances are out of scope (their description-resource HEAD is not
 * proxied).
 */
async function orgContextDataInstance(
  ctx: ResolvedContext,
  iri: string,
  lang: string
): Promise<DataInstanceData> {
  // peer data: the instance lives on the peer's server, outside the context's
  // endpoint allowlist — resolve its registration from the grants the context
  // holds, asking the peer which registration contains the instance
  const located = await peerRegistrationOfInstance(ctx, iri)
  const registrationIri = (await containingContainer(ctx, iri)) ?? located?.id
  if (!registrationIri) {
    throw new Error(`cannot resolve the data registration of ${iri}`)
  }
  // the grant scopes a peer read; an org-own registration lives on the
  // context's own pod (read with the admin's own `scope: admin`)
  const storage = located?.storage ?? ownStorageOf(ctx, registrationIri) ?? registrationIri
  const registration = await DataRegistration.fromJsonLd(
    await fetchPeerDocument(ctx, storage, registrationIri),
    registrationIri
  )
  const shapeTree = await loadShapeTree(registration.registeredShapeTree, ctx.session.fetch)
  const node = await peerInstanceNode(ctx, storage, iri, shapeTree)
  return {
    id: iri,
    shapeTreeIri: registration.registeredShapeTree,
    label: labelFromNode(node),
    isBlob: isBlob(shapeTree),
    dataRegistration: registration,
    children: await computeChildren(node, shapeTree, ctx.session.fetch, lang),
  }
}

export const getResource = async (ctx: ResolvedContext, id: string, lang: string) => {
  // personal: the single-server session reads the resource directly and its
  // own response carries the parent (`Link: rel="up"`, LWS §Containment)
  // org: the admin's session holds no grants on the org's data pods — the
  // context plane resolves the registration and the proxy fetches the content
  const resource = await (ctx.webId === ctx.userWebId
    ? loadDataInstance(id, ctx.session.fetch, undefined, lang)
    : orgContextDataInstance(ctx, id, lang))
  if (!resource) {
    throw new Error(`Resource not found: ${id}`)
  }
  const shapeTree = await loadShapeTree(resource.shapeTreeIri!, ctx.session.fetch)
  const shapeTreeDescription = await ShapeTree.getDescription(shapeTree, lang, ctx.session.fetch)
  // "who has access" is read via SPARQL in both contexts — personal via
  // the session's internal endpoint, org via `/sparql-admin`
  // (`sparqlTransportFor`). Direct agent grantees and role grantees are
  // reported separately: an agent can be in both (a direct authorization AND
  // a granted role it is a member of).
  const access = await orgWhoHasAccess(ctx, resource)
  return Resource.make({
    id: IRI.make(resource.id),
    label: resource.label,
    shapeTree: {
      id: IRI.make(resource.shapeTreeIri!),
      label: pickLanguage(shapeTreeDescription?.label, lang),
    },
    accessGrantedTo: access.agents.map(({ agent }) => IRI.make(agent)),
    accessGrantedViaRoles: access.roles.map(({ role, label, members }) => ({
      role: IRI.make(role),
      label: pickLanguage(label, lang) ?? role,
      members: members.map((member) => IRI.make(member)),
    })),
    children: resource.children.map((child) => ({
      shapeTree: {
        id: IRI.make(child.shapeTree.id),
        label: child.shapeTree.label,
      },
      count: child.count,
    })),
  })
}

/**
 * The context's facts for a share build on a data plane the admin's session
 * can not read: the admin holds no grants on the org's data pods (isolation),
 * so the instance's registration (from `lws:partOf`), the child registrations
 * and the existing access are read through the context's `/sparql-admin`
 * plane and handed to `buildShareDataAuthorizations`.
 *
 * `agentsWithAccess` is the same set the session-side build computes: direct
 * grantees the context holds a registration for, plus the expanded members of
 * granted roles (a role grant is materialized as one grant per member).
 */
async function orgShareFacts(
  ctx: ResolvedContext,
  structure: ShareDataInstanceStructure
): Promise<ShareContextFacts> {
  const registrationIri = await containingContainer(ctx, structure.resource)
  if (!registrationIri) {
    throw new Error(`cannot resolve the data registration of ${structure.resource}`)
  }
  const podUrl = contextPod(ctx, registrationIri)
  if (!podUrl) {
    throw new Error(`cannot read the data pod of ${registrationIri}`)
  }
  const dataRegistration = await getDataRegistration(
    sparqlTransportForPod(ctx, podUrl),
    registrationIri
  )

  // child registrations live in the same data registry (`lws:partOf`): one
  // listing query for the requested shape trees, then one graph read each
  const registrations = new Map<string, DataRegistrationData>()
  const shapeTrees = [...new Set(structure.children.map(({ shapeTree }) => shapeTree))]
  if (shapeTrees.length > 0) {
    const dataRegistryIri = dataRegistration.partOf
    if (!dataRegistryIri) {
      throw new Error(
        `data registration ${dataRegistration.id} has no containing data registry (lws:partOf)`
      )
    }
    const transport = sparqlTransportForPod(ctx, contextPod(ctx, dataRegistryIri) ?? podUrl)
    for (const iri of await listRegistrationsByShapeTrees(transport, dataRegistryIri, shapeTrees)) {
      const registration = await getDataRegistration(transport, iri)
      if (!registrations.has(registration.registeredShapeTree)) {
        registrations.set(registration.registeredShapeTree, registration)
      }
    }
  }

  const dataInstance: DataInstanceFacts = {
    id: structure.resource,
    shapeTreeIri: dataRegistration.registeredShapeTree,
    dataRegistration,
  }
  const access = await orgWhoHasAccess(ctx, dataInstance)
  return {
    dataInstance,
    registrations,
    agentsWithAccess: new Set([
      ...access.agents.map(({ agent }) => agent),
      ...access.roles.flatMap(({ members }) => members),
    ]),
  }
}

/**
 * The read side of a share build, chosen per context: the personal context's
 * session reads its own pods, so it needs no facts; an org context does (see
 * `orgShareFacts`).
 */
export async function shareContextFacts(
  ctx: ResolvedContext,
  structure: ShareDataInstanceStructure
): Promise<ShareContextFacts | undefined> {
  return ctx.webId === ctx.userWebId ? undefined : orgShareFacts(ctx, structure)
}

export const shareResource = async (
  ctx: ResolvedContext,
  shareAuthorization: S.Schema.Type<typeof ShareAuthorization>
): Promise<S.Schema.Type<typeof ShareAuthorizationConfirmation>> => {
  // the RPC shape is structurally identical to the AA's domain structure —
  // explicit field copies (kills the previous `as unknown as` cast)
  const structure: ShareDataInstanceStructure = {
    applicationId: shareAuthorization.applicationId,
    resource: shareAuthorization.resource,
    agents: [...shareAuthorization.agents],
    accessMode: [...shareAuthorization.accessMode],
    children: shareAuthorization.children.map((child) => ({
      shapeTree: child.shapeTree,
      accessMode: [...child.accessMode],
    })),
  }
  // activity-first (step 3 + refinement §5.1): build the
  // DataAuthorizations-to-be WITHOUT writing — ids PRE-MINTED by the AA
  // (`buildShareDataAuthorizations`); write ONE `AuthorizationGranted` for
  // ALL grantees (grantee rides every DA). The `processAuthorizationGranted`
  // parent groups by grantee and fans out one child workflow per grantee
  // (Temporal owns retry/resume per child); the RPC only writes the single
  // activity — no synchronous mutation.
  //
  // the build's read side is context-dependent: an org admin's session holds
  // no grants on the org's data pods, so the org context pre-reads them
  // through `/sparql-admin` (`facts`); the personal context reads its own pods
  const facts = await shareContextFacts(ctx, structure)
  const recorded = await ctx.session.buildShareDataAuthorizations(
    structure,
    ctx.webId,
    ctx.registrySet,
    facts
  )

  const clientIdDocument = await loadClientIdDocument(
    shareAuthorization.applicationId,
    ctx.session.fetch
  )

  // nothing to grant (owner-only / all already-have-access) → no activity,
  // matching the previous per-grantee empty-loop behavior
  if (recorded.length > 0) {
    const activityRegistry = ctx.registrySet.hasActivityRegistry
    if (!activityRegistry) {
      throw new Error('activity registry not found in registry set')
    }
    const activity: Omit<AuthorizationGranted, 'id'> = {
      type: ['Activity', 'AuthorizationGranted'],
      actor: ctx.webId,
      target: ctx.registrySet.hasAuthorizationRegistry.id,
      object: recorded,
      createdAt: new Date().toISOString(),
    }
    await ActivityRegistry.createActivity(
      activityRegistry,
      {
        fetch: ctx.session.fetch,
        randomUUID: ctx.session.randomUUID,
        identifierStrategies: ctx.session.identifierStrategies,
      },
      activity
    )
  }

  return {
    callbackEndpoint: clientIdDocument.callbackEndpoint!,
  }
}

/**
 * Write the `NeedBasedAccessRequestSent` activity (activity-first,
 * authorization-granting.md §6.4) — the converged producer for BOTH RPC
 * variants. The requester mints NO real id (no AccessRequestRegistry) — the
 * object rides as a **urn:uuid snapshot**; the requester-side workflow
 * forwards the request to the data owner's access request endpoint and
 * completes. The pending ack echoes the activity id (the uniform UI claim
 * anchor — the `InvitationAcceptedMessage` shape).
 */
async function recordAccessRequest(
  ctx: ResolvedContext,
  request: { dataOwner: string; hasAccessNeedGroup: NeedBasedAccessRequestGroup }
): Promise<S.Schema.Type<typeof NeedBasedAccessRequestSentMessage>> {
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) {
    throw new Error('activity registry not found in registry set')
  }
  const object: EmbeddedNeedBasedAccessRequest = {
    id: `urn:uuid:${ctx.session.randomUUID()}`,
    type: [INTEROP.NeedBasedAccessRequest],
    grantee: ctx.webId,
    grantedBy: ctx.webId,
    dataOwner: request.dataOwner,
    hasAccessNeedGroup: request.hasAccessNeedGroup,
  }
  const activity: Omit<NeedBasedAccessRequestSent, 'id'> = {
    type: ['Activity', 'NeedBasedAccessRequestSent'],
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
  return NeedBasedAccessRequestSentMessage.make({
    accepted: true,
    activityId: IRI.make(created.id),
  })
}

/**
 * The applicationId variant (kept for dev-env MANUAL testing, §6.4 — the
 * automated test uses the access-needs variant): the service method EXTRACTS
 * the access need group from the application's client-id document;
 * `dataOwner` = the `webId` argument. The embedded group is minimal (id +
 * type) — the full framed embedding rides the access-needs variant and the
 * follow-up RPC (whole group + descriptions).
 */
/** Composed `AccessNeedData` → the embedded node shape (recursive). */
function needToEmbedded(need: AccessNeedData): Record<string, unknown> {
  return {
    id: need.id,
    type: need.type,
    registeredShapeTree: need.registeredShapeTree,
    required: need.required ? INTEROP.AccessRequired : INTEROP.AccessOptional,
    accessMode: need.accessMode,
    ...(need.hasDataInstance?.length ? { hasDataInstance: need.hasDataInstance } : {}),
    ...(need.hasDataRegistration ? { hasDataRegistration: need.hasDataRegistration } : {}),
    hasInheritingNeed: need.children.map(needToEmbedded),
  }
}

/**
 * The applicationId variant (kept for dev-env MANUAL testing, §6.4): the
 * service method EXTRACTS the access needs — resolves the full framed group
 * from the application's client-id document (the same embedded shape the
 * access-needs variant carries) so the downstream activity + approval
 * behave identically; `dataOwner` = the `webId` argument.
 */
export async function requestAccessUsingApplicationNeeds(
  ctx: ResolvedContext,
  applicationIri: string,
  webId: string
): Promise<S.Schema.Type<typeof NeedBasedAccessRequestSentMessage>> {
  const clientIdDocument = await loadClientIdDocument(applicationIri, ctx.session.fetch)
  if (!clientIdDocument.hasAccessNeedGroup) {
    throw new Error('application client-id document has no access need group')
  }
  const group: AccessNeedGroupData = await resolveAccessNeedGroup(
    clientIdDocument.hasAccessNeedGroup,
    ctx.session.fetch
  )
  const embedded: NeedBasedAccessRequestGroup = {
    id: group.id,
    type: group.type,
    hasAccessNeed: group.accessNeeds.map(needToEmbedded),
  }
  return recordAccessRequest(ctx, { dataOwner: webId, hasAccessNeedGroup: embedded })
}

/** The access-needs variant (the tested path, §6.4): the access need group
 *  rides the RPC message (embedded, framed — (expanded-form) IRIs inside);
 *  `grantee = grantedBy = ctx.webId` derived server-side. */
export async function requestAccessUsingAccessNeeds(
  ctx: ResolvedContext,
  dataOwner: string,
  hasAccessNeedGroup: unknown
): Promise<S.Schema.Type<typeof NeedBasedAccessRequestSentMessage>> {
  return recordAccessRequest(ctx, {
    dataOwner,
    hasAccessNeedGroup: hasAccessNeedGroup as NeedBasedAccessRequestGroup,
  })
}
