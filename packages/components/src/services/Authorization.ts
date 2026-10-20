import type {
  AuthorizationStructure,
  DataAuthorizationStructure,
} from '@janeirodigital/interop-authorization-agent'
import {
  AccessNeedGroup as AccessNeedGroupModule,
  AccessNeed as AccessNeedModule,
  ActivityRegistry,
  buildNestedDataAuthorizations,
  generateDataAuthorizations,
  getOpenSentAccessRequests,
  accessNeedGroup as resolveAccessNeedGroup,
} from '@janeirodigital/interop-authorization-agent'
import {
  type AccessNeedData,
  type AccessNeedGroupData,
  AccessRequest,
  type AccessRequestArchived,
  type AuthorizationDenied,
  type AuthorizationGranted,
  ClientIdDocument,
  type EmbeddedAuthorization,
  type GrantData,
  type NeedBasedAccessRequestGroup,
  ShapeTree,
} from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)
const loadClientIdDocument = loader(ClientIdDocument.fromJsonLd)
const loadNeedBasedAccessRequest = loader(AccessRequest.fromJsonLd)

import { INTEROP, type WhatwgFetch, loader, pickLanguage } from '@janeirodigital/interop-utils'
import {
  AccessNeed,
  AccessRequestArchivedMessage,
  type Authorization,
  type AuthorizationData,
  AuthorizationGrantedMessage,
  IRI,
} from '@janeirodigital/sai-api-messages'
import type { Brand } from 'effect/Brand'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import { dataRegistrationContains } from './peerProxy.js'
import {
  getDataGrant as getDataGrantFromSparql,
  getDataRegistration as getDataRegistrationFromSparql,
  getSocialAgentRegistration as getRegistrationFromSparql,
  listRegistrationsByShapeTrees,
  sparqlTransportFor,
  sparqlTransportForPod,
} from './queries/org.js'
import { listSocialAgentRegistrations } from './SocialAgentRegistry.js'

const formatAccessNeed = async (
  accessNeed: AccessNeedData,
  descriptionsLang: string,
  fetch: WhatwgFetch
): Promise<S.Schema.Type<typeof AccessNeed>> => {
  // tolerant — an embedded request's needs carry urn:uuid ids with NO
  // description documents (descriptions are the follow-up); the shape trees
  // are real IRIs and always resolve
  const description = await AccessNeedModule.getDescription(
    accessNeed,
    descriptionsLang,
    fetch
  ).catch((): undefined => undefined)
  const shapeTree = await loadShapeTree(accessNeed.registeredShapeTree, fetch)
  const shapeTreeDescription = await ShapeTree.getDescription(shapeTree, descriptionsLang, fetch)

  return AccessNeed.make({
    id: IRI.make(accessNeed.id),
    // the description labels are language maps — picked for the requested language
    label: pickLanguage(description?.label, descriptionsLang) ?? '',
    description: pickLanguage(description?.definition, descriptionsLang),
    required: accessNeed.required,
    access: accessNeed.accessMode.map((mode) => IRI.make(mode)),
    shapeTree: {
      id: IRI.make(accessNeed.registeredShapeTree),
      label: pickLanguage(shapeTreeDescription.label, descriptionsLang) ?? '',
    },
    parent: accessNeed.inheritsFromNeed ? IRI.make(accessNeed.inheritsFromNeed) : undefined,
    children: accessNeed.children
      ? await Promise.all(
          accessNeed.children.map((child) => formatAccessNeed(child, descriptionsLang, fetch))
        )
      : undefined,
  })
}

