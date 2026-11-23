import type { PassThrough } from 'node:stream'

import type { ActivityData } from '@janeirodigital/interop-data-model'
import { WrappedSetMultiMap } from '@solid/community-server'

/** The enriched shape the bus forwards to UI streams (illustrated event
 * format in refactor-ui.md) — the typed activity + lifecycle status. */
export type ActivityEvent = ActivityData & {
  status: 'pending' | 'done'
}

/**
 * In-memory EventBus for UI sync — a StreamingHttpMap mirror: topic (webId) →
 * set of open NDJSON streams. `ActivityWebhookHandler` forwards every activity
 * container `Add` here (`onActivityAdded`); `EventsHandler` registers /
 * unregisters the browser's stream under the account's webId. Writes are
 * fire-and-forget — a slow/stuck UI stream must never delay the webhook
 * response (PassThrough's bounded buffer absorbs temporary backpressure and a
 * destroyed stream is skipped).
 */
export class ActivityEvents {
  private readonly streams = new WrappedSetMultiMap<string, PassThrough>()

  public subscribe(webId: string, stream: PassThrough): void {
    this.streams.add(webId, stream)
  }

  public unsubscribe(webId: string, stream: PassThrough): void {
    this.streams.deleteEntry(webId, stream)
  }

  public emit(webId: string, line: string): void {
    // no subscribers under this webId (common — a test/UI may never open the
    // stream): the bus is a no-op, never an error
    const streams = this.streams.get(webId)
    if (!streams) {
      return
    }
    for (const stream of streams) {
      if (stream.destroyed) {
        continue
      }
      try {
        stream.write(`${line}\n`)
      } catch {
        // fire-and-forget: never let the bus break the webhook response
      }
    }
  }

  public onActivityAdded(webId: string, activity: ActivityEvent): void {
    this.emit(webId, JSON.stringify({ type: 'activity', activity }))
  }
}
