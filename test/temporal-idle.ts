import { Client, Connection } from '@temporalio/client'

/** How long a workflow from the previous test may keep running. */
const IDLE_TIMEOUT = 120_000
const POLL_INTERVAL = 200
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default'

export interface TemporalIdleOptions {
  address?: string
  /**
   * Only workflows that STARTED after this instant count as activity. A
   * workflow that starts and completes between two checks still wrote after the
   * seed that preceded it, so `ListWorkflowExecutions` — not the live queue
   * state — is the source of truth.
   */
  since?: Date
  /** How long the namespace has to stay without activity before returning. */
  quietMs?: number
  /** How long to wait for the workflows to end before failing. */
  timeoutMs?: number
  /** Called whenever a running or post-`since` workflow is observed. */
  onActivity?: () => void
}

/**
 * Wait until no Temporal workflow is running and no workflow has started since
 * `since`. This is the test suites' isolation barrier: a workflow (or a webhook
 * delivery that starts one) from the previous test must not write after the
 * next test's fixture seed.
 *
 * Never terminates a workflow: seeding while a workflow runs fails its
 * activities and Temporal retries them, which is exactly the late write the
 * barrier is meant to prevent. If the namespace does not quiesce within
 * `timeoutMs`, this throws and the harness fails instead of forging ahead.
 *
 * `quietMs` covers visibility indexing lag: the checks repeat for that long
 * after the namespace first looks idle. Callers that pass `since` re-seed when
 * activity was seen, because the activity may have written after their seed.
 */
export async function waitForTemporalIdle(options: TemporalIdleOptions = {}): Promise<void> {
  const {
    address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    since,
    quietMs = 0,
    timeoutMs = IDLE_TIMEOUT,
    onActivity,
  } = options
  const connection = await Connection.connect({ address })
  const client = new Client({ connection })
  const deadline = Date.now() + timeoutMs
  let quietSince: number | undefined = quietMs === 0 ? Date.now() : undefined
  try {
    for (;;) {
      const running = await listWorkflows(client, 'ExecutionStatus="Running"')
      const startedSince = since
        ? await listWorkflows(client, `StartTime > "${since.toISOString()}"`)
        : []
      if (running.length > 0 || startedSince.length > 0) {
        onActivity?.()
        quietSince = undefined
        if (Date.now() >= deadline) {
          const ids = running
            .map((execution) => execution.execution?.workflowId)
            .filter((workflowId): workflowId is string => !!workflowId)
          throw new Error(
            `Temporal did not quiesce within ${timeoutMs}ms; still running: ${ids.join(', ') || 'unknown'}`
          )
        }
      } else {
        quietSince ??= Date.now()
        if (Date.now() - quietSince >= quietMs) {
          return
        }
      }
      await sleep(POLL_INTERVAL)
    }
  } finally {
    await connection.close()
  }
}

interface WorkflowExecution {
  execution?: { workflowId?: string | null; runId?: string | null } | null
}

/** Every execution matching a visibility query, all pages. */
async function listWorkflows(client: Client, query: string): Promise<Array<WorkflowExecution>> {
  const executions: Array<WorkflowExecution> = []
  let nextPageToken: Uint8Array | undefined
  do {
    const response = await client.workflowService.listWorkflowExecutions({
      namespace: NAMESPACE,
      query,
      ...(nextPageToken ? { nextPageToken } : {}),
    })
    executions.push(...(response.executions ?? []))
    nextPageToken = response.nextPageToken
  } while (nextPageToken && nextPageToken.length > 0)
  return executions
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

if (process.argv[1] === import.meta.filename) {
  // CLI for the Playwright fixture: `[quietMs] [sinceIso]`, then one line:
  // `activity` when a running or post-`since` workflow was observed (the
  // fixture seed is stale), `quiet` otherwise.
  const quietMs = Number(process.argv[2] ?? 0)
  const since = process.argv[3] ? new Date(process.argv[3]) : undefined
  let activity = false
  await waitForTemporalIdle({
    quietMs,
    since,
    onActivity: () => {
      activity = true
    },
  })
  console.log(activity ? 'activity' : 'quiet')
  process.exit(0)
}
