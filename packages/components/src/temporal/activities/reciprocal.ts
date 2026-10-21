import {
  AgentRegistry,
  createSocialAgentRegistration,
  setAcr,
} from '@janeirodigital/interop-authorization-agent'
import type {
  EmbeddedSocialAgentInvitation,
  SocialAgentId,
  SocialAgentRegistrationData,
} from '@janeirodigital/interop-data-model'
import { SocialAgentRegistration } from '@janeirodigital/interop-data-model'
const loadSocialAgentRegistration = loader(SocialAgentRegistration.fromJsonLd)

import {
  ChannelType,
  discoverAuthorizationAgent,
  loader,
  subscribeToNotificationChannel,
} from '@janeirodigital/interop-utils'

import { buildAccountLoginStorage } from '../../builders/accountLoginStorage.js'
import { buildSessionManager } from '../../builders/sessionManager.js'
import { ReciprocalWebhookStore } from '../../ReciprocalWebhookStore.js'
import {
  deleteReciprocalMirror as deleteMirror,
  updateReciprocalMirror,
} from '../../services/ReciprocalMirror.js'

function webhookTargetUrl(): string {
  return `${process.env.CSS_BASE_URL}.sai/reciprocal-webhook/${crypto.randomUUID()}`
}

export interface ReciprocalWebhookInput {
  accountId: string
  webId: string
  peerId: string
  topic: string
}

export interface AcceptInvitationOutput {
  inviterWebId: string
  /** the acceptor's registration of the inviter (find-first — the id the
   *  workflow passes to `reciprocalRegistration`) */
  registration: SocialAgentRegistrationData
}

/**
 * The acceptor side of the common accept protocol (see the OpenWiki
 * `temporal/workflows.md`): POSTs the **opaque** capabilityUrl as the acceptor — its own AA
 * session, personal or org — so the inviter's AA creates *its* registration of
 * the acceptor and returns the inviter's webId (the only place the inviter's
 * identity is learned). Then creates the acceptor's registration of the
 * inviter (find-first — idempotent under workflow retries). The reciprocal
 * discovery is left to the workflow's `reciprocalRegistration` activity.
 * Multi-param/template: `(webId, object)` — the decoded activity object
 * passes verbatim (the urn:uuid snapshot carries capabilityUrl/label/note).
 */
export async function invitationAcceptance(
  webId: string,
  object: EmbeddedSocialAgentInvitation
): Promise<AcceptInvitationOutput> {
  const manager = buildSessionManager()
  const session = await manager.getSession(webId)
  const response = await session.fetch(object.capabilityUrl, { method: 'POST' })
  if (!response.ok) throw new Error(`accepting capability url failed: ${response.status}`)
  const inviterWebId = (await response.text()).trim()
  if (!inviterWebId) throw new Error('can not accept invitation without webid')

  let registration = await session.findSocialAgentRegistration(inviterWebId)
  if (!registration) {
    registration = await AgentRegistry.addSocialAgentRegistration(
      session.registrySet.hasSocialAgentRegistry,
      { fetch: session.fetch, randomUUID: session.randomUUID },
      { agent: webId, client: session.agentId },
      inviterWebId,
      // the snapshot's label is already the language map
      object.label,
      object.note
    )
  }
  return { inviterWebId, registration }
}

/**
 * The reciprocal leg shared by both invitation workflows: materializes the
 * registration at the given id when missing (the inviter side —
 * `establishReciprocal`, find-first idempotent), validates the peer,
 * discovers the peer's reciprocal registration and returns the webhook-store
 * input. Multi-param/template: `(webId, registration, accountId)` — the
 * inviter side passes the decoded activity object verbatim; the accept side
 * passes the freshly-created registration from `invitationAcceptance`.
 */
