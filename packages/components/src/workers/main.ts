import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2'
import { NativeConnection, Worker } from '@temporalio/worker'

import * as accessRequestActivities from '../temporal/activities/access-request.js'
import * as accountActivities from '../temporal/activities/account.js'
import * as adminActivities from '../temporal/activities/admin.js'
import * as forwardActivities from '../temporal/activities/forward-to-push.js'
import * as grantsActivities from '../temporal/activities/grants.js'
import * as invitationActivities from '../temporal/activities/invitation.js'
import * as reciprocalActivities from '../temporal/activities/reciprocal.js'
import * as webhookActivities from '../temporal/activities/webhook-delivery.js'
import { WEBHOOK_DELIVERY_TASK_QUEUE } from '../temporal/queues.js'
import { initNodeTracing } from '../tracing/bootstrap.js'
import { temporalPluginConfig } from '../tracing/otel-state.js'

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
  // no-op unless an OTLP endpoint is set
  const otelSdk = await initNodeTracing('sai-worker')
  const pluginConfig = temporalPluginConfig()
  const plugins = pluginConfig ? [new OpenTelemetryPlugin(pluginConfig)] : []

  try {
    const forward = await Worker.create({
      connection,
      taskQueue: 'forward-to-push',
      workflowsPath: fileURLToPath(
        new URL('../temporal/workflows/forward-to-push.js', import.meta.url)
      ),
      activities: forwardActivities,
      plugins,
    })

    const reciprocal = await Worker.create({
      connection,
      taskQueue: 'reciprocal-registration',
      workflowsPath: fileURLToPath(new URL('../temporal/workflows/reciprocal.js', import.meta.url)),
      // markActivitiesDone (from grants) is called by establishReciprocal — it
      // must be registered on the queue that workflow runs on
      activities: { ...reciprocalActivities, ...grantsActivities },
      plugins,
    })

    const webhook = await Worker.create({
      connection,
      taskQueue: WEBHOOK_DELIVERY_TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL('../temporal/workflows/webhook-delivery.js', import.meta.url)
      ),
      activities: webhookActivities,
      plugins,
    })

    const grants = await Worker.create({
      connection,
      taskQueue: 'create-grants',
      workflowsPath: fileURLToPath(
        new URL('../temporal/workflows/create-grants.js', import.meta.url)
      ),
      // grants + org-admin + activity-first invitation activities — the
      // combined workflow module calls names from all three (the admin
      // workflows also use markActivitiesDone)
      activities: {
        ...grantsActivities,
        ...adminActivities,
        ...invitationActivities,
        ...accessRequestActivities,
        ...accountActivities,
      },
      plugins,
    })

    // Run all workers simultaneously
    await Promise.all([forward.run(), reciprocal.run(), grants.run(), webhook.run()])
  } finally {
    // flush pending spans before the process exits (dagger kills the service
    // right after the test exec)
    await otelSdk?.shutdown()
    // only close once every worker is done — while a worker still holds the
    // connection close() throws IllegalStateError, which must not mask the
    // actual worker failure below
    try {
      await connection.close()
    } catch (err) {
      console.error('failed to close connection:', err)
    }
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
