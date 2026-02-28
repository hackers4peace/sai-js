import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { Postgres, seedQuadstore } from '@janeirodigital/interop-test-utils'
import { S3mini } from 's3mini'
import { afterAll, beforeAll, beforeEach } from 'vitest'

const connectionString = 'postgres://temporal:temporal@postgresql:5432/auth'
const keyValuePath = '../packages/css-storage-fixture/test/kv.json'

const sparqlEndpoint = 'http://sparql/store'
const datasetPath = '../packages/css-storage-fixture/test/registry.trig'

const kvData = JSON.parse(await readFile(keyValuePath, 'utf8'))
const datasetData = await readFile(datasetPath, 'utf8')

const clientId = 'https://data/test-client/public/id'
const clientIdPath = '../packages/css-storage-fixture/test/data/test-client/public/id$.jsonld'

const pg = new Postgres(connectionString, 'key_value')

const clientIdData = await readFile(clientIdPath)
const garage = new S3mini({
  endpoint: process.env.CSS_S3_ENDPOINT ?? 'http://garage:3900/sai-dev',
  accessKeyId: process.env.CSS_S3_ACCESS_KEY_ID ?? 'GKd0656430cbd2bba62e2cc12b',
  secretAccessKey:
    process.env.CSS_S3_SECRET_ACCESS_KEY ??
    'aa3594ca915bf7b310c7672d436f2a937f20d2ad022eec90345dfc364e1bdd4c',
  region: process.env.CSS_S3_REGION ?? 'garage',
})

beforeAll(async () => {
  await garage.putAnyObject(clientId, clientIdData, 'application/ld+json')
})
afterAll(async () => {
  await garage.deleteObject(clientId)
})
beforeEach(async () => {
  await pg.seedKeyValue(kvData)
  await seedQuadstore(sparqlEndpoint, datasetData)
})