export async function reciprocalRegistration(
  webId: string,
  registration: SocialAgentRegistrationData,
  accountId: string
): Promise<ReciprocalWebhookInput> {
  const manager = buildSessionManager()
  const session = await manager.getSession(webId)
  let loaded = await loadSocialAgentRegistration(registration.id, session.fetch).catch(
    (): undefined => undefined
  )
  if (!loaded) {
    // the inviter side — the workflow PUTs the registration at the pre-minted
    // id from the activity object (the ACR setup mirrors addSocialAgentRegistration)
    await createSocialAgentRegistration(
      { ...registration, hasDataGrant: [], hasAdminGrant: [] },
      session.fetch
    )
    const peerUas = await discoverAuthorizationAgent(registration.registeredAgent, session.fetch)
    await setAcr(
      registration,
      session.fetch,
      { agent: webId, client: session.agentId },
      { agent: registration.registeredAgent, client: peerUas }
    )
    loaded = await loadSocialAgentRegistration(registration.id, session.fetch)
  }
  if (loaded.registeredAgent !== registration.registeredAgent) {
    throw new Error(
      `invalid payload - peerId: ${registration.registeredAgent}, registrationId: ${registration.id}, registeredAgent: ${loaded.registeredAgent}`
    )
  }
  if (!loaded.reciprocalRegistration) {
    await session.discoverAndUpdateReciprocal(loaded)
  }
  if (!loaded.reciprocalRegistration) {
    throw new Error(`reciprocal registration from ${registration.registeredAgent} was not found`)
  }
  // NOTE: the initial reciprocal-mirror write is deliberately NOT here — it
  // is orchestrated by the calling workflow as its own activity with its own
  // retry policy (`establishReciprocal` and `acceptInvitation`), so the
  // activity completion means "mirror written"
  // (openwiki/architecture/federation.md 1a)
  return {
    accountId,
    webId,
    peerId: registration.registeredAgent,
    topic: loaded.reciprocalRegistration,
  }
}

export interface SyncReciprocalMirrorInput {
  /** the org whose registration of `peerId` carries the reciprocal link */
  webId: SocialAgentId
  /** the peer whose reciprocal registration (+ data grants) gets mirrored */
  peerId: SocialAgentId
}

/**
 * The owner's registry-pod endpoint — the mirror graphs are written there
 * (per-pod datasets).
 */
function ownerEndpoint(session: { sparqlEndpoint: string }): string {
  return session.sparqlEndpoint
}

/**
 * Refresh the local read-only mirror of the peer's reciprocal registration
 * and its linked data grants (org-context-sparql.md phase 1). Runs with the
 * org's own session credentials — server-side, where they are legitimate.
 */
export async function syncReciprocalMirror(payload: SyncReciprocalMirrorInput): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registration = await session.findSocialAgentRegistration(payload.peerId.id)
  if (!registration?.reciprocalRegistration) return
  await updateReciprocalMirror(session, registration, ownerEndpoint(session))
}

/**
 * Remove the local mirror of the peer's reciprocal registration + its linked
 * grants (org-context-sparql.md phase 1). Dormant — the unregister flow that
 * calls this does not exist yet; when it lands it should run this as one
 * compensable step of a Temporal workflow (compensation: re-run
 * `updateReciprocalMirror`). Call while the org's registration of the peer
 * still exists — the reciprocal IRI is read from it.
 */
export async function deleteReciprocalMirror(payload: {
  webId: SocialAgentId
  peerId: SocialAgentId
}): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId.id)
  const registration = await session.findSocialAgentRegistration(payload.peerId.id)
  if (!registration?.reciprocalRegistration) return
  await deleteMirror(registration, ownerEndpoint(session))
}

export async function reciprocalWebhook(payload: ReciprocalWebhookInput): Promise<void> {
  const store = new ReciprocalWebhookStore(await buildAccountLoginStorage())
  await store.handle()
  const existing = await store.findAllBetween(payload.webId, payload.peerId)
  if (existing.length) return

  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId)
  const channel = await subscribeToNotificationChannel(
    session.fetch,
    payload.topic,
    ChannelType.WebhookChannel2023,
    webhookTargetUrl()
  )
  await store.create(payload.accountId, payload.webId, payload.peerId, channel)
}
