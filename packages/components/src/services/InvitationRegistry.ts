import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import type {
  CreateInvitationPojo,
  InvitationCreated,
  SocialAgentInvitationData,
} from '@janeirodigital/interop-data-model'
import { INTEROP, iriForContained } from '@janeirodigital/interop-utils'
import { pickLanguage } from '@janeirodigital/interop-utils'
import {
  IRI,
  InvitationCreatedMessage,
  SocialAgentInvitation,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import {
  getSocialAgentInvitation as getInvitationFromSparql,
  listContained,
  sparqlTransportFor,
} from './queries/org.js'

function buildSocialAgentInvitation(
  socialAgentInvitation: SocialAgentInvitationData,
  lang: string
) {
  return SocialAgentInvitation.make({
    id: IRI.make(socialAgentInvitation.id),
    capabilityUrl: socialAgentInvitation.capabilityUrl,
    // the stored label is a language map — surface the plain string for the
    // preferred language (untagged `@none` as the fallback)
    label: pickLanguage(socialAgentInvitation.label, lang) ?? '',
    note: socialAgentInvitation.note,
  })
}

/**
 * The context's social-agent invitations via SPARQL over the invitation
 * registry's server-managed `ldp:contains` listing (docs/sparql.md,
 * invitations candidate) — personal context reads the session's internal
 * endpoint, org context the org's `/sparql-admin` (`sparqlTransportFor`).
 */
export async function getSocialAgentInvitations(ctx: ResolvedContext, lang: string) {
  const transport = sparqlTransportFor(ctx)
  const invitations = []
  for (const iri of await listContained(transport, ctx.registrySet.hasInvitationRegistry.id)) {
    const invitation = await getInvitationFromSparql(transport, iri)
    if (!invitation.registeredAgent) {
      invitations.push(buildSocialAgentInvitation(invitation, lang))
    }
  }
  return invitations
}

/**
 * Activity-first (see the OpenWiki `services/rpc-and-services.md`): the RPC only mints
 * the invitation id (`iriForContained`) and writes the `invitationCreated`
 * activity — the `createInvitation` workflow PUTs the invitation resource at
 * the minted id and generates the capabilityUrl there (unknowable before the
 * workflow runs, so the pending ack echoes only label/note + the minted id).
 */
export async function createInvitation(
  ctx: ResolvedContext,
  base: { label: string; note?: string },
  lang: string
): Promise<S.Schema.Type<typeof InvitationCreatedMessage>> {
  const invitationRegistry = ctx.registrySet.hasInvitationRegistry
  const activityRegistry = ctx.registrySet.hasActivityRegistry
  if (!activityRegistry) throw new Error('activity registry not found in registry set')
  const invitationId = iriForContained(invitationRegistry, ctx.session.randomUUID)
  // the invitation-to-be — full POJO projection minus capabilityUrl (the
  // workflow generates it) at the pre-minted id; the label is tagged with the
  // preferred language (untagged under `@none` when no language is given)
  const object: CreateInvitationPojo = {
    id: invitationId,
    type: [INTEROP.SocialAgentInvitation],
    label: lang ? { [lang]: base.label } : { '@none': base.label },
    note: base.note,
  }
  const activity: Omit<InvitationCreated, 'id'> = {
    type: ['Activity', 'InvitationCreated', 'as:Create'],
    actor: ctx.webId,
    // no target — the changed record's id rides object.id (the embedded
    // invitation-to-be); the changed container is not consumed
    object,
    createdAt: new Date().toISOString(),
  }
  const created = await ActivityRegistry.createActivity(
    activityRegistry,
    {
      fetch: ctx.session.fetch,
      randomUUID: ctx.session.randomUUID,
    },
    activity
  )
  return InvitationCreatedMessage.make({
    accepted: true,
    id: IRI.make(invitationId),
    label: base.label,
    note: base.note,
    // the uniform UI claim anchor — bindClaim matches the stream event by id
    activityId: IRI.make(created.id),
  })
}