async function findUserDataRegistrations(
  ctx: ResolvedContext,
  accessNeedGroup: AccessNeedGroupData
) {
  const dataRegistrations = []
  // only the shape trees the access need group asks for — the SPARQL read
  // filters on the registration meta graphs (`registeredShapeTree`), so
  // non-matching registrations are never listed nor probed
  const shapeTrees = [
    ...new Set(accessNeedGroup.accessNeeds.map((accessNeed) => accessNeed.registeredShapeTree)),
  ]
  // iterate the context's pods from the internal account storage (the
  // allowlist) — not `registrySet.hasDataRegistry`. The registry pod yields no
  // data registrations; each data pod yields its own.
  for (const podUrl of ctx.endpoints.keys()) {
    const transport = sparqlTransportForPod(ctx, podUrl)
    const iris = await listRegistrationsByShapeTrees(transport, podUrl, shapeTrees)
    const registrations = await Promise.all(
      iris.map((iri) => getDataRegistrationFromSparql(transport, iri))
    )
    for (const accessNeed of accessNeedGroup.accessNeeds) {
      for (const dataRegistration of registrations) {
        if (dataRegistration.registeredShapeTree !== accessNeed.registeredShapeTree) continue
        dataRegistrations.push({
          id: IRI.make(dataRegistration.id),
          dataRegistry: IRI.make(podUrl),
          label: `${dataRegistration.id.split('/').slice(0, 4).join('/')}/`, // TODO get proper label,
          shapeTree: accessNeed.registeredShapeTree,
          count: dataRegistration.contains.length,
        })
        break
      }
    }
  }
  return dataRegistrations
}

async function findSocialAgentDataRegistrations(
  dataGrants: GrantData[],
  accessNeedGroup: AccessNeedGroupData,
  ctx: ResolvedContext
) {
  const dataRegistrations = []
  for (const dataGrant of dataGrants) {
    for (const accessNeed of accessNeedGroup.accessNeeds) {
      if (
        dataGrant.registeredShapeTree === accessNeed.registeredShapeTree &&
        dataGrant.scopeOfGrant !== INTEROP.Inherited // TODO clarify case when this could happen
      ) {
        dataRegistrations.push({
          id: IRI.make(dataGrant.hasDataRegistration),
          label: `${dataGrant.hasDataRegistration.split('/').slice(0, 4).join('/')}/`, // TODO get proper label
          shapeTree: accessNeed.registeredShapeTree,
          // scopeOfGrant is the discriminator — `hasDataInstance` is only
          // set on SelectedFromRegistry grants (empty [] otherwise, which is
          // truthy and used to make the AllFromRegistry count silently 0).
          count:
            dataGrant.scopeOfGrant === INTEROP.SelectedFromRegistry
              ? (dataGrant.hasDataInstance?.length ?? 0)
              : (await dataRegistrationContains(ctx, dataGrant.hasDataRegistration)).length,
        })
      }
    }
  }
  return dataRegistrations
}

/**
 * Get the descriptions for the requested language. If the descriptions for the language are not found
 * `null` will be returned.
 * @param applicationIri application's profile document IRI
 * @param preferredLang XSD language requested, e.g.: "en", "es", "i-navajo".
 * @param saiSession Authoirization Agent from `@janeirodigital/interop-authorization-agent`
 */

/** Embedded need node → the composed-read `AccessNeedData` (recursive). */
function accessNeedFromEmbedded(node: Record<string, unknown>, parentId?: string): AccessNeedData {
  const children = ((node.hasInheritingNeed as Record<string, unknown>[] | undefined) ?? []).map(
    (child) => accessNeedFromEmbedded(child, node.id as string)
  )
  return {
    id: node.id as string,
    type: (node.type as string[] | undefined) ?? [],
    registeredShapeTree: node.registeredShapeTree as string,
    inheritsFromNeed: parentId,
    hasInheritingNeed: children.map((child) => child.id),
    accessMode: (node.accessMode as string[]) ?? [],
    required: node.required === INTEROP.AccessRequired,
    children,
    descriptionLanguages: [],
  }
}

/** The embedded group of the request → `AccessNeedGroupData` — NO re-fetch
 *  (the group's urn:uuid ids resolve nowhere; descriptions follow-up). */
