import type { NotificationChannel } from '@janeirodigital/interop-utils'
import {
  ACCOUNT_TYPE,
  Initializer,
  InternalServerError,
  createErrorMessage,
} from '@solid/community-server'
import type { AccountLoginStorage } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

export const RECIPROCAL_WEBHOOK_STORAGE_TYPE = 'reciprocalWebhook'
export const RECIPROCAL_WEBHOOK_STORAGE_DESCRIPTION = {
  accountId: `id:${ACCOUNT_TYPE}`,
  webId: 'string',
  peerId: 'string',
  sendTo: 'string',
  channel: 'string',
} as const

/**
 * A store using a {@link AccountLoginStorage} to store
 * webhook channels for reciprocal social agent registrations.
 * Needs to be initialized before it can be used.
 */
export class ReciprocalWebhookStore extends Initializer {
  private readonly logger = getLoggerFor(this)

  private readonly storage: AccountLoginStorage<{
    [RECIPROCAL_WEBHOOK_STORAGE_TYPE]: typeof RECIPROCAL_WEBHOOK_STORAGE_DESCRIPTION
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
        RECIPROCAL_WEBHOOK_STORAGE_TYPE,
        RECIPROCAL_WEBHOOK_STORAGE_DESCRIPTION,
        false
      )
      await this.storage.createIndex(RECIPROCAL_WEBHOOK_STORAGE_TYPE, 'accountId')
      await this.storage.createIndex(RECIPROCAL_WEBHOOK_STORAGE_TYPE, 'webId')
      await this.storage.createIndex(RECIPROCAL_WEBHOOK_STORAGE_TYPE, 'peerId')
      await this.storage.createIndex(RECIPROCAL_WEBHOOK_STORAGE_TYPE, 'sendTo')
      this.initialized = true
    } catch (cause: unknown) {
      throw new InternalServerError(
        `Error defining Reciprocal Webhook channels in storage: ${createErrorMessage(cause)}`,
        { cause }
      )
    }
  }

  public async get(id: string): Promise<
    | {
        accountId: string
        webId: string
        peerId: string
        sendTo: string
        channel: NotificationChannel
      }
    | undefined
  > {
    const raw = await this.storage.get(RECIPROCAL_WEBHOOK_STORAGE_TYPE, id)
    return {
      ...raw,
      channel: JSON.parse(raw.channel),
    }
  }

  public async findAllBetween(
    webId: string,
    peerId: string
  ): Promise<{ id: string; webId: string; peerId: string; channel: NotificationChannel }[]> {
    return (await this.storage.find(RECIPROCAL_WEBHOOK_STORAGE_TYPE, { webId, peerId })).map(
      (rec) => ({
        ...rec,
        channel: JSON.parse(rec.channel),
      })
    )
  }

  public async findBySendTo(sendTo: string): Promise<
    | {
        id: string
        webId: string
        peerId: string
        sendTo: string
        channel: NotificationChannel
      }
    | undefined
  > {
    const raw = (await this.storage.find(RECIPROCAL_WEBHOOK_STORAGE_TYPE, { sendTo }))[0]
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
    peerId: string,
    channel: NotificationChannel
  ): Promise<void> {
    await this.storage.create(RECIPROCAL_WEBHOOK_STORAGE_TYPE, {
      webId,
      peerId,
      accountId,
      sendTo: channel.sendTo,
      channel: JSON.stringify(channel),
    })

    this.logger.debug(
      `Added UI Reciprocal Webhook channel for ${webId}, and ${peerId} to account ${accountId}`
    )
  }

  public async delete(id: string): Promise<void> {
    this.logger.debug(`Deleting reciprocal webhook channel with ID ${id}`)
    return this.storage.delete(RECIPROCAL_WEBHOOK_STORAGE_TYPE, id)
  }
}
