import {
  ACCOUNT_TYPE,
  Initializer,
  InternalServerError,
  createErrorMessage,
} from '@solid/community-server'
import type { AccountLoginStorage } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'
import type { PushSubscription } from 'web-push'

export const UI_PUSH_SUBSCRIPTION_STORAGE_TYPE = 'uiPushSubscription'
export const UI_PUSH_SUBSCRIPTION_STORAGE_DESCRIPTION = {
  webId: 'string',
  accountId: `id:${ACCOUNT_TYPE}`,
  subscription: 'string',
} as const

/**
 * A store using a {@link AccountLoginStorage} to store the subscriptions.
 * Needs to be initialized before it can be used.
 */
export class UiPushSubscriptionStore extends Initializer {
  private readonly logger = getLoggerFor(this)

  private readonly storage: AccountLoginStorage<{
    [UI_PUSH_SUBSCRIPTION_STORAGE_TYPE]: typeof UI_PUSH_SUBSCRIPTION_STORAGE_DESCRIPTION
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
        UI_PUSH_SUBSCRIPTION_STORAGE_TYPE,
        UI_PUSH_SUBSCRIPTION_STORAGE_DESCRIPTION,
        false
      )
      await this.storage.createIndex(UI_PUSH_SUBSCRIPTION_STORAGE_TYPE, 'accountId')
      await this.storage.createIndex(UI_PUSH_SUBSCRIPTION_STORAGE_TYPE, 'webId')
      this.initialized = true
    } catch (cause: unknown) {
      throw new InternalServerError(
        `Error defining UI Push Subscriptions in storage: ${createErrorMessage(cause)}`,
        { cause }
      )
    }
  }

  public async get(
    id: string
  ): Promise<{ accountId: string; webId: string; subscription: PushSubscription } | undefined> {
    const raw = await this.storage.get(UI_PUSH_SUBSCRIPTION_STORAGE_TYPE, id)
    return {
      accountId: raw.accountId,
      webId: raw.webId,
      subscription: JSON.parse(raw.subscription),
    }
  }

  public async findSubscriptions(
    accountId: string
  ): Promise<{ id: string; webId: string; subscription: PushSubscription }[]> {
    return (await this.storage.find(UI_PUSH_SUBSCRIPTION_STORAGE_TYPE, { accountId })).map(
      ({
        id,
        webId,
        subscription,
      }): { id: string; webId: string; subscription: PushSubscription } => ({
        id,
        webId,
        subscription: JSON.parse(subscription),
      })
    )
  }

  public async checkIfExists(accountId: string, subscription: PushSubscription): Promise<boolean> {
    const allForAccount = await this.findSubscriptions(accountId)
    return allForAccount.some((rec) => rec.subscription.endpoint === subscription.endpoint)
  }

  public async create(
    webId: string,
    accountId: string,
    subscription: PushSubscription
  ): Promise<void> {
    if (await this.checkIfExists(accountId, subscription)) {
      return
    }
    await this.storage.create(UI_PUSH_SUBSCRIPTION_STORAGE_TYPE, {
      webId,
      accountId,
      subscription: JSON.stringify(subscription),
    })

    this.logger.debug(`Added UI Push Subscription for ${webId} to account ${accountId}`)
  }

  public async delete(subscriptionId: string): Promise<void> {
    this.logger.debug(`Deleting UI Push Subscription link with ID ${subscriptionId}`)
    return this.storage.delete(UI_PUSH_SUBSCRIPTION_STORAGE_TYPE, subscriptionId)
  }
}
