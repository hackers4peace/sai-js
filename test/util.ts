import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  ActivityRegistry,
  type AuthorizationAgent,
  getDataGrant,
  getSocialAgentRegistration,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import type {
  ActivityData,
  GrantData,
  SocialAgentRegistrationData,
} from '@janeirodigital/interop-data-model'
import {
  AS,
  RDF,
  getNotificationChannel,
  getOneMatchingQuad,
  toStore,
} from '@janeirodigital/interop-utils'

// TODO: deduplicate with notifications-manager from application package

export interface NotificationStream {
  /** Read the next NDJSON notification (expanded JSON-LD); `undefined` when the stream ends. */
  next: () => Promise<Record<string, unknown> | undefined>
  /** Release the reader and cancel the response body. */
  close: () => Promise<void>
}

/**
 * Wrap an RPC request in the sai-api-messages protocol envelope (one call per
 * batch; trace/span are stable convenience values).
 */
export function rpcPayload(request: unknown) {
  return [
    {
      request,
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]
}

/**
 * Data grants of a registration, read via the session's SPARQL plane —
 * the SPARQL counterpart of the removed data-model HTTP `getDataGrants`.
 */
export async function dataGrants(
  registration: SocialAgentRegistrationData,
  session: AuthorizationAgent
): Promise<GrantData[]> {
  const transport = localSparqlTransport(session.sparqlEndpoint)
  return Promise.all((registration.hasDataGrant ?? []).map((iri) => getDataGrant(transport, iri)))
}

/**
 * The locally **mirrored** copy of `peerId`'s registration of `session.webId`
 * (the peer's reciprocal registration), read through the reading side's own
 * SPARQL plane — a replica read, never a peer dereference.
 *
 * Throws `Node <iri> not found in framed output` when the mirror graph has not
 * been written, which is exactly the invariant the replication steps must
 * satisfy (openwiki/architecture/federation.md): the invitation workflows seed it
 * per leg, the delegated-grants consumer refreshes it before regenerating.
 */
export async function localMirror(
  session: AuthorizationAgent,
  peerId: string
): Promise<SocialAgentRegistrationData> {
  const registration = await session.findSocialAgentRegistration(peerId)
  if (!registration?.reciprocalRegistration) {
    throw new Error(
      `${session.webId} has no registration of ${peerId} with a reciprocal link (nothing to mirror)`
    )
  }
  return getSocialAgentRegistration(
    localSparqlTransport(session.sparqlEndpoint),
    registration.reciprocalRegistration
  )
}

/**
 * Open the notification stream for a resource (channel discovered via the
 * HEAD Link header) and discard the initial state notification. Call this
 * BEFORE triggering the change you want to observe so no event is missed
 * while the follow-up workflow runs asynchronously.
 */
export async function openNotificationStream(
  authFetch: typeof fetch,
  resourceId: string
): Promise<NotificationStream> {
  const headResponse = await authFetch(resourceId, { method: 'HEAD' })
  const linkHeader = headResponse.headers.get('link')
  if (!linkHeader) throw new Error('Link header is missing')
  const receiveFrom = getNotificationChannel(linkHeader)
  if (!receiveFrom) throw new Error(`Failed to discover notification chanel for: ${resourceId}`)

  const response = await authFetch(receiveFrom)
  if (!response.ok) {
    throw new Error(`failed connecting to notification stream: ${receiveFrom}, ${response.status}`)
  }
  if (!response.body) {
    throw new Error(`missing body of notification stream: ${receiveFrom}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let initialDiscarded = false

  // The first line is the initial state notification — discarded lazily so a
  // coalesced chunk cannot swallow a real event.
  const next = async (): Promise<Record<string, unknown> | undefined> => {
    while (true) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) continue
        if (!initialDiscarded) {
          initialDiscarded = true
          continue
        }
        return JSON.parse(line) as Record<string, unknown>
      }
      const { done, value } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }

  const close = async (): Promise<void> => {
    reader.releaseLock()
    await response.body!.cancel()
  }

  return { next, close }
}

/**
 * Read from an open stream until a notification arrives (optionally of the
 * given type). Returns true on match; false if the stream ends without one.
 * Closes the stream in all cases.
 */
export async function awaitNotification(
  stream: NotificationStream,
  expectedType?: string
): Promise<boolean> {
  try {
    while (true) {
      const doc = await stream.next()
      if (!doc) return false
      const dataset = await toStore(doc)
      const receivedType = getOneMatchingQuad(dataset, undefined, RDF.terms.type)!.object.value
      if (!expectedType || receivedType === expectedType) return true
    }
  } finally {
    await stream.close()
  }
}

/** Open the stream, await the first notification of the expected type (listen-first pattern). */
export async function receivesNotification(
  authFetch: typeof fetch,
  resourceId: string,
  expectedType?: string
): Promise<boolean> {
  const stream = await openNotificationStream(authFetch, resourceId)
  return awaitNotification(stream, expectedType)
}

/**
 * Poll a predicate until it resolves truthy or the timeout elapses.
 * Throws the last predicate error (or a timeout error) on failure.
 */
export async function waitFor<T>(
  predicate: () => Promise<T>,
  { timeout = 10_000, interval = 250 }: { timeout?: number; interval?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeout
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  if (lastError) throw lastError
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

// ---------------------------------------------------------------------------
// Workflow quiescence — no pending activities for the given webIds
// ---------------------------------------------------------------------------

/**
 * The webId's un-completed activities: registry entries without a matching
 * `activityCompleted` (same read as the worker's `getPendingActivities`).
 * A pending activity means a webhook-triggered workflow is still mid-flight;
 * workflows mark their activity done only on completion (`markActivitiesDone`).
 */
async function pendingActivitiesFor(
  session: AuthorizationAgent
): Promise<ActivityData[] | undefined> {
  const registry = session.registrySet.hasActivityRegistry
  if (!registry) return []
  let iris: string[]
  try {
    iris = await ActivityRegistry.getActivityIris(registry, session.fetch)
  } catch {
    // transient 500 on the container listing — the known CSS SPARQL-backend
    // concurrent-write corruption (duplicate dcterms:modified on a child;
    // util.ts comment above). Signal "unreadable — not settled": the caller
    // keeps polling instead of counting this as a clean poll (which would let
    // the next test/write race this round's in-flight completion tail).
    return undefined
  }
  const completed = new Set<string>()
  const workItems: ActivityData[] = []
  for (const iri of iris) {
    const activity = await ActivityRegistry.loadActivity(iri, session.fetch)
    if (activity.type.includes('ActivityCompleted')) {
      completed.add(activity.target)
    } else {
      workItems.push(activity)
    }
  }
  return workItems.filter((activity) => !completed.has(activity.id))
}

/**
 * Wait until none of `webIds` has pending activities for `settle` consecutive
 * polls — i.e. no workflows from earlier tests are still running/mid-flight
 * when the next test starts (webhook-triggered workflows, per-test timeline).
 * Long-lived grantee-consumers stay alive between drains but carry no pending
 * activities, so they don't block settlement.
 */
export async function waitForQuiescence(
  webIds: string[],
  {
    timeout = 30_000,
    interval = 250,
    settle = 2,
  }: { timeout?: number; interval?: number; settle?: number } = {}
): Promise<void> {
  const manager = buildSessionManager()
  // sessions are reused across polls — each getSession performs an OIDC login
  const sessions = await Promise.all(
    webIds.map(async (webId) => [webId, await manager.getSession(webId)] as const)
  )
  const deadline = Date.now() + timeout
  let settled = 0
  while (Date.now() < deadline) {
    const pending = await Promise.all(
      sessions.map(async ([, session]) => (await pendingActivitiesFor(session))?.length)
    )
    // an unreadable registry (transient container-listing 500) counts as NOT
    // settled — keep polling; only two consecutive clean zero-pending reads settle
    const unreadable = pending.some((count) => count === undefined)
    const total = unreadable ? -1 : pending.reduce((sum, count) => sum + (count ?? 0), 0)
    if (total === 0) {
      settled += 1
      if (settled >= settle) return
    } else {
      settled = 0
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`workflows did not settle within ${timeout}ms for: ${webIds.join(', ')}`)
}

/**
 * Barrier for a grant-affecting change (wait-for-completion): open the
 * notification stream on `registrationId`, run `trigger`, await the
 * registration `Update`, then — critically — wait until the triggered
 * workflow chain FULLY completed (`waitForQuiescence` over `webIds`). The
 * `Update` arrives MID-CHAIN (from the registration PATCH in a child
 * workflow), while the parent workflow's `activityCompleted` write — its
 * tail — is still pending; proceeding right then races the test's next
 * activity write against that tail in the same activity container (CSS
 * SPARQL-backend concurrent-write corruption, docs/plans).
 */
export async function awaitGrantCompletion(
  authFetch: typeof fetch,
  registrationId: string,
  webIds: string[],
  trigger: () => Promise<unknown>
): Promise<void> {
  const stream = await openNotificationStream(authFetch, registrationId)
  await trigger()
  // CSS delivers the activity Add to the pre-seeded webhook channel (Phase 2) —
  // the workflow runs and the registration Update arrives on this stream
  const received = await awaitNotification(stream, AS.Update)
  if (!received) throw new Error(`expected registration Update on ${registrationId}`)
  await waitForQuiescence(webIds)
}

/**
 * Wait until an activity of class `cls` (the `type[1]` class term, e.g.
 * `'AgentRegistrationAdded'`) in the session's Activity Registry has a
 * completion referencing it (the producer's workflow marked it done).
 */
export async function waitForActivityCompletion(
  session: AuthorizationAgent,
  cls: string
): Promise<void> {
  const registry = session.registrySet.hasActivityRegistry!
  await waitFor(
    async () => {
      try {
        const completed = await ActivityRegistry.getCompletedActivityIris(registry, session.fetch)
        if (!completed.length) return false
        const iris = await ActivityRegistry.getActivityIris(registry, session.fetch)
        for (const iri of iris) {
          const activity = await ActivityRegistry.loadActivity(iri, session.fetch)
          if (activity.type.includes(cls) && completed.includes(activity.id)) {
            return true
          }
        }
        return false
      } catch {
        // transient 500 on the container listing / completion read (the CSS
        // SPARQL-backend concurrent-write corruption) — keep polling
        return false
      }
    },
    { timeout: 30_000 }
  )
}

/**
 * The inviter-side tail of an invitation accept: establishReciprocal marked
 * the agentRegistrationAdded activity done — a completion activity
 * referencing it exists in the session's Activity Registry.
 */
export async function waitForAgentRegistrationAddedCompletion(
  session: AuthorizationAgent
): Promise<void> {
  return waitForActivityCompletion(session, 'AgentRegistrationAdded')
}

/**
 * The acceptor-side tail of an invitation accept: the acceptInvitation
 * workflow marked the invitationAccepted activity done — a completion
 * activity referencing it exists in the session's Activity Registry.
 */
export async function waitForInvitationAcceptedCompletion(
  session: AuthorizationAgent
): Promise<void> {
  return waitForActivityCompletion(session, 'InvitationAccepted')
}

/**
 * The send-leg tail of an invitation creation (activity-first step 1): the
 * createInvitation workflow PUT the invitation and marked the
 * invitationCreated activity done — a completion referencing it exists in
 * the session's Activity Registry.
 */
export async function waitForInvitationCreatedCompletion(
  session: AuthorizationAgent
): Promise<void> {
  return waitForActivityCompletion(session, 'InvitationCreated')
}

/**
 * The createRole tail (activity-first step 9): the createRole workflow
 * PUT the role at the pre-minted id and marked the roleCreated activity
 * done — a completion referencing it exists in the session's Activity
 * Registry.
 */

/**
 * The request-received tail (authorization-granting.md §6.2): the owner-side
 * workflow PUT the immutable AccessRequest at the minted id and marked the
 * `needBasedAccessRequestReceived` activity done — a completion referencing
 * it exists in the session's Activity Registry.
 */
export async function waitForNeedBasedAccessRequestReceivedCompletion(
  session: AuthorizationAgent
): Promise<void> {
  return waitForActivityCompletion(session, 'NeedBasedAccessRequestReceived')
}

/**
 * The request-sent tail (activity-first, authorization-granting.md §6.4):
 * the requester-side workflow forwarded the request to the data owner's
 * (reused) issuance endpoint (expects 202) and marked the
 * `needBasedAccessRequestSent` activity done — a completion referencing it
 * exists in the session's Activity Registry. The `done` means "forwarded",
 * not "granted" (the grant outcome arrives later via webhook, §6.8).
 */
export async function waitForNeedBasedAccessRequestSentCompletion(
  session: AuthorizationAgent
): Promise<void> {
  return waitForActivityCompletion(session, 'NeedBasedAccessRequestSent')
}

export async function waitForRoleCreatedCompletion(session: AuthorizationAgent): Promise<void> {
  return waitForActivityCompletion(session, 'RoleCreated')
}

/**
 * The updateRole tail (activity-first step 2): the updateRole workflow
 * PATCHed the role to the intended state and marked the
 * roleMembershipChanged activity done — a completion referencing it exists
 * in the session's Activity Registry.
 */
export async function waitForRoleMembershipChangedCompletion(
  session: AuthorizationAgent
): Promise<void> {
  return waitForActivityCompletion(session, 'RoleMembershipChanged')
}

/**
 * The deleteRole tail (activity-first step 3): the deleteRole workflow
 * DELETEd the role, regenerated grants and marked the roleDeleted activity
 * done — a completion referencing it exists in the session's Activity
 * Registry.
 */
export async function waitForRoleDeletedCompletion(session: AuthorizationAgent): Promise<void> {
  return waitForActivityCompletion(session, 'RoleDeleted')
}

// ---------------------------------------------------------------------------
// UI events stream (/.sai/events) — the NDJSON stream from refactor-ui.md
// ---------------------------------------------------------------------------

const EVENTS_ENDPOINT = 'https://auth/.sai/events'

export interface EventsStream {
  response: Response
}

/**
 * Open the UI events stream with an account cookie (listen-first: call this
 * BEFORE triggering the RPC/webhook that produces the activity you want to
 * observe). The server never replays — only events after the connection is
 * open are delivered.
 */
export async function openEventsStream(cookie: string): Promise<EventsStream> {
  const response = await fetch(EVENTS_ENDPOINT, {
    headers: { Cookie: cookie },
  })
  if (!response.ok) {
    throw new Error(`failed connecting to events stream: ${EVENTS_ENDPOINT}, ${response.status}`)
  }
  if (!response.body) {
    throw new Error('missing body of events stream')
  }
  return { response }
}

/**
 * Read NDJSON lines until one matches the predicate. Returns the matching
 * message, or undefined if the stream ends. Closes the stream unless
 * `close: false` (staged reads — pending then done on the same connection).
 *
 * Each call acquires its own reader: between staged reads the previous
 * reader is released, so a fresh one must be requested (reads continue from
 * the same buffered position).
 */
export async function awaitEvent(
  stream: EventsStream,
  predicate: (message: { type: string; activity?: any }) => boolean,
  options: { close?: boolean } = { close: true }
): Promise<{ type: string; activity?: any } | undefined> {
  const { response } = stream
  // the body is unlocked between staged reads — acquire a fresh reader here
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        const message = JSON.parse(line) as { type: string; activity?: any }
        if (predicate(message)) return message
      }
    }
  } finally {
    reader.releaseLock()
    // keep the stream open between staged reads (pending → done on the same
    // connection); the caller closes it on the final read
    if (options.close) await response.body.cancel()
  }
  return undefined
}
