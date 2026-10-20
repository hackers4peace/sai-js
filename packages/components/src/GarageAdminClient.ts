/**
 * Minimal client for the Garage **v2 administration API**
 * (`openwiki/architecture/storage-isolation.md`).
 *
 * The data server never talks to this API; it only consumes the credentials an
 * `objectEndpoint` record carries. Account provisioning (a Temporal activity)
 * uses this client, so the Garage admin token stays on the worker.
 *
 * Verified against `dxflrs/garage:v2.2.0`
 * (`doc/api/garage-admin-v2.json`, admin API v2.2.0):
 *
 * - `POST /v2/CreateBucket` `{ globalAlias }` returns `GetBucketInfoResponse`
 *   (an existing alias is an error — callers use {@link ensureBucket});
 * - `POST /v2/CreateKey` `{ name }` returns `GetKeyInfoResponse` (with the
 *   secret, the only time it is readable);
 * - `POST /v2/AllowBucketKey` `{ bucketId, accessKeyId, permissions }` — a
 *   `true` flag **activates** a permission, a `false` flag leaves it
 *   unchanged, so all three are sent true to scope a fresh key to its bucket;
 * - `GET /v2/ListBuckets` / `GET /v2/ListKeys` (arrays) are the reliable
 *   find-first lookups (an unknown id/alias is a 500, indistinguishable from a
 *   real failure);
 * - `POST /v2/DeleteBucket?id=` / `POST /v2/DeleteKey?id=` (404 on a missing
 *   resource) are the compensation primitives.
 */

/** `read`/`write`/`owner` permission flags of a bucket's access key. */
export interface GarageBucketKeyPermissions {
  read?: boolean
  write?: boolean
  owner?: boolean
}

/** Subset of `GetBucketInfoResponse` this client relies on. */
export interface GarageBucketInfo {
  id: string
  globalAliases: string[]
  /** keys already granted on the bucket (used for reconciliation) */
  keys?: {
    accessKeyId: string
    name: string
    permissions: GarageBucketKeyPermissions
  }[]
  [key: string]: unknown
}

/** Subset of `GetKeyInfoResponse` / `ListKeysResponseItem`. */
export interface GarageKeyInfo {
  accessKeyId: string
  name: string
  /** only present on creation (`CreateKey`) or `GetKeyInfo?showSecretKey=true` */
  secretAccessKey?: string | null
  [key: string]: unknown
}

export interface GarageAdminClientOptions {
  /** admin API base URL, e.g. `http://garage:3903` */
  baseUrl: string
  /** `[admin] admin_token` from `garage.toml` */
  adminToken: string
  /** injection seam for tests (defaults to the global `fetch`) */
  fetch?: typeof fetch
}

interface RequestOptions {
  query?: Record<string, string>
  body?: unknown
  /** treat a 404 as a successful no-op (idempotent delete) */
  tolerate404?: boolean
}

export class GarageAdminClient {
  private readonly baseUrl: string
  private readonly adminToken: string
  private readonly fetch: typeof fetch

  public constructor(options: GarageAdminClientOptions) {
    this.baseUrl = options.baseUrl
    this.adminToken = options.adminToken
    this.fetch = options.fetch ?? fetch
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value)
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.adminToken}` }
    const hasBody = options.body !== undefined
    if (hasBody) headers['content-type'] = 'application/json'

    const response = await this.fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    })

    if (response.status === 404 && options.tolerate404) return undefined as T
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Garage admin ${method} ${path} failed (${response.status}): ${detail.trim()}`
      )
    }

    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  // ──────────────────────────
  // Buckets
  // ──────────────────────────

  public async listBuckets(): Promise<GarageBucketInfo[]> {
    return this.request<GarageBucketInfo[]>('GET', '/v2/ListBuckets')
  }

  public async findBucketByAlias(globalAlias: string): Promise<GarageBucketInfo | undefined> {
    const buckets = await this.listBuckets()
    return buckets.find((bucket) => bucket.globalAliases?.includes(globalAlias))
  }

  /** `CreateBucket` with a global alias; errors if the alias is taken. */
  public async createBucket(globalAlias: string): Promise<GarageBucketInfo> {
    return this.request<GarageBucketInfo>('POST', '/v2/CreateBucket', {
      body: { globalAlias },
    })
  }

  /**
   * Find-first bucket creation: returns the existing bucket when the alias is
   * already taken, otherwise creates it. Retry-safe (a re-run after a partial
   * provision reuses the bucket).
   */
  public async ensureBucket(globalAlias: string): Promise<GarageBucketInfo> {
    const existing = await this.findBucketByAlias(globalAlias)
    if (existing) return existing
    return this.createBucket(globalAlias)
  }

  /** Best-effort compensation; a missing bucket (404) is a no-op. */
  public async deleteBucket(bucketId: string): Promise<void> {
    await this.request<void>('POST', '/v2/DeleteBucket', {
      query: { id: bucketId },
      tolerate404: true,
    })
  }

  // ──────────────────────────
  // Keys
  // ──────────────────────────

  public async listKeys(): Promise<GarageKeyInfo[]> {
    const items = await this.request<(GarageKeyInfo & { id?: string })[]>('GET', '/v2/ListKeys')
    // `ListKeys` names the access key id `id`; normalise to the `GetKeyInfo`
    // shape so callers see one field name.
    return items.map((item) => ({ ...item, accessKeyId: item.accessKeyId ?? item.id ?? '' }))
  }

  public async findKeyByName(name: string): Promise<GarageKeyInfo | undefined> {
    const keys = await this.listKeys()
    return keys.find((key) => key.name === name)
  }

  /** Create a key with the given name; returns its secret (readable only now). */
  public async createKey(name: string): Promise<GarageKeyInfo> {
    return this.request<GarageKeyInfo>('POST', '/v2/CreateKey', { body: { name } })
  }

  /** Grant `permissions` on the bucket to the key (true activates a flag). */
  public async allowBucketKey(
    bucketId: string,
    accessKeyId: string,
    permissions: GarageBucketKeyPermissions
  ): Promise<GarageBucketInfo> {
    return this.request<GarageBucketInfo>('POST', '/v2/AllowBucketKey', {
      body: { bucketId, accessKeyId, permissions },
    })
  }

  /** Best-effort compensation; a missing key (404) is a no-op. */
  public async deleteKey(accessKeyId: string): Promise<void> {
    await this.request<void>('POST', '/v2/DeleteKey', {
      query: { id: accessKeyId },
      tolerate404: true,
    })
  }
}