function accessNeedGroupFromEmbedded(group: NeedBasedAccessRequestGroup): AccessNeedGroupData {
  const accessNeeds = ((group.hasAccessNeed as unknown as Record<string, unknown>[]) ?? []).map(
    (need) => accessNeedFromEmbedded(need)
  )
  return {
    id: group.id,
    type: group.type,
    hasAccessNeed: accessNeeds.map((need) => need.id),
    accessNeeds,
  }
}

export const getDescriptions = async (
  ctx: ResolvedContext,
  agentIri: string,
  preferredLang: string,
  accessNeedGroupIri?: string & Brand<'IRI'>,
  accessRequestIri?: string
): Promise<S.Schema.Type<typeof AuthorizationData>> => {
  // the approval path (authorization-granting.md §6.8): the access need
  // group comes from the EMBEDDED copy in the request — no client-id doc,
  // no reciprocal registration, no group re-fetch
  let fromRequest = false
  let accessNeedGroupIriResolved: string
  const transport = sparqlTransportFor(ctx)
  if (accessRequestIri) {
    fromRequest = true
  } else if (accessNeedGroupIri) {
    accessNeedGroupIriResolved = accessNeedGroupIri
  } else {
    // no request and no explicit group: the only implicit group source is an
    // application's client-id document — content probe (the grantee kind no
    // longer rides the wire, anti-spoofing): a document that frames
    // `hasAccessNeedGroup` supplies the group; anything else must pass it
    // explicitly (access need groups on registrations are retired)
    const clientIdDocument = await loadClientIdDocument(agentIri, ctx.session.fetch)
    if (!clientIdDocument.hasAccessNeedGroup) return null
    accessNeedGroupIriResolved = clientIdDocument.hasAccessNeedGroup
  }

  const accessNeedGroup = fromRequest
    ? accessNeedGroupFromEmbedded(
        (await loadNeedBasedAccessRequest(accessRequestIri, ctx.session.fetch)).hasAccessNeedGroup
      )
    : await resolveAccessNeedGroup(accessNeedGroupIriResolved, ctx.session.fetch, preferredLang)

  const dataOwners: {
    id: string & Brand<'IRI'>
    label: string
    dataRegistrations: {
      id: string & Brand<'IRI'>
      dataRegistry?: string & Brand<'IRI'>
      label: string
      shapeTree: string
      count: number
    }[]
  }[] = [
    {
      id: IRI.make(ctx.webId),
      label: ctx.webId, // TODO get from user's webid document
      dataRegistrations: await findUserDataRegistrations(ctx, accessNeedGroup),
    },
  ]

  for (const socialAgentRegistration of await listSocialAgentRegistrations(ctx)) {
    if (socialAgentRegistration.reciprocalRegistration) {
      const reciprocalRegistration = await getRegistrationFromSparql(
        transport,
        socialAgentRegistration.reciprocalRegistration
      )
      const dataGrants = await Promise.all(
        reciprocalRegistration.hasDataGrant.map((grantIri) =>
          getDataGrantFromSparql(transport, grantIri)
        )
      )
      const dataRegistrations = await findSocialAgentDataRegistrations(
        dataGrants,
        accessNeedGroup,
        ctx
      )
      if (dataRegistrations.length) {
        dataOwners.push({
          id: IRI.make(socialAgentRegistration.registeredAgent),
          // the stored label is a language map — picked for the requested language
          label: pickLanguage(socialAgentRegistration.label, preferredLang) ?? '',
          dataRegistrations,
        })
      }
    }
  }
  const descriptionLanguages = [
    ...(await AccessNeedGroupModule.reliableDescriptionLanguages(
      accessNeedGroup,
      ctx.session.fetch
    )),
  ]
  const reliableDescriptionLanguages = await AccessNeedGroupModule.reliableDescriptionLanguages(
    accessNeedGroup,
    ctx.session.fetch
  )
  const descriptionsLang = fromRequest
    ? // the embedded group has no description sets — the screen renders with
      // the shape-tree labels only (descriptions follow-up); the requested
      // language still drives those lookups
      preferredLang
    : reliableDescriptionLanguages.has(preferredLang)
      ? preferredLang
      : descriptionLanguages[0]
  const descriptions = fromRequest
    ? undefined
    : await AccessNeedGroupModule.getDescription(
        accessNeedGroup,
        descriptionsLang,
        ctx.session.fetch
      )

  return {
    // TODO if the id is the unique id of something then it should not be its own id. It should refer by a different name,
    //      e.g.: applicationId and be documented as such
    id: IRI.make(agentIri), // TODO change to agentID
    accessNeedGroup: {
      id: IRI.make(accessNeedGroup.id),
      label: pickLanguage(descriptions?.label, preferredLang) ?? '',
      description: pickLanguage(descriptions?.definition, preferredLang),
      needs: await Promise.all(
        accessNeedGroup.accessNeeds.map((need) =>
          formatAccessNeed(need, descriptionsLang, ctx.session.fetch)
        )
      ),
      descriptionLanguages,
      lang: descriptionsLang,
    },
    dataOwners,
  }
}

