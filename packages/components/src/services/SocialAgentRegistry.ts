import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import {
  type InvitationAccepted,
  type SocialAgentRegistrationData,
  WebIdProfile,
  getAdminGrantIris,
  getDataGrantIris,
} from '@janeirodigital/interop-data-model'
const loadWebIdProfile = loader(WebIdProfile.fromJsonLd)

import { INTEROP, loader, pickLanguage } from '@janeirodigital/interop-utils'
import { IRI, InvitationAcceptedMessage, SocialAgent } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import {
  findSocialAgentRegistration as findRegistrationFromSparql,
  getDataGrant as getDataGrantFromSparql,
  getOpenAccessRequestsOnRegistry,
  getOpenSentAccessRequests,
  getSocialAgentRegistration as getRegistrationFromSparql,
  listContained,
  sparqlTransportFor,
} from './queries/org.js'

/**
 * Resolve the reciprocal registration of `registration` (the peer's
 * registration of us / of the org) via SPARQL — personal context hits the
 * session's internal endpoint, org context the org's `/sparql-admin`
 * (`sparqlTransportFor`). The peer's graphs live in the shared store
 * (openwiki/architecture/federation.md shortcut 1); their `.acr`s grant the org/registered agent,
 * never the admin.
 */
async function getReciprocalRegistration(
  ctx: ResolvedContext,
  registration: SocialAgentRegistrationData
): Promise<SocialAgentRegistrationData> {
  if (!registration.reciprocalRegistration) {
    throw new Error(`no reciprocal registration on ${registration.id}`)
  }
  return getRegistrationFromSparql(sparqlTransportFor(ctx), registration.reciprocalRegistration)
}

/**
 * The social-agent registrations of the *context* social-agent registry, via
 * SPARQL over its server-managed `ldp:contains` listing: personal context
 * reads the session's internal endpoint, org context the org's
 * `/sparql-admin` (`sparqlTransportFor`). Seeded registration resources
 * carry own `.acr`s that never grant the admin (registered-agent/org only,
 * org-context-sparql.md §3.0/3b), so HTTP reads 403 for them — SPARQL
 * sidesteps dereferencing entirely.
 */
async function listSocialAgentRegistrations(
  ctx: ResolvedContext
): Promise<SocialAgentRegistrationData[]> {
  const transport = sparqlTransportFor(ctx)
  const iris = await listContained(transport, ctx.registrySet.hasSocialAgentRegistry.id)
  return Promise.all(iris.map((iri) => getRegistrationFromSparql(transport, iri)))
}

export { listSocialAgentRegistrations }

/**
 * Find the context registry's registration of `webId` (match on
 * `registeredAgent`) via SPARQL — personal context hits the session's
 * internal endpoint, org context the org's `/sparql-admin` (see
 * `listSocialAgentRegistrations`).
 */
export const findSocialAgentRegistrationInContext = async (
  ctx: ResolvedContext,
  webId: string
): Promise<SocialAgentRegistrationData | undefined> => {
  return findRegistrationFromSparql(
    sparqlTransportFor(ctx),
    ctx.registrySet.hasSocialAgentRegistry.id,
    webId
  )
}

/** The owner's OPEN access requests keyed by grantee — the approval entries
 *  (see the OpenWiki `services/activity-lifecycle.md` — the request IRIs open the
 *  authorization screen). */
export type AccessRequestsByGrantee = Map<string, string[]>

/** The requester's OPEN sent requests keyed by dataOwner — the archive
 *  targets (see the OpenWiki `services/activity-lifecycle.md` — the snapshot ids). */
export type SentAccessRequestsByDataOwner = Map<string, string[]>

