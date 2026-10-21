import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// The delegated-grants consumer is a Temporal workflow function, so it runs
// against a mocked `@temporalio/workflow`: `proxyActivities` hands back
// scripted activities, `condition`/`setHandler` drive the idle loop, and
// `executeChild`/`startChild` record the child starts. That is what makes the
// ORDER observable here — replicate → regenerate → complete — without a
// Temporal test server (none is used in this repo; the real end-to-end
// ordering is covered by the dagger suite).
// ──────────────────────────

interface ChildOptions {
  taskQueue?: string
  args?: unknown[]
  workflowId?: string
}

interface PendingActivity {
  id: string
  type: string[]
  actor: string
  target: string
  object: string
  createdAt: string
}

const h = vi.hoisted(() => {
  const calls: string[] = []
  const state: {
    batches: PendingActivity[][]
    pending: PendingActivity[]
    signal?: () => void
    fireSignalOnNextWait: boolean
    mirrorOptions?: ChildOptions
    consumerOptions?: ChildOptions
    /** what the mirror child reports back (terminal peer-gone case) */
    mirrorResult: { peerGone: boolean }
  } = { batches: [], pending: [], fireSignalOnNextWait: false, mirrorResult: { peerGone: false } }

  const activities = {
    // the per-peer drain
    getPendingDelegatedGrantsUpdates: vi.fn(async () => state.batches.shift() ?? []),
    // the sweep's registry scan
    getPendingActivities: vi.fn(async () => state.pending),
    // `updateDelegatedGrants` runs for real (same module) — its first activity
    // marks the regenerate step in the recorded order
    findAffectedGrantees: vi.fn(async () => {
      calls.push('regenerate')
      return []
    }),
    markActivitiesDone: vi.fn(async () => {
      calls.push('complete')
    }),
  }

  return { calls, state, activities }
})

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  // the idle wait: a scripted signal (a delivery landed mid-flight) or exit
  condition: async (predicate: () => boolean) => {
    if (!h.state.fireSignalOnNextWait) return predicate()
    h.state.fireSignalOnNextWait = false
    h.state.signal?.()
    return predicate()
  },
  defineSignal: (name: string) => name,
  executeChild: async (_workflow: unknown, options?: ChildOptions) => {
    if (options?.taskQueue === 'reciprocal-registration') {
      h.calls.push('mirror')
      h.state.mirrorOptions = options
      return h.state.mirrorResult
    } else if (options?.workflowId?.startsWith('delegated-grants:')) {
      h.calls.push('consumer')
      h.state.consumerOptions = options
    } else {
      h.calls.push('grants-child')
    }
  },
  proxyActivities: () => h.activities,
  setHandler: (_signal: unknown, handler: () => void) => {
    h.state.signal = handler
  },
  startChild: async () => {
    h.calls.push('detect-granted')
  },
  workflowInfo: () => ({ workflowId: 'delegated-grants:https://id/acme:https://id/bob' }),
}))

import {
  processDelegatedGrantsUpdated,
  reconcileActivities,
} from '../src/temporal/workflows/grants.js'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const webId = { id: 'https://id/acme', type: [SOCIAL_AGENT_TYPE] }
const peerId = { id: 'https://id/bob', type: [SOCIAL_AGENT_TYPE] }

const pendingActivity = (id: string): PendingActivity => ({
  id,
  type: ['Activity', 'DelegatedGrantsUpdated'],
  actor: webId.id,
  target: peerId.id,
  object: 'https://registry/bob/social-agent/x7n2qv/',
  createdAt: new Date().toISOString(),
})

beforeEach(() => {
  h.calls.length = 0
  h.state.batches = []
  h.state.pending = []
  h.state.fireSignalOnNextWait = false
  h.state.mirrorOptions = undefined
  h.state.consumerOptions = undefined
  h.state.mirrorResult = { peerGone: false }
  vi.clearAllMocks()
})

