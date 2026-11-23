import { discoverStorageDescription } from './discovery.ts'
import { fetchJsonLd, toStore } from './jsonld.ts'
import { getAllMatchingQuads } from './match.ts'
import { NOTIFY } from './namespaces.ts'
import type { WhatwgFetch } from './whatwg-fetch.ts'

/**
 * The canonical notification context used by Community Solid Server for
 * channel descriptions (`jsonld-parser.ts` also maps the older
 * `notifications-context/v1` spelling for our own reads).
 */
const NOTIFICATION_CONTEXT = 'https://www.w3.org/ns/solid/notification/v1'

/**
 * A subscribed notification channel, as returned by a notification
 * subscription service. Mirrors the shape used by `@solid-notifications/types`
 * (the package this replaces) so stored channels stay wire-compatible.
 */
export interface NotificationChannel {
  id: string
  type: string
  topic: string | Array<string>
  receiveFrom?: string
  sendTo?: string
  sender?: string
}

/** A subscription service advertised in a storage description resource. */
export interface SubscriptionService {
  id: string
  channelType: string
  feature: Array<string>
}

/** Notification channel types (the `notify:` channel type IRIs). */
export const ChannelType = {
  WebhookChannel2023: 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023',
  WebSocketChannel2023: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
} as const

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType]

/**
 * Discover the subscription service supporting `channelType` for a topic:
 * HEAD the topic for its storage description (Link header), GET that
 * description as JSON-LD, and find the service node whose
 * `notify:channelType` matches. Returns `undefined` when the topic exposes no
 * such service.
 *
 * Replaces `@solid-notifications/discovery`'s `DiscoveryClient.findService`.
 */
export async function discoverSubscriptionService(
  resourceIri: string,
  channelType: string,
  fetch: WhatwgFetch
): Promise<SubscriptionService | undefined> {
  const storageDescriptionIri = await discoverStorageDescription(resourceIri, fetch)
  if (!storageDescriptionIri) {
    return undefined
  }
  const dataset = await toStore(
    (await fetchJsonLd(storageDescriptionIri, fetch)) as Record<string, unknown>,
    storageDescriptionIri
  )
  const serviceQuad = getAllMatchingQuads(dataset, undefined, NOTIFY.terms.channelType).find(
    (quad) => quad.object.value === channelType
  )
  if (!serviceQuad) {
    return undefined
  }
  const feature = getAllMatchingQuads(dataset, serviceQuad.subject, NOTIFY.terms.feature).map(
    (quad) => quad.object.value
  )
  return { id: serviceQuad.subject.value, channelType, feature }
}

/**
 * Subscribe to a notification channel for `topic`: discover the service,
 * POST a compacted JSON-LD channel request (the context CSS caches
 * internally), and return the server-assigned channel.
 *
 * Replaces `@solid-notifications/subscription`'s `SubscriptionClient` — the
 * old implementation serialized/parsed Turtle through the removed
 * `parseTurtle`/`serializeTurtle` helpers and N3, and no longer works against
 * the workspace `interop-utils`.
 */
export async function subscribeToNotificationChannel(
  fetch: WhatwgFetch,
  topic: string,
  channelType: string,
  sendTo?: string
): Promise<NotificationChannel> {
  const service = await discoverSubscriptionService(topic, channelType, fetch)
  if (!service) {
    throw new Error(`subscription service for channel type ${channelType} not found`)
  }
  const channel = {
    '@context': [NOTIFICATION_CONTEXT],
    type: channelType,
    topic,
    ...(sendTo ? { sendTo } : {}),
  }
  // the notification SERVICE endpoint, not a storage: its wire format is plain
  // JSON-LD (the LWS profile applies to storage representations; Accept audit,
  // TODO §3)
  const response = await fetch(service.id, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ld+json',
      Accept: 'application/ld+json',
    },
    body: JSON.stringify(channel),
  })
  if (!response.ok) {
    throw new Error(`failed subscribing to ${service.id}: ${response.status}`)
  }
  return (await response.json()) as NotificationChannel
}
