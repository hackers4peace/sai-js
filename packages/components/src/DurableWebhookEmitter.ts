import { randomUUID } from 'node:crypto'

import {
  NotificationEmitter,
  NotImplementedHttpError,
  createErrorMessage,
  isWebhook2023Channel,
  readableToString,
} from '@solid/community-server'
import type { NotificationEmitterInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import { type PostWebhookInput, postWebhook } from './temporal/activities/webhook-delivery.js'
import { Temporal } from './temporal/client.js'
import { WEBHOOK_DELIVERY_TASK_QUEUE } from './temporal/queues.js'
import { deliverWebhook } from './temporal/workflows/webhook-delivery.js'

/**
 * Webhook emitter that hands each notification to the `webhook-delivery`
 * Temporal queue. If the enqueue fails, it falls back to the direct POST that
 * CSS's stock emitter performs.
 *
 * The webhook handlers use `sendTo` as a capability URL and do not verify the
 * DPoP token that CSS's `WebhookEmitter` sends. This emitter therefore sends
 * no `Authorization` or `DPoP` headers. Add them here if a receiver starts
 * verifying the sender.
 */
export class DurableWebhookEmitter extends NotificationEmitter {
  protected readonly logger = getLoggerFor(this)
  private readonly temporal = new Temporal()

  public async canHandle({ channel }: NotificationEmitterInput): Promise<void> {
    if (!isWebhook2023Channel(channel)) {
      throw new NotImplementedHttpError(`${channel.id} is not a WebhookChannel2023 channel.`)
    }
  }

  public async handle({ channel, representation }: NotificationEmitterInput): Promise<void> {
    if (!isWebhook2023Channel(channel)) {
      throw new NotImplementedHttpError(`${channel.id} is not a WebhookChannel2023 channel.`)
    }

    const payload: PostWebhookInput = {
      sendTo: channel.sendTo,
      body: await readableToString(representation.data),
      contentType: representation.metadata.contentType,
    }

    try {
      await this.temporal.init()
      await this.temporal.client!.workflow.start(deliverWebhook, {
        taskQueue: WEBHOOK_DELIVERY_TASK_QUEUE,
        args: [payload],
        workflowId: `webhook:${randomUUID()}`,
      })
    } catch (error) {
      this.logger.error(
        `Could not enqueue webhook delivery for ${payload.sendTo}, falling back to a direct POST: ${createErrorMessage(error)}`
      )
      await this.postDirectly(payload)
    }
  }

  private async postDirectly(payload: PostWebhookInput): Promise<void> {
    try {
      await postWebhook(payload)
    } catch (error) {
      this.logger.error(
        `Could not emit a Webhook notification with target ${payload.sendTo}: ${createErrorMessage(error)}`
      )
    }
  }
}
