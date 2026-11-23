import {
  AS,
  RDF,
  discoverWebPushService,
  getNotificationChannel,
  getOneMatchingQuad,
  toStore,
} from '@janeirodigital/interop-utils'
import type { NotificationChannel } from '@janeirodigital/interop-utils'

export class NotificationManager extends EventTarget {
  public webPushService?: { id: string; vapidPublicKey: string }

  private streamMap = new Map<string, Response>()

  private authnFetch: typeof fetch

  private authorizationAgentIri: string

  constructor(authnFetch: typeof fetch, authorizationAgentIri: string) {
    super()
    this.authnFetch = authnFetch
    this.authorizationAgentIri = authorizationAgentIri
  }

  public async subscribeViaPush(
    subscription: PushSubscription,
    topic: string
  ): Promise<NotificationChannel> {
    if (!this.webPushService) {
      throw new Error('Web Push Service not found')
    }
    const channel = {
      '@context': ['https://www.w3.org/ns/solid/notifications-context/v1'],
      type: 'notify:WebPushChannel2023',
      topic,
      sendTo: subscription.endpoint,
      'notify:keys': {
        'notify:auth': subscription.toJSON().keys?.auth,
        'notify:p256dh': subscription.toJSON().keys?.p256dh,
      },
    }
    const response = await this.authnFetch(this.webPushService.id, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
      },
      body: JSON.stringify(channel),
    })
    if (!response.ok) {
      throw new Error('Failed to subscribe via push')
    }
    return response.json()
  }

  public async unsubscribeFromPush(topic: string, channelId: string): Promise<boolean> {
    const response = await this.authnFetch(channelId, { method: 'DELETE' })
    return response.ok
  }

  private async bootstrap(): Promise<void> {
    this.webPushService = await discoverWebPushService(this.authorizationAgentIri, this.authnFetch)
  }

  public static async build(
    authnFetch: typeof fetch,
    authorizationAgentId: string
  ): Promise<NotificationManager> {
    const manager = new NotificationManager(authnFetch, authorizationAgentId)
    await manager.bootstrap()
    return manager
  }

  private async handleStream(resourceId: string, receiveFrom: string): Promise<void> {
    const response = await this.authnFetch(receiveFrom)
    if (!response.ok) {
      console.log('failed connecting to notification stream:', receiveFrom, response.status)
      return
    }
    if (!response.body) {
      console.log('missing body of notification stream:', receiveFrom)
      return
    }
    this.streamMap.set(resourceId, response)
    // TODO remove from map on error or close, and reconnect
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let initialDiscarded = false
    try {
      while (response.body.locked) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        while (true) {
          const newlineIndex = buffer.indexOf('\n')
          if (newlineIndex < 0) {
            break
          }
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (!line) {
            continue
          }
          // discard the initial state notification (first line)
          if (!initialDiscarded) {
            initialDiscarded = true
            continue
          }
          const dataset = await toStore(JSON.parse(line) as Record<string, unknown>)
          this.dispatchEvent(
            new CustomEvent('notification', {
              detail: {
                type: getOneMatchingQuad(dataset, undefined, RDF.terms.type)!.object.value,
                object: getOneMatchingQuad(dataset, undefined, AS.terms.object)!.object.value,
              },
            })
          )
        }
      }
    } finally {
      reader.releaseLock()
      await response.body.cancel()
    }
  }

  public async subscribeToResource(resourceId: string): Promise<void> {
    if (this.streamMap.has(resourceId)) {
      return
    }
    const headResponse = await this.authnFetch(resourceId)
    const linkHeader = headResponse.headers.get('link')
    const receiveFrom = linkHeader ? getNotificationChannel(linkHeader) : undefined
    if (!receiveFrom) {
      console.log('Failed to discover notification chanel for:', resourceId)
      return
    }
    this.handleStream(resourceId, receiveFrom)
  }
}
