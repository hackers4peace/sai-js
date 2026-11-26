import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import {
  Postgres,
  fixturePodDatasets,
  seedFusekiDataset,
  seedObjectEndpoints,
  splitFixtureByPod,
} from '@janeirodigital/interop-test-utils'
import { S3mini } from 's3mini'

// Test fixtures (environments/data) seeded into the dagger services: the
// account key-value store (Postgres), one Fuseki dataset per pod, and the
// per-pod Garage buckets. Used by setup.ts (vitest) before every test, and run
// directly (`node seed.ts`) by `dagger call playwright` before the browser suite.

const connectionString = 'postgres://temporal:temporal@postgresql:5432/auth'
const fusekiBaseUrl = 'http://fuseki:3030'
const dataDir = new URL('../environments/data/', import.meta.url)
const clientId = 'https://data/test-client/public/id'

export interface TestSeed {
  /** (re)seed the key-value store and the per-pod Fuseki datasets */
  seed(): Promise<void>
  putClientId(): Promise<void>
  deleteClientId(): Promise<void>
}

export async function prepareTestSeed(): Promise<TestSeed> {
  const kvData = JSON.parse(await readFile(new URL('kv.json', dataDir), 'utf8'))
  const datasetData = await readFile(new URL('registry.trig', dataDir), 'utf8')

  // stage 3: one Fuseki dataset per pod. The fixture's registry origin is the
  // raw `https://registry/` in the dagger environment.
  const accounts = Object.values(kvData).flatMap((value: any) => {
    if (!value || !value['**pod**']) {
      return []
    }
    return [
      {
        webId: (Object.values(value['**webIdLink**'])[0] as any).webId,
        podBaseUrls: Object.values(value['**pod**']).map((pod: any) => pod.baseUrl),
      },
    ]
  })
  const podDatasets = fixturePodDatasets(accounts, 'https://registry/')
  const datasets = await splitFixtureByPod(datasetData, { podDatasets, idOrigin: 'https://id/' })

  // per-pod buckets/keys: provision them through the Garage admin API and merge
  // the generated objectEndpoint records into the fixture before it is seeded
  // (there is no shared bucket anymore)
  const s3Endpoint = (process.env.CSS_S3_ENDPOINT ?? 'http://garage:3900').replace(/\/$/, '')
  const objectEndpoints = await seedObjectEndpoints(kvData, {
    adminBaseUrl: process.env.CSS_GARAGE_ADMIN_ENDPOINT ?? 'http://garage:3903',
    adminToken: process.env.CSS_GARAGE_ADMIN_TOKEN ?? '',
    s3Endpoint,
  })
  const testClientCredentials = objectEndpoints.get('https://data/test-client/')
  if (!testClientCredentials) {
    throw new Error('seed did not provision the test-client object endpoint')
  }

  const pg = new Postgres(connectionString, 'key_value')

  const clientIdData = await readFile(new URL('test-client/public/id$.jsonld', dataDir))
  const garage = new S3mini({
    // s3mini derives the bucket from the endpoint URL path
    endpoint: `${s3Endpoint}/${testClientCredentials.bucket}`,
    accessKeyId: testClientCredentials.accessKeyId,
    secretAccessKey: testClientCredentials.secretAccessKey,
    region: process.env.CSS_S3_REGION ?? 'garage',
  })

  return {
    async seed() {
      await pg.seedKeyValue(kvData)
      for (const [dataset, trig] of datasets) {
        await seedFusekiDataset(`${fusekiBaseUrl}/${dataset}`, trig)
      }
    },
    async putClientId() {
      await garage.putAnyObject(clientId, clientIdData, 'application/ld+json')
    },
    async deleteClientId() {
      await garage.deleteObject(clientId)
    },
  }
}

if (process.argv[1] === import.meta.filename) {
  const testSeed = await prepareTestSeed()
  await testSeed.putClientId()
  if (process.argv[2] === '--serve') {
    // prepare once (Garage buckets/keys and the objectEndpoint records), then
    // seed the KV + Fuseki on each `seed` line: the Playwright suite does this
    // before every test, like vitest's setup.ts. Re-preparing between tests
    // would mint new objectEndpoint records the running services may not see.
    console.log('test fixtures ready')
    for await (const line of createInterface({ input: process.stdin })) {
      if (line.trim() !== 'seed') {
        continue
      }
      await testSeed.seed()
      console.log('test fixtures seeded')
    }
  } else {
    await testSeed.seed()
    console.log('test fixtures seeded')
  }
  // the Postgres client keeps the event loop alive
  process.exit(0)
}
