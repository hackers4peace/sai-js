import { BaseWebIdStore, WEBID_STORAGE_TYPE } from '@solid/community-server'

export class CustomWebIdStore extends BaseWebIdStore {
  /**
   * The account a WebID is linked to (the reverse `webIdLink` lookup). Used to
   * resolve a session owner to the endpoints stored under its account.
   */
  public async findAccount(webId: string): Promise<string | undefined> {
    // @ts-expect-error the base store declares `find` with a narrower record type
    const result = await this.storage.find(WEBID_STORAGE_TYPE, { webId })
    return result[0]?.accountId
  }
}
