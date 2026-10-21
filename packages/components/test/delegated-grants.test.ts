import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common'
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
    signals: Record<string, () => void>
    fireSignalOnNextWait: boolean
    fireReconcileMirrorOnNextWait: boolean
    /** the workflowId whose consumer already runs (force → signal path) */
    consumerRunning: boolean
    signaledWorkflowId?: string
    mirrorOptions?: ChildOptions
    consumerOptions?: ChildOptions
    consumerCalls: ChildOptions[]
    /** drift-arm child starts (the per-grantee reconciliation) */
    driftOptions: ChildOptions[]
    /** what the mirror child reports back (terminal peer-gone case) */
    mirrorResult: { peerGone: boolean }
  } = {
    batches: [],
    pending: [],
    signals: {},
    fireSignalOnNextWait: false,
    fireReconcileMirrorOnNextWait: false,
    consumerRunning: false,
    consumerCalls: [],
    driftOptions: [],
    mirrorResult: { peerGone: false },
  }

  const activities = {
    // the per-peer drain
    getPendingDelegatedGrantsUpdates: vi.fn(async () => state.batches.shift() ?? []),
    // the sweep's registry scan
    getPendingActivities: vi.fn(async () => state.pending),
    // C5 drift arm — the registered grantees the sweep re-derives
    listGranteeRegistrations: vi.fn(async () => [] as { id: string; type: string[] }[]),
    // C5 mirror arm — reciprocal pairs and local completeness
    listReciprocalRegistrations: vi.fn(async () => [] as unknown[]),
    findIncompleteReciprocalMirrors: vi.fn(async () => [] as unknown[]),
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
    const name = h.state.fireReconcileMirrorOnNextWait
      ? 'reconcileMirrorSignal'
      : 'delegatedGrantsUpdatedSignal'
    h.state.fireReconcileMirrorOnNextWait = false
    h.state.signals[name]?.()
    return predicate()
  },
  defineSignal: (name: string) => name,
  executeChild: async (_workflow: unknown, options?: ChildOptions) => {
    if (options?.taskQueue === 'reciprocal-registration') {
      h.calls.push('mirror')
      h.state.mirrorOptions = options
      return h.state.mirrorResult
    } else if (options?.workflowId?.startsWith('delegated-grants:')) {
      if (h.state.consumerRunning) {
        throw new WorkflowExecutionAlreadyStartedError(
          'already started',
          options.workflowId,
          'run-id'
        )
      }
      h.calls.push('consumer')
      h.state.consumerOptions = options
      h.state.consumerCalls.push(options)
    } else {
      h.calls.push('grants-child')
      h.state.driftOptions.push(options ?? {})
    }
  },
  getExternalWorkflowHandle: (workflowId: string) => ({
    signal: async () => {
      h.calls.push('signal')
      h.state.signaledWorkflowId = workflowId
    },
  }),
  proxyActivities: () => h.activities,
  setHandler: (signal: unknown, handler: () => void) => {
    h.state.signals[String(signal)] = handler
  },
  startChild: async () => {
    h.calls.push('detect-granted')
  },
  workflowInfo: () => ({ workflowId: 'delegated-grants:https://id/acme:https://id/bob' }),
}))

import {
  processDelegatedGrantsUpdated,
  reconcileActivities,
  reconcilePeerMirrors,
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
  h.state.fireReconcileMirrorOnNextWait = false
  h.state.mirrorOptions = undefined
  h.activities.listGranteeRegistrations.mockResolvedValue([])
  h.activities.listReciprocalRegistrations.mockResolvedValue([])
  h.activities.findIncompleteReciprocalMirrors.mockResolvedValue([])
  h.state.consumerOptions = undefined
  h.state.consumerCalls = []
  h.state.consumerRunning = false
  h.state.signaledWorkflowId = undefined
  h.state.signals = {}
  h.state.driftOptions = []
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

describe('reconcileActivities — authorization-vs-projection drift arm (C5)', () => {
  const aliceId = { id: 'https://id/alice', type: [SOCIAL_AGENT_TYPE] }

  test('re-derives every registered grantee when nothing is pending', async () => {
    h.state.pending = []
    h.activities.listGranteeRegistrations.mockResolvedValue([peerId, aliceId])

    await reconcileActivities({ webId })

    expect(h.activities.listGranteeRegistrations).toHaveBeenCalledWith({ webId })
    // one child reconciliation per registered grantee — no activity needed
    expect(h.state.driftOptions.map((options) => options.args)).toEqual([
      [{ webId, grantee: peerId }],
      [{ webId, grantee: aliceId }],
    ])
    expect(h.activities.markActivitiesDone).not.toHaveBeenCalled()
  })
})

describe('processDelegatedGrantsUpdated — forced mirror sync (C5)', () => {
  test('syncs and regenerates once with no pending activity, then idles out', async () => {
    h.state.batches = [[]]

    await processDelegatedGrantsUpdated({ webId, peerId, forceSync: true })

    expect(h.calls).toEqual(['mirror', 'regenerate', 'detect-granted'])
    expect(h.activities.markActivitiesDone).not.toHaveBeenCalled()
  })

  test('a forced signal during an idle wait triggers a sync', async () => {
    h.state.batches = [[], []]
    h.state.fireSignalOnNextWait = true
    h.state.fireReconcileMirrorOnNextWait = true

    await processDelegatedGrantsUpdated({ webId, peerId })

    // first wait: forced signal → sync; second empty drain: idle exit
    expect(h.calls).toEqual(['mirror', 'regenerate', 'detect-granted'])
    expect(h.activities.markActivitiesDone).not.toHaveBeenCalled()
  })
})

describe('reconcileActivities — mirror repair arm (C5)', () => {
  test('force-syncs an incomplete reciprocal mirror before the local drift pass', async () => {
    h.activities.findIncompleteReciprocalMirrors.mockResolvedValue([{ peerId }])
    h.state.pending = []

    await reconcileActivities({ webId })

    expect(h.activities.findIncompleteReciprocalMirrors).toHaveBeenCalledWith({ webId })
    expect(h.state.consumerCalls).toHaveLength(1)
    expect(h.state.consumerCalls[0]).toMatchObject({
      workflowId: 'delegated-grants:https://id/acme:https://id/bob',
      args: [{ webId, peerId, forceSync: true }],
    })
  })

  test('signals a live consumer instead of starting a second run', async () => {
    h.activities.findIncompleteReciprocalMirrors.mockResolvedValue([{ peerId }])
    h.state.consumerRunning = true

    await reconcileActivities({ webId })

    expect(h.calls).toContain('signal')
    expect(h.state.signaledWorkflowId).toBe('delegated-grants:https://id/acme:https://id/bob')
  })
})

describe('reconcilePeerMirrors — peer freshness pass (C5)', () => {
  const alice = { id: 'https://id/alice', type: [SOCIAL_AGENT_TYPE] }

  test('force-syncs every reciprocal-linked peer', async () => {
    h.activities.listReciprocalRegistrations.mockResolvedValue([{ peerId }, { peerId: alice }])

    await reconcilePeerMirrors({ webId })

    expect(h.state.consumerCalls.map((options) => options.args)).toEqual([
      [{ webId, peerId, forceSync: true }],
      [{ webId, peerId: alice, forceSync: true }],
    ])
  })
})