describe('processDelegatedGrantsUpdated — per-peer consumer', () => {
  test('replicates, regenerates, then completes — in that order', async () => {
    const first = pendingActivity('https://registry/acme/activity/a1')
    h.state.batches = [[first]]

    await processDelegatedGrantsUpdated({ webId, peerId })

    expect(h.calls).toEqual(['mirror', 'regenerate', 'detect-granted', 'complete'])
    // the mirror child runs on the reciprocal queue with the consumer's payload
    expect(h.state.mirrorOptions).toMatchObject({
      taskQueue: 'reciprocal-registration',
      args: [{ webId, peerId }],
    })
    // regeneration WITHOUT `activityId` — with one, `updateDelegatedGrants`
    // would self-complete before the consumer owns the barrier
    expect(h.activities.findAffectedGrantees).toHaveBeenCalledWith({ webId, peerId })
    expect(h.activities.markActivitiesDone).toHaveBeenCalledWith({
      webId,
      activities: [first],
    })
  })

  test('coalesces a burst into one replicate/regenerate/completion', async () => {
    const first = pendingActivity('https://registry/acme/activity/a1')
    const second = pendingActivity('https://registry/acme/activity/a2')
    h.state.batches = [[first, second]]

    await processDelegatedGrantsUpdated({ webId, peerId })

    expect(h.calls).toEqual(['mirror', 'regenerate', 'detect-granted', 'complete'])
    expect(h.activities.markActivitiesDone).toHaveBeenCalledTimes(1)
    expect(h.activities.markActivitiesDone).toHaveBeenCalledWith({
      webId,
      activities: [first, second],
    })
  })

  test('a delivery that lands mid-flight is drained again — no lost update', async () => {
    const first = pendingActivity('https://registry/acme/activity/a1')
    const second = pendingActivity('https://registry/acme/activity/a2')
    // second drain empty → idle wait → signal → third drain has the new one
    h.state.batches = [[first], [], [second]]
    h.state.fireSignalOnNextWait = true

    await processDelegatedGrantsUpdated({ webId, peerId })

    expect(h.calls).toEqual([
      'mirror',
      'regenerate',
      'detect-granted',
      'complete',
      // the re-drain syncs the mirror AFTER the second delivery, so the last
      // regeneration can never be based on the pre-delivery mirror
      'mirror',
      'regenerate',
      'detect-granted',
      'complete',
    ])
    expect(h.activities.markActivitiesDone).toHaveBeenNthCalledWith(1, {
      webId,
      activities: [first],
    })
    expect(h.activities.markActivitiesDone).toHaveBeenNthCalledWith(2, {
      webId,
      activities: [second],
    })
  })

  test('a peer-gone sync completes the batch without regenerating', async () => {
    const first = pendingActivity('https://registry/acme/activity/a1')
    h.state.batches = [[first]]
    // the peer deleted its registration of us: the mirror child drops the
    // replica and reports it — there is no source to regenerate from
    h.state.mirrorResult = { peerGone: true }

    await processDelegatedGrantsUpdated({ webId, peerId })

    expect(h.calls).toEqual(['mirror', 'complete'])
    expect(h.activities.findAffectedGrantees).not.toHaveBeenCalled()
    expect(h.activities.markActivitiesDone).toHaveBeenCalledWith({
      webId,
      activities: [first],
    })
  })

  test('exits without replicating when nothing is pending', async () => {
    h.state.batches = [[]]

    await processDelegatedGrantsUpdated({ webId, peerId })

    expect(h.calls).toEqual([])
    expect(h.activities.markActivitiesDone).not.toHaveBeenCalled()
  })
})

describe('reconcileActivities — delegatedGrantsUpdated arm', () => {
  test('starts the per-peer consumer and leaves completion to it', async () => {
    h.state.pending = [pendingActivity('https://registry/acme/activity/a1')]

    await reconcileActivities({ webId })

    // the sweep starts the consumer (no taskQueue → its own queue,
    // create-grants) and does NOT mark the activity done itself: `done` must
    // mean "mirror replicated + grants regenerated", which only the consumer
    // can guarantee
    expect(h.calls).toEqual(['consumer'])
    expect(h.state.consumerOptions).toMatchObject({
      workflowId: 'delegated-grants:https://id/acme:https://id/bob',
      args: [{ webId, peerId }],
    })
    expect(h.state.consumerOptions?.taskQueue).toBeUndefined()
    expect(h.activities.markActivitiesDone).not.toHaveBeenCalled()
  })
})
