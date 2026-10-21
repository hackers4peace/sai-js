import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import type { DelegatedGrantsUpdated } from '@janeirodigital/interop-data-model'
import {
  BadRequestHttpError,
  HttpError,
  OperationHttpHandler,
  ResponseDescription,
  readableToString,
} from '@solid/community-server'
import type { CredentialsExtractor, OperationHttpHandlerInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { ReciprocalWebhookStore } from './ReciprocalWebhookStore.js'
import type { SessionManager } from './SessionManager'

/**
 * Receives webhook notifications from reciprocal registrations.
 *
 * Delivery is at-least-once. A future `Idempotency-Key` header would let the
 * handler dedupe repeated `Update` notifications.
 */
export class ReciprocalWebhookHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly reciprocalWebhookStore: ReciprocalWebhookStore,
    private readonly sessionManager: SessionManager
  ) {
    super()
  }
  public async handle({ operation }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const channel = await this.reciprocalWebhookStore.findBySendTo(operation.target.path)
    if (!channel) {
      // TODO: unsubscribe
      throw new HttpError(410, 'GoneHttpError', `Unknown webhook channel: ${operation.target.path}`)
    }

    // TODO: check if sender matches one from the channel. The stock emitter's
    // DPoP token is not verified today; sendTo is the capability URL.
    //
    // const credentials = await this.credentialsExtractor.handleSafe(request)

    // only write an activity on Update — the container Add then routes through
    // the same ActivityWebhookHandler path as every other producer (uniform
    // outbox: the UI gets a `done` event for peer-driven updates too)
    let requestBody: { type: string }
    try {
      requestBody = JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError(err.message)
    }
    if (requestBody.type === 'Update') {
      // mirror maintenance is NOT done here — this handler only records the
      // `delegatedGrantsUpdated` activity (the outbox pattern); the per-peer
      // delegated-grants consumer (started by ActivityWebhookHandler)
      // replicates the mirror FIRST, then regenerates the delegated grants and
      // finally completes the activity (openwiki/architecture/federation.md)
      const session = await this.sessionManager.getSession(channel.webId)
      const activityRegistry = session.registrySet.hasActivityRegistry
      if (!activityRegistry) throw new Error('activity registry not found in registry set')
      // `object` is the reciprocal registration IRI — informational (no workflow
      // reads it; the consumer derives the peer from `target`). The subscription
      // channel already records it as its `topic`, so no registration read is
      // needed.
      const { topic } = channel.channel
      const reciprocalRegistration = Array.isArray(topic) ? (topic[0] ?? '') : topic
      const activity: Omit<DelegatedGrantsUpdated, 'id'> = {
        type: ['Activity', 'DelegatedGrantsUpdated'],
        actor: channel.webId,
        // the peer — the side whose reciprocal-registration Update triggered
        // this webhook; informational only, not consumed by any workflow
        target: channel.peerId,
        object: reciprocalRegistration,
        createdAt: new Date().toISOString(),
      }
      await ActivityRegistry.createActivity(
        activityRegistry,
        { fetch: session.fetch, randomUUID: session.randomUUID },
        activity
      )
    }
    return new ResponseDescription(200)
  }
}
