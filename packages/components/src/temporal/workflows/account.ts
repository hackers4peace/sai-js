// Account-bootstrap workflow (openwiki/architecture/storage-isolation.md): account
// creation runs as a Temporal workflow so a half-created account (datasets or
// bucket without records) is retried, and Garage is provisioned by the worker
// (which holds the admin token), never by the auth server.
//
// The starter (`AccountService.startBootstrapAccount`) derives the IRIs and
// passes them in; the activities do the Fuseki/Garage/record I/O.
import { proxyActivities } from '@temporalio/workflow'

import type { BootstrapAccountInput, ObjectCredentials } from '../activities/account.js'
import type * as accountActivities from '../activities/account.js'

const {
  createFusekiDatasets,
  createObjectBucket,
  writeEndpointRecords,
  postBootstrapTriG,
  writeAccountRecords,
} = proxyActivities<typeof accountActivities>({
  startToCloseTimeout: '2 minutes',
})

/** Runs the five account-bootstrap activities in order (each find-first). */
export async function bootstrapAccount(input: BootstrapAccountInput): Promise<void> {
  await createFusekiDatasets(input)
  const credentials: ObjectCredentials = await createObjectBucket(input)
  await writeEndpointRecords(input, credentials)
  await postBootstrapTriG(input)
  await writeAccountRecords(input)
}
