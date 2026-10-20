/**
 * Account-bootstrap activities (openwiki/architecture/storage-isolation.md): the
 * I/O half of account creation, moved out of the synchronous
 * `AccountService.bootstrapAccount` so the whole flow runs as a Temporal
 * workflow with find-first retries and compensation.
 *
 * The workflow (temporal/workflows/account.ts) receives the derived IRIs
 * (`webId`, `docId`, `registrySet`, `dataRegistry`, …) from the starter
 * (`AccountService.startBootstrapAccount` on the auth server) and calls these
 * activities in order. Everything environment-specific (Fuseki admin, Garage
 * admin, S3 endpoint, Postgres) is read from the worker's `process.env` —
 * the worker is not a CSS server, so `CSS_`-prefixed names are fine.
 */
import {
  dataRegistryTemplate,
  registrySetTemplate,
  webIdTemplate,
} from '@janeirodigital/interop-data-model'
import { cssKv } from '@janeirodigital/interop-utils'
import postgres from 'postgres'

import { GarageAdminClient } from '../../GarageAdminClient.js'
import { getSharedEndpointStore } from '../../SessionManager.js'

/** Input to the account-bootstrap workflow/activities (all IRIs pre-derived). */
export interface BootstrapAccountInput {
  accountId: string
  handle: string
  webId: string
  docId: string
  /** the WebID's SAI authorization agent (client-id document) */
  uas: string
  /** the WebID's delegation-issuance endpoint */
  issuance: string
  /** the solid:oidcIssuer for the WebID profile (the auth base URL) */
  issuer: string
  /** the registry-set IRI (`https://<regOrigin>/<handle>/`) */
  registrySet: string
  /** the data-registry IRI (`https://<handle>.<dataOrigin>/`) */
  dataRegistry: string
}

/** Credentials the data server uses to reach its pod's bucket. */
export interface ObjectCredentials {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/** The id service's WebID-profile dataset (a single global dataset). */
const ID_DATASET = 'id'

/**
 * Dataset name for a pod — must match `packages/test-utils/src/fuseki.ts`
 * (`reg-<handle>` / `data-<pod>`). Kept inline so `components` does not depend
 * on the test-utils package.
 */
function datasetName(podUrl: string, kind: 'registry' | 'data'): string {
  const url = new URL(podUrl)
  const segment = url.pathname.split('/').filter(Boolean)[0] ?? url.hostname.split('.')[0]
  return `${kind === 'registry' ? 'reg' : 'data'}-${segment}`
}

function fusekiBaseUrl(): string {
  const url = process.env.CSS_FUSEKI_BASE_URL
  if (!url) throw new Error('CSS_FUSEKI_BASE_URL is not set')
  return url.replace(/\/$/, '')
}

/** POST a TriG payload to a Fuseki Graph Store Protocol endpoint. */
async function postTrig(endpoint: string, trig: string): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/trig' },
    body: trig,
  })
  if (!response.ok) throw new Error(`failed POSTing dataset to ${endpoint}: ${response.status}`)
}

/**
 * Best-effort dataset creation via the Fuseki admin API. Fixture pods are
 * pre-declared in `fuseki.config.ttl`; new signups need Fuseki Full with a
 * Shiro service account (`CSS_FUSEKI_ADMIN=user:password`). An "already
 * exists" response is not an error — the subsequent GSP POST is the real gate.
 */
