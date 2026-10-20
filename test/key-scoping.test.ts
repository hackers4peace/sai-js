import { Postgres } from '@janeirodigital/interop-test-utils'
import { S3mini } from 's3mini'
import { afterAll, describe, expect, test } from 'vitest'

// ──────────────────────────────────────────────────────────────────────────
// Per-data-pod object isolation (openwiki/architecture/storage-isolation.md).
//
// The seed gives every data pod its own bucket + key (from its `objectEndpoint`
// record). These are the same credentials the data server uses, so exercising
// them directly is the exact isolation contract: a pod's key can only touch its
// own bucket. (The per-pod routing of LDP reads/writes itself is covered by the
// RoutedS3DataAccessor unit tests and the binary reads of the rest of the suite.)
// ──────────────────────────────────────────────────────────────────────────

const connectionString = 'postgres://temporal:temporal@postgresql:5432/auth'
const s3Endpoint = (process.env.CSS_S3_ENDPOINT ?? 'http://garage:3900').replace(/\/$/, '')
const region = process.env.CSS_S3_REGION ?? 'garage'
const pg = new Postgres(connectionString, 'key_value')

// two data pods of the seeded alice account
const podA = 'https://data/alice-home/'
const podB = 'https://data/alice-work/'

interface ObjectEndpoint {
  podUrl: string
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/** The data pod's typed object endpoint record, as the data server reads it. */
async function objectEndpoint(podUrl: string): Promise<ObjectEndpoint> {
  const kv = await pg.exportToJson()
  const [accountId] = kv[
    `accounts/index/objectEndpoint/podUrl/${encodeURIComponent(podUrl)}`
  ] as string[]
  const account = kv[`accounts/data/${accountId}`] as any
  const record = Object.values<any>(account['**objectEndpoint**']).find((r) => r.podUrl === podUrl)
  if (!record) throw new Error(`no objectEndpoint record for ${podUrl}`)
  return record
}

/** An S3 client for `bucket` using the pod's own key (defaults to its bucket). */
function s3For(record: ObjectEndpoint, bucket: string = record.bucket): S3mini {
  return new S3mini({
    endpoint: `${s3Endpoint}/${bucket}`,
    accessKeyId: record.accessKeyId,
    secretAccessKey: record.secretAccessKey,
    region,
  })
}

afterAll(async () => {
  await pg.sql.end()
})

describe('per-data-pod S3 key scoping', () => {
  test('every data pod has its own bucket and key', async () => {
    const [a, b] = await Promise.all([objectEndpoint(podA), objectEndpoint(podB)])

    expect(a.bucket).not.toBe(b.bucket)
    expect(a.accessKeyId).not.toBe(b.accessKeyId)
    expect(a.endpoint).toBe(s3Endpoint)
  })

  test('a pod key can upload to and read its own bucket', async () => {
    const a = await objectEndpoint(podA)
    const key = 'key-scoping/own.txt'

    await s3For(a).putAnyObject(key, 'pod-a', 'text/plain')
    const response = await s3For(a).getObjectResponse(key)

    expect(response?.status).toBe(200)
    expect(await response!.text()).toBe('pod-a')

    await s3For(a).deleteObject(key)
  })

  test("a pod key cannot read or write another pod's bucket (403)", async () => {
    const [a, b] = await Promise.all([objectEndpoint(podA), objectEndpoint(podB)])
    const key = 'key-scoping/cross.txt'

    // the blob lives in pod B's bucket, uploaded with pod B's own key
    await s3For(b).putAnyObject(key, 'pod-b', 'text/plain')

    // pod A's key is scoped to pod A's bucket
    await expect(s3For(a, b.bucket).getObjectResponse(key)).rejects.toThrow(/403|AccessDenied/)
    await expect(s3For(a, b.bucket).putAnyObject(key, 'nope', 'text/plain')).rejects.toThrow(
      /403|AccessDenied/
    )

    await s3For(b).deleteObject(key)
  })
})