export const recordAuthorization = async (
  ctx: ResolvedContext,
  authorization: S.Schema.Type<typeof Authorization>,
  accessRequestIri?: string
): Promise<S.Schema.Type<typeof AuthorizationGrantedMessage>> => {
  // thin adapter: the RPC shape → the AA's AuthorizationStructure (field
  // copies); the SAI rules (scope mapping, dataOwner assignment, inheritance
  // wiring, ensure-Application-Registration) live in the AA — called from the
  // service to BUILD the carrier and from the workflow to MATERIALIZE.
  const structure: AuthorizationStructure = {
    grantee: authorization.grantee,
    hasAccessNeedGroup: authorization.accessNeedGroup,
    granted: authorization.granted,
    dataAuthorizations: authorization.granted
      ? (authorization.dataAuthorizations.map((dataAuthorization) => ({
          accessNeed: dataAuthorization.accessNeed,
          // adapter maps the RPC short scope name to the interop IRI
          scopeOfAuthorization: INTEROP[dataAuthorization.scope],
          dataOwner: dataAuthorization.dataOwner,
          hasDataRegistration: dataAuthorization.dataRegistration,
          hasDataInstance: dataAuthorization.dataInstances
            ? [...dataAuthorization.dataInstances]
            : undefined,
        })) satisfies DataAuthorizationStructure[])
      : undefined,
  }
  // the approval path (§6.8): the group comes from the EMBEDDED copy in the
  // request (urn:uuid ids resolve nowhere) — injected instead of fetched
  const accessNeedGroupData = accessRequestIri
    ? accessNeedGroupFromEmbedded(
        (await loadNeedBasedAccessRequest(accessRequestIri, ctx.session.fetch)).hasAccessNeedGroup
      )
    : undefined

  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')

  // the deny snapshot carrier (no DataAuthorization is created — grantee rides
  // here; term-covered subset). Written as the `AuthorizationDenied` activity
  // (Step 4 — pure decline: no delete, no grant clear).
  const snapshot = (): EmbeddedAuthorization => ({
    id: `urn:uuid:${ctx.session.randomUUID()}`,
    type: [INTEROP.AuthorizationStructure],
    grantee: authorization.grantee,
    hasAccessNeedGroup: authorization.accessNeedGroup,
  })

  if (structure.granted) {
    // activity-first (step 2 — the architecture pivot): pre-mint the
    // DataAuthorization id(s) (AA `generateDataAuthorizations` — the same rule
    // the synchronous path used) and embed the POJOs as the activity object;
    // the dedicated `processAuthorizationGranted` workflow PUTs them at those
    // ids (find-first) and regenerates grants. The RPC only writes the
    // activity — no synchronous mutation.
    const group =
      accessNeedGroupData ??
      (await resolveAccessNeedGroup(structure.hasAccessNeedGroup!, ctx.session.fetch))
    const nested = buildNestedDataAuthorizations(structure, group, ctx.webId)
    const dataAuthorizations = await generateDataAuthorizations(
      nested,
      ctx.webId,
      ctx.registrySet.hasAuthorizationRegistry,
      { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID }
    )
    const activity: Omit<AuthorizationGranted, 'id'> = {
      type: ['Activity', 'AuthorizationGranted'],
      actor: ctx.webId,
      target: ctx.registrySet.hasAuthorizationRegistry.id,
      // the owner-span close (see the OpenWiki `services/activity-lifecycle.md`): the flat
      // activity-level back-link — absent on direct approvals without a request
      ...(accessRequestIri ? { satisfiesAccessRequest: accessRequestIri } : {}),
      // always the array (possibly [] — an all-filtered/self-grant writes no
      // DAs; the child workflow skips empty groups). Declines are
      // `AuthorizationDenied` (Step 4) — never a snapshot here.
      object: dataAuthorizations,
      createdAt: new Date().toISOString(),
    }
    const created = await ActivityRegistry.createActivity(
      activityRegistry,
      { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID },
      activity
    )
    // pending ack — the pre-minted DataAuthorization ids (pending handles) +
    // the triggering activity id (the uniform UI claim anchor)
    return AuthorizationGrantedMessage.make({
      ids: dataAuthorizations.map((dataAuthorization) => IRI.make(dataAuthorization.id)),
      activityId: IRI.make(created.id),
    })
  }

  // declined (Step 4): a PURE decline — `AuthorizationDenied`, forward-only,
  // no DataAuthorization delete, no grant clear, no workflow (the accidental
  // delete behavior is the revocation plan's revoke action).
  const activity: Omit<AuthorizationDenied, 'id'> = {
    type: ['Activity', 'AuthorizationDenied'],
    actor: ctx.webId,
    // the owner-span close (see the OpenWiki `services/activity-lifecycle.md`): the flat
    // activity-level back-link — absent on direct declines without a request
    ...(accessRequestIri ? { satisfiesAccessRequest: accessRequestIri } : {}),
    object: snapshot(),
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID },
    activity
  )
  return AuthorizationGrantedMessage.make({ ids: [], activityId: IRI.make(created.id) })
}

