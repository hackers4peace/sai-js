import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { NativeConnection, Worker } from '@temporalio/worker'
import * as forwardActivities from '../temporal/activities/forward-to-push.js'
import * as grantsActivities from '../temporal/activities/grants.js'
import * as reciprocalActivities from '../temporal/activities/reciprocal.js'

async function connectWithRetry() {
  while (true) {
    try {
      return await NativeConnection.connect({
        address: process.env.TEMPORAL_ADDRESS,
      })
    } catch (err) {
      console.error('Temporal not ready, retrying...', err.message)
      await sleep(500)
    }
  }
}
async function run() {
  const connection = await connectWithRetry()

  try {
    const forward = await Worker.create({
      connection,
      taskQueue: 'forward-to-push',
      workflowsPath: fileURLToPath(
        new URL('../temporal/workflows/forward-to-push.js', import.meta.url)
      ),
      activities: forwardActivities,
    })

    const reciprocal = await Worker.create({
      connection,
      taskQueue: 'reciprocal-registration',
      workflowsPath: fileURLToPath(new URL('../temporal/workflows/reciprocal.js', import.meta.url)),
      activities: reciprocalActivities,
    })

    const grants = await Worker.create({
      connection,
      taskQueue: 'create-grants',
      workflowsPath: fileURLToPath(new URL('../temporal/workflows/grants.js', import.meta.url)),
      activities: grantsActivities,
    })

    // Run all workers simultaneously
    await Promise.all([forward.run(), reciprocal.run(), grants.run()])
  } finally {
    await connection.close()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
