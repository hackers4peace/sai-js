import { dataModelContext } from '@janeirodigital/interop-data-model'
import type { SocialAgentInvitationData } from '@janeirodigital/interop-data-model'
import { putJsonLd, withContext } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

// ──────────────────────────
// Write path: SocialAgentInvitationData → JSON-LD (PUT)
// ──────────────────────────

export async function putSocialAgentInvitation(
  data: SocialAgentInvitationData,
  fetch: WhatwgFetch
): Promise<void> {
  // the shared context carries the `label` language-map container so the map
  // expands to proper literals on the wire
  await putJsonLd(data.id, fetch, withContext(dataModelContext, data))
}

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────

export async function setRegisteredAgent(
  data: SocialAgentInvitationData,
  fetch: WhatwgFetch,
  webId: string
): Promise<void> {
  data.registeredAgent = webId
  await putSocialAgentInvitation(data, fetch)
}