/**
 * Build the UI profile of a social agent from its registration.
 *
 * Two distinct admin markers (§2.2 asymmetry + Phase 5 of
 * org-admin-feature.md):
 * - `admin` — the DIRECT marker: the context's registration of the agent
 *   carries a non-empty `hasAdminGrant` — the agent administers the current
 *   context's registry set. Read from the org's registration of the agent in
 *   an org context, from the signed-in user's OWN registration of the agent
 *   in the personal context (Phase 5 — a regular user promotes/demotes their
 *   own admins, so the direct marker is the toggle-admin state everywhere);
 * - `adminOf` — the RECIPROCAL marker: the agent's registration of the user
 *   (reached via `reciprocalRegistration`) carries a non-empty
 *   `hasAdminGrant` — the signed-in user is an admin of the agent. Only
 *   meaningful in the personal context; the context switcher source.
 */
export const buildSocialAgentProfile = async (
  registration: SocialAgentRegistrationData,
  ctx: ResolvedContext,
  personal = true,
  lang = '',
  accessRequestsByGrantee: AccessRequestsByGrantee = new Map(),
  sentAccessRequestsByDataOwner: SentAccessRequestsByDataOwner = new Map()
) => {
  const reciprocal = registration.reciprocalRegistration
    ? await getReciprocalRegistration(ctx, registration)
    : undefined
  // Phase 5: the direct marker is read the same way in BOTH contexts — from
  // the context's registration of the agent (org: the org's registration;
  // personal: the user's own registration — the owner's admins)
  const admin = getAdminGrantIris(registration).length > 0
  // the reciprocal marker — the agent's registration of the user (the
  // "orgs I administer" discovery flag; the switcher source, §2.2)
  const adminOf = reciprocal ? getAdminGrantIris(reciprocal).length > 0 : false

  // TODO (angel) data validation and how to handle when the social agents profile is missing some components?
  return SocialAgent.make({
    id: IRI.make(registration.registeredAgent),
    // the stored label is a language map — surface the plain string for the
    // preferred language (untagged `@none` as the fallback)
    label: pickLanguage(registration.label, lang) ?? '',
    note: registration.note,
    //authorizationDate: registration.registeredAt!.toISOString(),
    //lastUpdateDate: registration.updatedAt?.toISOString(),
    // see the OpenWiki `services/activity-lifecycle.md` — the open-request collections:
    // incoming (owner side — approval entries) / outgoing (requester side —
    // archive targets); granted/denied/archived drop the entries, so these
    // finally clear (the "never clears" cause)
    accessRequestsReceived: (accessRequestsByGrantee.get(registration.registeredAgent) ?? []).map(
      (id) => IRI.make(id)
    ),
    accessRequestsSent: (sentAccessRequestsByDataOwner.get(registration.registeredAgent) ?? []).map(
      (id) => IRI.make(id)
    ),
    admin,
    adminOf,
    // the grantor-side registration's hasDataGrant: the grants WE issued to
    // this agent — first grant IRI; absent → the SocialAgentList warning badge
    accessGrant: getDataGrantIris(registration)[0],
  })
}

