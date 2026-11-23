import {
  BaseAccountStore,
  BaseLoginAccountStorage,
  ContainerPathStorage,
  WrappedIndexedStorage,
} from '@solid/community-server'
import type { IndexTypeCollection, LoginStorage, VirtualObject } from '@solid/community-server'

import { PostgresKeyValueStorage } from '../PostgresKeyValueStorage.js'

export async function buildAccountLoginStorage<T extends IndexTypeCollection<T>>(): Promise<
  LoginStorage<T>
> {
  const keyValueStorage = new PostgresKeyValueStorage<any>(
    process.env.CSS_POSTGRES_CONNECTION_STRING,
    'key_value'
  )
  await keyValueStorage.handle()
  const valueStorage = new ContainerPathStorage<VirtualObject>(keyValueStorage, '/accounts/data/')
  const indexStorage = new ContainerPathStorage<Array<string>>(keyValueStorage, '/accounts/index/')
  const storage = new WrappedIndexedStorage<T>(valueStorage, indexStorage)
  const accountStorage = new BaseLoginAccountStorage(storage)
  // @ts-expect-error the index storage is typed for strings, not account records
  const accountStore = new BaseAccountStore(accountStorage)
  await accountStore.handle()
  return accountStorage
}
