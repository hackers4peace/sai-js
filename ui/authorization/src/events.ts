import { useAppStore } from '@/store/app'

import { getRuntimeConfig } from './runtime-config'

/**
 * Client for the always-open NDJSON event stream (`GET /.sai/events`),
 * driven by the activity lifecycle (pending → done) on the auth server
 * (see docs/plans/refactor-ui.md).
 *
 * - connects with the account cookie, like the RPC calls in store/core.ts
 * - parses NDJSON lines and dispatches completion-driven store refreshes
 * - auto-reconnects with backoff on error/close; heartbeat-timeout detection
 * - on first open and every reconnect triggers a full store refresh (the
 *   server never replays missed events — docs/plans/refactor-ui.md §5)
 */

export interface ActivityEvent {
  id: string
  /** the typed activity tuple — `['Activity', '<Class>', <as:*>]` */
  type: string[]
  /** as:target — absent on classes whose changed-record id rides the embedded
   *  object (`InvitationCreated` + re-pins); present elsewhere */
  target?: string
  /** as:actor — plain IRI (the registry owner the activity was written to) */
  actor?: string
  /** as:object — live-link IRI / snapshot POJO (the matching anchor for the
   *  step-1 create claim — the echoed pre-minted invitation id) */
  object?: unknown
  createdAt: string
  status: 'pending' | 'done'
}

type StreamMessage = { type: 'activity'; activity: ActivityEvent } | { type: 'heartbeat' }

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

let controller: AbortController | null = null
let heartbeatWatchdog: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoff = INITIAL_BACKOFF_MS
let lastDataAt = 0
let stopped = false

/** The full store refresh run on first connect and on every reconnect. */
function fullRefresh() {
  const appStore = useAppStore()
  appStore.listSocialAgents(true)
  appStore.listApplications(true)
  appStore.listRoles(true)
  appStore.listSocialAgentInvitations(true)
}

/** The registry owner an activity was written to — `actor` (as:actor, plain
 * IRI) on every activity. Phase 3 forwards org-context activities onto the
 * admin's stream keyed by the admin's webId (R3 of org-admin-feature.md
 * §3.3) — the UI must refresh only the context the event belongs to.
 */
function registryOwner(activity: ActivityEvent): string | undefined {
  return activity.actor
}

/**
 * Completion-driven refresh — maps the completed activity's type to the
 * store refetches (§5 of the plan). `pending` events are ignored for now
 * (optional "applying changes…" indicator, out of scope).
 */
function handleActivity(activity: ActivityEvent) {
  const appStore = useAppStore()
  // track every activity (pending → done) — the step-0 tracker; claims bind
  // a user-triggered action to its activity (create: the echoed as:object id)
  appStore.recordActivity(activity)
  // terminal resolutions (see the OpenWiki `services/activity-lifecycle.md`) — the class IS the
  // outcome and never gets an `activityCompleted`, so react to the row at
  // ANY status: the REQUESTER's outgoing badge/list clears as soon as the
  // granted/archived Add lands (no done-row to wait for)
  const owner = registryOwner(activity)
  if (
    activity.type.includes('AccessRequestGranted') ||
    activity.type.includes('AccessRequestArchived')
  ) {
    if (owner && appStore.currentContext() !== owner) return
    appStore.listSocialAgents(true)
    return
  }
  if (activity.status !== 'done') return
  // org-context events arrive on the admin's stream for every org the user
  // administers — refresh only the context that owns the activity; switching
  // contexts already performs a full refresh (switchContext)
  if (owner && appStore.currentContext() !== owner) return
  // dispatch on the type discriminant — the grantee kind is resolved in the
  // store, so authorization done-rows refresh both lists (cheap, idempotent)
  if (
    activity.type.includes('AuthorizationGranted') ||
    activity.type.includes('AuthorizationRevoked')
  ) {
    appStore.listApplications(true)
    appStore.listSocialAgents(true)
  } else if (
    activity.type.includes('RoleMembershipChanged') ||
    activity.type.includes('RoleDeleted') ||
    activity.type.includes('RoleCreated')
  ) {
    appStore.listSocialAgents(true)
    appStore.listRoles(true)
  } else if (activity.type.includes('AgentRegistrationAdded')) {
    appStore.listSocialAgents(true)
    appStore.listSocialAgentInvitations(true)
  } else if (activity.type.includes('InvitationAccepted')) {
    // the acceptor's workflow built the acceptor → inviter registration;
    // refresh the context's agent list (e.g. the org's list for a
    // peer-owned invitation accepted by an admin — admin-invitation-receive)
    appStore.listSocialAgents(true)
    appStore.listSocialAgentInvitations(true)
  } else if (activity.type.includes('InvitationCreated')) {
    // step 1: the capabilityUrl is learned from the invitation resource after
    // completion (never from an RPC or activity) — the done-row refresh does
    // exactly that via the invitation list
    appStore.listSocialAgentInvitations(true)
  } else if (
    activity.type.includes('NeedBasedAccessRequestSent') ||
    activity.type.includes('NeedBasedAccessRequestReceived')
  ) {
    // requester side: sent → the outgoing request is now pending on Kim's side;
    // owner side: received → a new pending request has landed in the registry.
    // Both sides refresh the social-agents list so the UI reflects the pending
    // request state (e.g. a "pending" badge next to Kim in Alice's list, and the
    // incoming request entry in Kim's list).
    appStore.listSocialAgents(true)
  } else if (activity.type.includes('DelegatedGrantsUpdated')) {
    appStore.listSocialAgents(true)
  } else if (
    // org-admin (Phase 1/3): the admin marker lands via the grant workflow —
    // refresh the context's agent list so toggle-admin flags stay current
    activity.type.includes('AdminAuthorizationGranted') ||
    activity.type.includes('AdminAuthorizationRevoked')
  ) {
    appStore.listSocialAgents(true)
  }
}

function handleMessage(line: string) {
  if (!line) return
  try {
    const message = JSON.parse(line) as StreamMessage
    if (message.type === 'activity') handleActivity(message.activity)
  } catch {
    // a malformed line must not break the stream
  }
}

function scheduleReconnect() {
  if (stopped) return
  clearTimers()
  reconnectTimer = setTimeout(() => {
    void open()
  }, backoff)
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
}

function clearTimers() {
  if (heartbeatWatchdog) clearInterval(heartbeatWatchdog)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  heartbeatWatchdog = null
  reconnectTimer = null
}

async function open() {
  if (stopped) return
  controller = new AbortController()
  try {
    const response = await fetch(`${getRuntimeConfig().backendBaseUrl}/.sai/events`, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`stream returned ${response.status}`)

    backoff = INITIAL_BACKOFF_MS
    lastDataAt = Date.now()
    fullRefresh()

    // heartbeat-timeout detection: no data for several heartbeats → the
    // connection is dead; abort it so the close handler schedules a reconnect
    heartbeatWatchdog = setInterval(() => {
      if (Date.now() - lastDataAt > HEARTBEAT_TIMEOUT_MS) controller?.abort()
    }, HEARTBEAT_INTERVAL_MS)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lastDataAt = Date.now()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleMessage(line)
    }
  } catch {
    // aborted (timeout/stop) or network error — reconnect unless stopped
  } finally {
    if (!stopped) scheduleReconnect()
  }
}

/** Open the stream (after sign-in — `coreStore.userId` set). */
export function startEvents() {
  stopped = false
  void open()
}

/** Close the stream (on sign-out / unmount). */
export function stopEvents() {
  stopped = true
  clearTimers()
  controller?.abort()
  controller = null
}