/**
 * Archive an OPEN outgoing need-based access request
 * (see the OpenWiki `services/activity-lifecycle.md`): the requester closes the span — the
 * request leaves `accessRequestsSent` on the next refresh. The `request`
 * arg is the SNAPSHOT id (urn:uuid — the stable profile entry). The
 * open-set query doubles as the ownership check: the snapshot must appear
 * in THIS agent's open sent set (its registry is only queryable through
 * the context's own transport) AND belong to it (`grantedBy` — requests
 * sent by this agent always carry `grantedBy === ctx.webId`).
 *
 * TERMINAL resolution — direct write, no workflow, no `ActivityCompleted`;
 * the double-resolution no-op (the granted ∧ archived race): a snapshot
 * that is unknown or already resolved writes nothing and acks
 * `archived: false` — the UI refreshes either way.
 */
export async function archiveAccessRequest(
  ctx: ResolvedContext,
  request: string
): Promise<S.Schema.Type<typeof AccessRequestArchivedMessage>> {
  const transport = sparqlTransportFor(ctx)
  const open = await getOpenSentAccessRequests(transport)
  const target = open.find((r) => r.request === request)
  if (!target || target.grantedBy !== ctx.webId) {
    return AccessRequestArchivedMessage.make({ archived: false })
  }
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')
  const activity: Omit<AccessRequestArchived, 'id'> = {
    type: ['Activity', 'AccessRequestArchived'],
    actor: ctx.webId,
    // the light ref — the Sent activity's SNAPSHOT id (the open-set query
    // joins `outcome.object.id → sent.object.id`)
    object: { id: request, type: [INTEROP.NeedBasedAccessRequest] },
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID },
    activity
  )
  return AccessRequestArchivedMessage.make({
    archived: true,
    activityId: IRI.make(created.id),
  })
}
