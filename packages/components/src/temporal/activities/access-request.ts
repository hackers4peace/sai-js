import {
  ActivityRegistry,
  type OpenSentAccessRequest,
  getDataGrantsForGrantee,
  getOpenSentAccessRequests,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import {
  type EmbeddedNeedBasedAccessRequest,
  type NeedBasedAccessRequestReceivedId,
  type NeedBasedAccessRequestSentId,
  type SocialAgentId,
  dataModelContext,
} from '@janeirodigital/interop-data-model'
import { INTEROP, putJsonLd, withContext } from '@janeirodigital/interop-utils'

import { buildSessionManager } from '../../builders/sessionManager.js'
import { issuanceUrl } from '../../util/uriTemplates.js'

export interface ForwardNeedBasedAccessRequestInput {
  requester: SocialAgentId
  /** the request snapshot (urn:uuid id) as embedded in the activity */
  request: EmbeddedNeedBasedAccessRequest
  /** the triggering `needBasedAccessRequestSent` activity (completion ref) */
  activity: NeedBasedAccessRequestSentId
}

/**
 * The requester-side leg of a need-based access request
 * (authorization-granting.md §6.5): POST the request to the data owner's
 * REUSED grant-issuance endpoint (`issuanceUrl(dataOwner)`) AS the requester
 * (`getSession(requester)` — client = the requester's UAS), expecting **202
 * Accepted (empty body)**. The owner side only VALIDATES in the current
 * phase — the mint + `NeedBasedAccessRequestReceived` activity + the
 * owner-side materialization workflow land in the receive-side phase.
 */
export async function forwardNeedBasedAccessRequest(
  input: ForwardNeedBasedAccessRequestInput
): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(input.requester.id)
  const endpoint = issuanceUrl(input.request.dataOwner)
  const response = await session.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/ld+json',
    },
    body: JSON.stringify({
      type: [INTEROP.NeedBasedAccessRequest],
      grantee: input.request.grantee,
      grantedBy: input.request.grantedBy,
      dataOwner: input.request.dataOwner,
      hasAccessNeedGroup: input.request.hasAccessNeedGroup,
    }),
  })
  if (response.status !== 202) {
    throw new Error(`expected 202 but received ${response.status} from ${endpoint}`)
  }
}

export interface MaterializeNeedBasedAccessRequestInput {
  dataOwner: SocialAgentId
  /** the request-to-be — real-id embedded projection at the minted id */
  request: EmbeddedNeedBasedAccessRequest
  /** the triggering `needBasedAccessRequestReceived` activity (completion ref) */
  activity: NeedBasedAccessRequestReceivedId
}

/**
 * The owner-side leg of a need-based access request (authorization-granting.md
 * §6.5): PUT the immutable AccessRequest at the minted id
 * (`getSession(dataOwner)`). Find-first idempotent — a workflow retry or the
 * reconcile re-delivery after a crash sees the existing resource and skips
 * the write (the stored request is NEVER mutated).
 */
export async function materializeNeedBasedAccessRequest(
  input: MaterializeNeedBasedAccessRequestInput
): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(input.dataOwner.id)
  const existing = await session.fetch(input.request.id, { method: 'HEAD' })
  if (existing.status === 200) return
  const doc = withContext(dataModelContext, input.request)
  await putJsonLd(input.request.id, session.fetch, doc, { 'If-None-Match': '*' })
}

// ──────────────────────────
// Granted-request detection (see the OpenWiki `services/activity-lifecycle.md`)
// ──────────────────────────

/**
 * The best-effort intersection of §3.3: an open request `r` is granted iff
 * ∃ received grant with `grant.grantedBy === r.dataOwner` (the owner) AND
 * `grant.shapeTree ∈ r.shapeTrees` (the need-group intersection — Inherited
 * child grants carry the child tree and match child needs).
 *
 * The `grant.grantee` anchor is bound at QUERY level
 * (`getDataGrantsForGrantee` — grants arriving for this requester), so a
 * per-grant check is redundant here: requests made by this requester always
 * carry `grantedBy === requester` (self-requests included). Returns the
 * snapshot ids of the requests to close.
 */
export function matchGrantedRequests(
  requests: OpenSentAccessRequest[],
  grants: Array<{ grant: string; grantedBy: string; shapeTree: string }>
): Set<string> {
  const granted = new Set<string>()
  for (const r of requests) {
    const covered = grants.some(
      (g) => g.grantedBy === r.dataOwner && r.shapeTrees.includes(g.shapeTree)
    )
    if (covered) granted.add(r.request)
  }
  return granted
}

export interface DetectGrantedRequestsInput {
  requester: SocialAgentId
}

/**
 * The detector (see the OpenWiki `services/activity-lifecycle.md`): runs on the requester's
 * plane — reads the OPEN sent requests and the requester's received grants
 * (shared-store shortcut, openwiki/architecture/federation.md §1), matches them best-effort and
 * writes an `AccessRequestGranted` activity per match (light `{ id, type }`
 * ref — `id` = the Sent activity's SNAPSHOT id). TERMINAL resolution — no
 * `ActivityCompleted` written (the class IS the outcome, §1).
 */
export async function detectGrantedRequests(input: DetectGrantedRequestsInput): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(input.requester.id)
  const transport = localSparqlTransport(session.sparqlEndpoint)
  const open = await getOpenSentAccessRequests(transport)
  if (open.length === 0) return
  const grants = await getDataGrantsForGrantee(transport, input.requester.id)
  const matched = matchGrantedRequests(open, grants)
  if (matched.size === 0) return
  const registry = session.registrySet.hasActivityRegistry
  if (!registry) return
  for (const request of open) {
    if (!matched.has(request.request)) continue
    const activity: Omit<import('@janeirodigital/interop-data-model').AccessRequestGranted, 'id'> =
      {
        type: ['Activity', 'AccessRequestGranted'],
        actor: input.requester.id,
        // the light ref — the Sent activity's SNAPSHOT id (the open-set query
        // joins `outcome.object.id → sent.object.id`)
        object: { id: request.request, type: [INTEROP.NeedBasedAccessRequest] },
        createdAt: new Date().toISOString(),
      }
    await ActivityRegistry.createActivity(
      registry,
      { fetch: session.fetch, randomUUID: session.randomUUID },
      activity
    )
  }
}