export const getSocialAgents = async (ctx: ResolvedContext, lang: string) => {
  const personal = ctx.webId === ctx.userWebId
  const transport = sparqlTransportFor(ctx)
  const registrations = await listSocialAgentRegistrations(ctx)

  // the owner's OPEN access requests (grantee → request IRIs) — the approval
  // entries (`accessRequestsReceived`, §6.8 — resolved requests excluded §3.1)
  const openAccessRequests = ctx.registrySet.hasAccessRequestRegistry
    ? await getOpenAccessRequestsOnRegistry(transport, ctx.registrySet.hasAccessRequestRegistry.id)
    : []
  const accessRequestsByGrantee: AccessRequestsByGrantee = new Map()
  for (const request of openAccessRequests) {
    const list = accessRequestsByGrantee.get(request.grantee) ?? []
    list.push(request.id)
    accessRequestsByGrantee.set(request.grantee, list)
  }

  // the requester's OPEN sent access requests (dataOwner → snapshot ids) —
  // the archive targets + the "request access" card gate. Only meaningful in
  // the personal context; org contexts don't send requests.
  const openSentAccessRequests =
    personal && ctx.registrySet.hasActivityRegistry
      ? await getOpenSentAccessRequests(transport)
      : []
  const sentAccessRequestsByDataOwner: SentAccessRequestsByDataOwner = new Map()
  for (const request of openSentAccessRequests) {
    const list = sentAccessRequestsByDataOwner.get(request.dataOwner) ?? []
    list.push(request.request)
    sentAccessRequestsByDataOwner.set(request.dataOwner, list)
  }

  const profiles = []
  for (const registration of registrations) {
    profiles.push(
      await buildSocialAgentProfile(
        registration,
        ctx,
        personal,
        lang,
        accessRequestsByGrantee,
        sentAccessRequestsByDataOwner
      )
    )
  }

  const seenIds = new Set(profiles.map((p) => p.id))
  for (const registration of registrations) {
    if (!registration.reciprocalRegistration) continue
    const reciprocalReg = await getRegistrationFromSparql(
      transport,
      registration.reciprocalRegistration
    )
    if (getDataGrantIris(reciprocalReg).length === 0) continue
    const dataGrants = await Promise.all(
      reciprocalReg.hasDataGrant.map((grantIri) => getDataGrantFromSparql(transport, grantIri))
    )
    for (const dataGrant of dataGrants) {
      const ownerIri = IRI.make(dataGrant.dataOwner)
      if (seenIds.has(ownerIri)) continue
      seenIds.add(ownerIri)
      let label = dataGrant.dataOwner
      try {
        const profile = await loadWebIdProfile(ownerIri, ctx.session.fetch)
        // the profile's label is a language map — picked for the requested
        // language; absent profile/label falls back to the owner IRI
        label = pickLanguage(profile.label, lang) ?? dataGrant.dataOwner
      } catch {
        /* fallback to IRI */
      }
      profiles.push(
        SocialAgent.make({
          id: ownerIri,
          label,
          // no registration in this registry — nothing to approve for, and
          // the owner-of-grants has no sent request from us here
          accessRequestsReceived: [],
          accessRequestsSent: [],
          // no registration in this registry — no admin marker can be read
          admin: false,
          adminOf: false,
        })
      )
    }
  }

  return profiles
}

/**
 * Record the acceptance and let the acceptor's own workflow perform the
 * cross-AA legs — the capabilityUrl is opaque here (see the OpenWiki
 * `temporal/workflows.md`: “activity-first, both contexts”). The `invitationAccepted` activity
 * lands in the acceptor's Activity Registry (own for personal, the org's for
 * admin context); `ActivityWebhookHandler` dispatches the acceptor's
 * `acceptInvitation` workflow, which POSTs the opaque capabilityUrl as the
 * acceptor and builds the acceptor → inviter registration.
 */
export async function acceptInvitation(
  ctx: ResolvedContext,
  invitation: { capabilityUrl: string; label: string; note?: string },
  lang: string
): Promise<S.Schema.Type<typeof InvitationAcceptedMessage>> {
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')
  // urn:uuid snapshot — the acceptor has no owning container to mint an
  // invitation id in; the full invitation projection embeds inline (the
  // singly-fetched activity doc already contains the node, never dereferenced)
  const activity: Omit<InvitationAccepted, 'id'> = {
    type: ['Activity', 'InvitationAccepted', 'as:Accept'],
    actor: ctx.webId,
    // no target — the object is a self-contained urn:uuid snapshot (the
    // acceptor has no owning container to mint a real id in)
    object: {
      id: `urn:uuid:${ctx.session.randomUUID()}`,
      type: [INTEROP.SocialAgentInvitation],
      capabilityUrl: invitation.capabilityUrl,
      // the snapshot's label is tagged with the preferred language
      // (untagged under `@none` when no language is given)
      label: lang ? { [lang]: invitation.label } : { '@none': invitation.label },
      note: invitation.note,
    },
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    { fetch: ctx.session.fetch, randomUUID: ctx.session.randomUUID },
    activity
  )
  // the activity id is the uniform UI claim anchor — the snapshot object
  // carries nothing the UI knows, so bindClaim matches the stream event by
  // the echoed activity IRI exactly
  return InvitationAcceptedMessage.make({ accepted: true, activityId: IRI.make(created.id) })
}