async function ensureFusekiDataset(origin: string, name: string): Promise<void> {
  const admin = process.env.CSS_FUSEKI_ADMIN
  const response = await fetch(
    `${origin}/$/datasets?dbType=tdb2&dbName=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: admin ? { Authorization: `Basic ${Buffer.from(admin).toString('base64')}` } : {},
    }
  ).catch(() => undefined)
  if (response && !response.ok) {
    // 500 is how Fuseki reports "already exists"; anything else will surface at
    // the GSP POST below (and the activity retry is the safety net)
    const body = await response.text().catch(() => '')
    if (!body.includes('already exists')) {
      console.warn(`[account] Fuseki dataset ${name} not created: ${response.status} ${body}`)
    }
  }
}

/**
 * Ensure the three datasets of a new account exist: the registry pod, the data
 * pod and the shared `id` (WebID-profile) dataset. Find-first at Fuseki.
 */
export async function createFusekiDatasets(input: BootstrapAccountInput): Promise<void> {
  const origin = fusekiBaseUrl()
  const names = [
    datasetName(input.registrySet, 'registry'),
    datasetName(input.dataRegistry, 'data'),
    ID_DATASET,
  ]
  for (const name of names) {
    await ensureFusekiDataset(origin, name)
  }
  console.info(`[account] datasets ready for ${input.handle}`)
}

function garageAdminClient(): GarageAdminClient {
  return new GarageAdminClient({
    baseUrl: process.env.CSS_GARAGE_ADMIN_ENDPOINT ?? 'http://garage:3903',
    adminToken: process.env.CSS_GARAGE_ADMIN_TOKEN ?? '',
  })
}

function s3Endpoint(): string {
  const endpoint = process.env.CSS_S3_ENDPOINT
  if (!endpoint) throw new Error('CSS_S3_ENDPOINT is not set')
  return endpoint
}

/**
 * Provision the data pod's own bucket and a key scoped to it
 * (`read`/`write`/`owner`), returning the credentials for the objectEndpoint
 * record. Record-driven find-first: if the pod already has an endpoint record,
 * reuse it and touch nothing. Otherwise find-first the bucket (a retry reuses
 * it) and *replace* any key with the pod's name — a key's secret is only
 * readable at creation, so a retry must mint a fresh one rather than reuse an
 * unrecoverable old one. On failure the freshly minted key (and a bucket this
 * call created) are best-effort deleted.
 */
export async function createObjectBucket(input: BootstrapAccountInput): Promise<ObjectCredentials> {
  const store = await getSharedEndpointStore()
  const existing = await store.findObjectByPodUrl(input.dataRegistry)
  if (existing) {
    return {
      endpoint: existing.endpoint,
      bucket: existing.bucket,
      accessKeyId: existing.accessKeyId,
      secretAccessKey: existing.secretAccessKey,
    }
  }

  const garage = garageAdminClient()
  const bucketName = datasetName(input.dataRegistry, 'data')
  let bucket = await garage.findBucketByAlias(bucketName)
  let createdBucket = false
  if (!bucket) {
    bucket = await garage.createBucket(bucketName)
    createdBucket = true
  }

  let keyId: string | undefined
  try {
    const existingKey = await garage.findKeyByName(bucketName)
    if (existingKey) await garage.deleteKey(existingKey.accessKeyId)
    const key = await garage.createKey(bucketName)
    keyId = key.accessKeyId
    await garage.allowBucketKey(bucket.id, key.accessKeyId, {
      read: true,
      write: true,
      owner: true,
    })
    return {
      endpoint: s3Endpoint(),
      bucket: bucketName,
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey ?? '',
    }
  } catch (err) {
    if (keyId) await garage.deleteKey(keyId).catch(() => undefined)
    if (createdBucket && bucket) await garage.deleteBucket(bucket.id).catch(() => undefined)
    throw err
  }
}

/**
 * Write the pod's internal endpoint records (registry + data SPARQL, data
 * object) through the typed {@link PodEndpointStore}. Find-first per pod so a
 * workflow retry does not duplicate records.
 */
export async function writeEndpointRecords(
  input: BootstrapAccountInput,
  credentials: ObjectCredentials
): Promise<void> {
  const store = await getSharedEndpointStore()
  const origin = fusekiBaseUrl()
  const registryDataset = datasetName(input.registrySet, 'registry')
  const dataDataset = datasetName(input.dataRegistry, 'data')

  if (!(await store.findSparqlByPodUrl(input.registrySet))) {
    await store.createSparql({
      accountId: input.accountId,
      podUrl: input.registrySet,
      endpoint: `${origin}/${registryDataset}/sparql`,
    })
  }
  if (!(await store.findSparqlByPodUrl(input.dataRegistry))) {
    await store.createSparql({
      accountId: input.accountId,
      podUrl: input.dataRegistry,
      endpoint: `${origin}/${dataDataset}/sparql`,
    })
  }
  if (!(await store.findObjectByPodUrl(input.dataRegistry))) {
    await store.createObject({
      accountId: input.accountId,
      podUrl: input.dataRegistry,
      ...credentials,
    })
  }
  console.info(`[account] endpoint records ready for ${input.handle}`)
}

/**
 * Post the bootstrap TriG: the WebID profile into the `id` dataset, the
 * registry set into the registry dataset and the data registry into the data
 * dataset. GSP POST is additive, so a retry is safe.
 */
export async function postBootstrapTriG(input: BootstrapAccountInput): Promise<void> {
  const origin = fusekiBaseUrl()
  const registryDataset = datasetName(input.registrySet, 'registry')
  const dataDataset = datasetName(input.dataRegistry, 'data')

  await postTrig(
    `${origin}/${ID_DATASET}/data`,
    webIdTemplate({
      id: input.webId,
      document: input.docId,
      issuer: input.issuer,
      uas: input.uas,
      issuance: input.issuance,
    })
  )
  await postTrig(
    `${origin}/${registryDataset}/data`,
    registrySetTemplate({
      id: input.registrySet,
      webId: input.webId,
      uas: input.uas,
      dataRegistry: input.dataRegistry,
    })
  )
  await postTrig(`${origin}/${dataDataset}/data`, dataRegistryTemplate({ id: input.dataRegistry }))
  console.info(`[account] bootstrap TriG posted for ${input.handle}`)
}

let sqlClient: ReturnType<typeof postgres> | undefined
function getSql(): ReturnType<typeof postgres> {
  if (!sqlClient) {
    const connectionString = process.env.CSS_POSTGRES_CONNECTION_STRING
    if (!connectionString) throw new Error('CSS_POSTGRES_CONNECTION_STRING is not set')
    sqlClient = postgres(connectionString, {
      connection: { options: '-c client_min_messages=warning' },
    })
  }
  return sqlClient
}

/**
 * Write the account's pod/owner/WebID-link records (the "existing blob"): the
 * data pod, its owner and the reverse WebID link, plus their account indexes.
 * Find-first: an account that already has a `**webIdLink**` is bootstrapped.
 */
export async function writeAccountRecords(input: BootstrapAccountInput): Promise<void> {
  const sql = getSql()
  const key = cssKv.accountData(input.accountId)
  const rows = await sql`SELECT value FROM key_value WHERE key = ${key}`
  if (rows.length === 0) throw new Error(`account ${input.accountId} does not exist`)
  const accountData = JSON.parse(rows[0].value)
  // CSS's storage initializes every child container to `{}` when the account
  // is created, so `**webIdLink**` is always present — it is only *bootstrapped*
  // once it has an entry.
  if (Object.keys(accountData['**webIdLink**'] ?? {}).length > 0) return

  const ids = {
    pod: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    webId: crypto.randomUUID(),
  }
  accountData['**pod**'] = {
    [ids.pod]: {
      baseUrl: input.dataRegistry,
      accountId: input.accountId,
      id: ids.pod,
      '**owner**': {
        [ids.owner]: {
          webId: input.webId,
          visible: true,
          podId: ids.pod,
          id: ids.owner,
        },
      },
    },
  }
  accountData['**webIdLink**'] = {
    [ids.webId]: {
      webId: input.webId,
      accountId: input.accountId,
      id: ids.webId,
    },
  }

  const record = {
    [key]: accountData,
    [cssKv.webIdLink(ids.webId)]: [input.accountId],
    [cssKv.webIdLinkByWebId(input.webId)]: [input.accountId],
    [cssKv.owner(ids.owner)]: [input.accountId],
    [cssKv.pod(ids.pod)]: [input.accountId],
    [cssKv.podByBaseUrl(input.dataRegistry)]: [input.accountId],
  }
  const entries = Object.entries(record).map(([entryKey, value]) => ({
    key: entryKey,
    value: JSON.stringify(value),
  }))
  await sql`
    INSERT INTO key_value ${sql(entries as any)}
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `
  console.info(`[account] account records ready for ${input.handle}`)
}
