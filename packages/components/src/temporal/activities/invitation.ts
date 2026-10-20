import { putSocialAgentInvitation } from '@janeirodigital/interop-authorization-agent'
import type { CreateInvitationPojo } from '@janeirodigital/interop-data-model'
import { SocialAgentInvitation } from '@janeirodigital/interop-data-model'
import { loader } from '@janeirodigital/interop-utils'
const loadSocialAgentInvitation = loader(SocialAgentInvitation.fromJsonLd)

import { buildSessionManager } from '../../builders/sessionManager.js'
import { invitationUrl } from '../../util/uriTemplates.js'

/**
 * The activity-first createInvitation leg (step 1): PUT the invitation at the
 * pre-minted id with the context's own session, generating the capabilityUrl
 * here — the opaque protocol link (openwiki/architecture/federation.md: the acceptor must not parse
 * it, so it is the one protocol-opaque plain string). Idempotent under
 * workflow retries and reconcile re-delivery: find-first by the STABLE
 * pre-minted invitation id (never by the per-run capabilityUrl — a retry
 * mints a fresh one) — an earlier attempt already PUT the resource (e.g. the
 * reconcile sweep after a handler crash), so skip the write and let the
 * workflow mark the activity done. The completion is orchestrated by the
 * workflow (`activityId` never rides this activity's args).
 */
export async function createSocialAgentInvitation(
  webId: string,
  invitation: CreateInvitationPojo
): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(webId)
  const existing = await loadSocialAgentInvitation(invitation.id, session.fetch).catch(
    (): undefined => undefined
  )
  if (existing) return
  const capabilityUrl = invitationUrl(webId)
  await putSocialAgentInvitation(
    {
      ...invitation,
      capabilityUrl,
    },
    session.fetch
  )
}
