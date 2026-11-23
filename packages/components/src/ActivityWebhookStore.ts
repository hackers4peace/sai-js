import type { NotificationChannel } from '@janeirodigital/interop-utils'
import {
  ACCOUNT_TYPE,
  Initializer,
  InternalServerError,
  createErrorMessage,
} from '@solid/community-server'
import type { AccountLoginStorage } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

export const ACTIVITY_WEBHOOK_STORAGE_TYPE = 'activityWebhook'
export const ACTIVITY_WEBHOOK_STORAGE_DESCRIPTION = {
  accountId: `id:${ACCOUNT_TYPE}`,
  webId: 'string',
  topic: 'string',
  sendTo: 'string',
  channel: 'string',
} as const

/**
 * A store using an {@link AccountLoginStorage} to store webhook channels for
 * the main agent's Activity Registry subscription (one per account, keyed by
 * the topic = the agent's own Activity Registry container).
 * Needs to be initialized before it can be used.
 */
export class ActivityWebhookStore extends Initializer {
  private readonly logger = getLoggerFor(this)

  private readonly storage: AccountLoginStorage<{
    [ACTIVITY_WEBHOOK_STORAGE_TYPE]: typeof ACTIVITY_WEBHOOK_STORAGE_DESCRIPTION
  }>
  private initialized = false

  // Wrong typings to prevent Components.js typing issues
  public constructor(storage: AccountLoginStorage<Record<string, never>>) {
    super()
    this.storage = storage as unknown as typeof this.storage
  }

  // Initialize the type definitions
  public async handle(): Promise<void> {
    if (this.initialized) {
      return
    }
    try {
      await this.storage.defineType(
        ACTIVITY_WEBHOOK_STORAGE_TYPE,
        ACTIVITY_WEBHOOK_STORAGE_DESCRIPTION,
        false
      )
      await this.storage.createIndex(ACTIVITY_WEBHOOK_STORAGE_TYPE, 'accountId')
      await this.storage.createIndex(ACTIVITY_WEBHOOK_STORAGE_TYPE, 'webId')
      await this.storage.createIndex(ACTIVITY_WEBHOOK_STORAGE_TYPE, 'topic')
      await this.storage.createIndex(ACTIVITY_WEBHOOK_STORAGE_TYPE, 'sendTo')
      this.initialized = true
    } catch (cause: unknown) {
      throw new InternalServerError(
        `Error defining Activity Webhook channels in storage: ${createErrorMessage(cause)}`,
        { cause }
      )
    }
  }

  public async findBySendTo(sendTo: string): Promise<
    | {
        id: string
        accountId: string
        webId: string
        topic: string
        sendTo: string
        channel: NotificationChannel
      }
    | undefined
  > {
    const raw = (await this.storage.find(ACTIVITY_WEBHOOK_STORAGE_TYPE, { sendTo }))[0]
    if (raw) {
      return {
        ...raw,
        channel: JSON.parse(raw.channel),
      }
    }
  }

  public async create(
    accountId: string,
    webId: string,
    topic: string,
    channel: NotificationChannel
  ): Promise<void> {
    await this.storage.create(ACTIVITY_WEBHOOK_STORAGE_TYPE, {
      webId,
      topic,
      accountId,
      sendTo: channel.sendTo,
      channel: JSON.stringify(channel),
    })

    this.logger.debug(
      `Added Activity Webhook channel for ${webId} on ${topic} to account ${accountId}`
    )
  }

  public async delete(id: string): Promise<void> {
    this.logger.debug(`Deleting activity webhook channel with ID ${id}`)
    return this.storage.delete(ACTIVITY_WEBHOOK_STORAGE_TYPE, id)
  }
}
