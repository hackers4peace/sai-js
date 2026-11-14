/**
 * Tiny async key/value store used to keep the DPoP key pair and the session
 * across the full-page redirect of the authorization code flow.
 *
 * IndexedDB is the default in browsers because structured clone can persist a
 * `CryptoKey` (including a non-extractable one): the key survives a reload
 * without ever exposing its private half. `memoryStore` is for tests and for
 * runtimes without IndexedDB.
 */

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

/** In-memory store; nothing survives a reload. */
export function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    },
  }
}

export interface IndexedDbStoreOptions {
  /** Database name. Defaults to `sai-lws-auth`. */
  database?: string
  /** Object store name. Defaults to `key-value`. */
  store?: string
}

/** The browser store: IndexedDB, so a non-extractable key pair survives redirects. */
export function indexedDbStore(options: IndexedDbStoreOptions = {}): KeyValueStore {
  const databaseName = options.database ?? 'sai-lws-auth'
  const storeName = options.store ?? 'key-value'

  let connection: Promise<IDBDatabase> | undefined
  function open(): Promise<IDBDatabase> {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName)
        }
      })
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () =>
        reject(request.error ?? new Error('cannot open IndexedDB'))
      )
    })
    return connection
  }

  async function run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const database = await open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode)
      const request = action(transaction.objectStore(storeName))
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () =>
        reject(request.error ?? new Error('IndexedDB request failed'))
      )
    })
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return (await run('readonly', (store) => store.get(key))) as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      await run<IDBValidKey>('readwrite', (store) => store.put(value, key))
    },
    async delete(key: string): Promise<void> {
      await run<undefined>('readwrite', (store) => store.delete(key))
    },
  }
}
