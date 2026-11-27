import { describe, expect, test, vi } from 'vitest'

import { ChannelType, discoverSubscriptionService, subscribeToNotificationChannel } from '../src'
import type { WhatwgFetch } from '../src'

const NOTIFY = 'http://www.w3.org/ns/solid/notifications#'
const STORAGE_DESCRIPTION = 'http://www.w3.org/ns/solid/terms#storageDescription'
const topic = 'https://home.alice.example/registry/'
const storageDescriptionIri = 'https://home.alice.example/.well-known/solid'
const serviceId = 'https://home.alice.example/.notifications/WebhookChannel2023/'
const subscriptionUrl = `${serviceId}1234`

const channelType = ChannelType.WebhookChannel2023

/** Storage description exposing a webhook subscription service. */
const storageDescription = [
  {
    '@id': serviceId,
    [`${NOTIFY}channelType`]: [{ '@id': channelType }],
    [`${NOTIFY}feature`]: [{ '@id': `${NOTIFY}state` }],
  },
]

function notificationFetch(options: {
  storageDescription?: unknown
  channel?: unknown
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    if (init?.method === 'HEAD') {
      return {
        ok: true,
        headers: {
          get: (name: string) =>
            name === 'Link'
              ? `<${storageDescriptionIri}>; rel="${STORAGE_DESCRIPTION}"`
              : undefined,
        },
      } as unknown as Response
    }
    if (url === storageDescriptionIri) {
      return {
        ok: true,
        url,
        json: async () => options.storageDescription ?? storageDescription,
      } as unknown as Response
    }
    return {
      ok: true,
      url,
      json: async () =>
        options.channel ?? {
          id: subscriptionUrl,
          type: channelType,
          topic,
          sendTo: 'https://app.example/webhook',
        },
    } as unknown as Response
  })
}

describe('discoverSubscriptionService', () => {
  test('finds the service matching the channel type through the storage description', async () => {
    const mock = notificationFetch({})
    const service = await discoverSubscriptionService(
      topic,
      channelType,
      mock as unknown as WhatwgFetch
    )
    expect(service).toEqual({ id: serviceId, channelType, feature: [`${NOTIFY}state`] })
  })

  test('returns undefined when no service matches the channel type', async () => {
    const mock = notificationFetch({ storageDescription: [{ '@id': 'https://other.example/' }] })
    const service = await discoverSubscriptionService(
      topic,
      channelType,
      mock as unknown as WhatwgFetch
    )
    expect(service).toBeUndefined()
  })
})

describe('subscribeToNotificationChannel', () => {
  test('POSTs a compacted JSON-LD channel and returns the server channel', async () => {
    const mock = notificationFetch({})
    const channel = await subscribeToNotificationChannel(
      mock as unknown as WhatwgFetch,
      topic,
      channelType,
      'https://app.example/webhook'
    )
    expect(channel).toEqual({
      id: subscriptionUrl,
      type: channelType,
      topic,
      sendTo: 'https://app.example/webhook',
    })

    const post = mock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toBe(serviceId)
    expect(post?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/ld+json',
      Accept: 'application/ld+json',
    })
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      '@context': ['https://www.w3.org/ns/solid/notification/v1'],
      type: channelType,
      topic,
      sendTo: 'https://app.example/webhook',
    })
  })

  test('throws when no subscription service supports the channel type', async () => {
    const mock = notificationFetch({ storageDescription: [{ '@id': 'https://other.example/' }] })
    await expect(
      subscribeToNotificationChannel(mock as unknown as WhatwgFetch, topic, channelType)
    ).rejects.toThrow('not found')
  })
})
