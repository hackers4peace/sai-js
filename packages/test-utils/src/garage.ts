/**
 * Per-data-pod Garage seeding (openwiki/architecture/storage-isolation.md).
 *
 * There is no shared bucket: each data pod gets its own bucket + key, created
 * through the Garage v2 admin API. Keys are generated, so they cannot live in
 * the static `kv.json` fixture — this helper provisions them at seed time and
 * merges the typed `objectEndpoint` records (and their indexes) into the
 * fixture before it is written to the key-value store.
 *
 * Find-first / idempotent: an existing bucket is reused and an existing key's
 * secret is read back with `GetKeyInfo?showSecretKey=true`, so re-running the
 * seed (e.g. once per test file, or a repeated `seed-env`) does not churn keys.
 */
import { datasetForPod } from './fuseki.ts'

export interface ObjectEndpointSeed {
  podUrl: string
  /** bucket-less S3 endpoint the data server uses */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface SeedObjectEndpointsOptions {
  /** Garage v2 admin API base URL, e.g. `http://garage:3903` */
  adminBaseUrl: string
  /** `[admin] admin_token` from `garage.toml` */
  adminToken: string
  /** bucket-less S3 endpoint stored on the record, e.g. `http://garage:3900` */
  s3Endpoint: string
}

interface StoredObjectEndpoint extends ObjectEndpointSeed {
  accountId: string
  id: string
}

interface BucketInfo {
  id: string
  globalAliases: string[]
}

interface KeyInfo {
  accessKeyId?: string
  id?: string
  name: string
  secretAccessKey?: string | null
}

interface RequestOptions {
  query?: Record<string, string>
  body?: unknown
}

async function admin<T>(
  options: SeedObjectEndpointsOptions,
  method: 'GET' | 'POST',
  path: string,
  request: RequestOptions = {}
): Promise<T> {
  const url = new URL(path, options.adminBaseUrl)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value)
  }
  const headers: Record<string, string> = { authorization: `Bearer ${options.adminToken}` }
  const hasBody = request.body !== undefined
  if (hasBody) headers['content-type'] = 'application/json'
  const init: RequestInit = { method, headers }
  if (hasBody) init.body = JSON.stringify(request.body)
  const response = await fetch(url, init)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Garage admin ${method} ${path} failed (${response.status}): ${detail.trim()}`)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * Provision a bucket + key per data pod of the fixture and merge the resulting
 * `objectEndpoint` records and `accounts/index/objectEndpoint/…` indexes into
 * `kv` (in place). Returns `podUrl → credentials` so callers can seed pod
 * objects (e.g. the test client document).
 *
 * The bucket/key name is the pod's Fuseki dataset name — taken from the
 * fixture's own `sparqlEndpoint` record when present (the runtime resolves pods
 * through those, and the dev/demo map can rename a pod while its dataset stays
 * canonical), falling back to `datasetForPod`.
 */
export async function seedObjectEndpoints(
  kv: Record<string, any>,
  options: SeedObjectEndpointsOptions
): Promise<Map<string, ObjectEndpointSeed>> {
  const byPodUrl = new Map<string, ObjectEndpointSeed>()

  const datasetByPodUrl = new Map<string, string>()
  for (const accountData of Object.values(kv)) {
    for (const record of Object.values<any>((accountData as any)?.['**sparqlEndpoint**'] ?? {})) {
      const [dataset] = new URL(record.endpoint).pathname.split('/').filter(Boolean)
      datasetByPodUrl.set(record.podUrl, dataset)
    }
  }

  // list once; created resources are added to these maps
  const buckets = await admin<BucketInfo[]>(options, 'GET', '/v2/ListBuckets')
  const bucketByAlias = new Map<string, BucketInfo>()
  for (const bucket of buckets) {
    for (const alias of bucket.globalAliases ?? []) bucketByAlias.set(alias, bucket)
  }
  const keys = await admin<KeyInfo[]>(options, 'GET', '/v2/ListKeys')
  const keyByName = new Map<string, KeyInfo>(keys.map((key) => [key.name, key]))

  const ensureBucket = async (alias: string): Promise<BucketInfo> => {
    const existing = bucketByAlias.get(alias)
    if (existing) return existing
    const created = await admin<BucketInfo>(options, 'POST', '/v2/CreateBucket', {
      body: { globalAlias: alias },
    })
    bucketByAlias.set(alias, created)
    return created
  }

  const ensureKey = async (
    name: string
  ): Promise<{ accessKeyId: string; secretAccessKey: string }> => {
    const existing = keyByName.get(name)
    if (existing) {
      const id = existing.accessKeyId ?? existing.id ?? ''
      // a key's secret is not in the list response; read it back explicitly
      const info = await admin<KeyInfo>(options, 'GET', '/v2/GetKeyInfo', {
        query: { id, showSecretKey: 'true' },
      })
      return { accessKeyId: id, secretAccessKey: info.secretAccessKey ?? '' }
    }
    const created = await admin<KeyInfo>(options, 'POST', '/v2/CreateKey', { body: { name } })
    keyByName.set(name, created)
    return {
      accessKeyId: created.accessKeyId ?? '',
      secretAccessKey: created.secretAccessKey ?? '',
    }
  }

  for (const [key, accountData] of Object.entries(kv)) {
    if (!key.startsWith('accounts/data/') || !accountData || typeof accountData !== 'object')
      continue
    const pods = accountData['**pod**']
    if (!pods) continue
    const accountId: string =
      accountData.id ?? (Object.values<any>(pods)[0]?.accountId as string | undefined) ?? ''
    if (!accountId) continue

    const records: Record<string, StoredObjectEndpoint> = {}
    for (const pod of Object.values<any>(pods)) {
      const podUrl: string = pod.baseUrl
      const bucket = datasetByPodUrl.get(podUrl) ?? datasetForPod(podUrl, 'data')
      const bucketInfo = await ensureBucket(bucket)
      const keyInfo = await ensureKey(bucket)
      await admin(options, 'POST', '/v2/AllowBucketKey', {
        body: {
          bucketId: bucketInfo.id,
          accessKeyId: keyInfo.accessKeyId,
          permissions: { read: true, write: true, owner: true },
        },
      })

      const credentials: ObjectEndpointSeed = {
        podUrl,
        endpoint: options.s3Endpoint,
        bucket,
        accessKeyId: keyInfo.accessKeyId,
        secretAccessKey: keyInfo.secretAccessKey,
      }
      const id = crypto.randomUUID()
      records[id] = { ...credentials, accountId, id }
      byPodUrl.set(podUrl, credentials)

      kv[`accounts/index/objectEndpoint/${id}`] = [accountId]
      kv[`accounts/index/objectEndpoint/accountId/${accountId}`] = [accountId]
      kv[`accounts/index/objectEndpoint/podUrl/${encodeURIComponent(podUrl)}`] = [accountId]
    }
    accountData['**objectEndpoint**'] = records
  }

  return byPodUrl
}
