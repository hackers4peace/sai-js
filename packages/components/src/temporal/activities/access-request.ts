import {
  ActivityRegistry,
  getAccessGrantsForGrantee,
  getOpenSentAccessRequests,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import type { OpenSentAccessRequest } from '@janeirodigital/interop-authorization-agent'
import { dataModelContext } from '@janeirodigital/interop-data-model'
import type {
  EmbeddedNeedBasedAccessRequest,
  NeedBasedAccessRequestReceivedId,
  NeedBasedAccessRequestSentId,
  SocialAgentId,
} from '@janeirodigital/interop-data-model'
import type { AccessRequestGranted } from '@janeirodigital/interop-data-model'
import { INTEROP, withContext } from '@janeirodigital/interop-utils'

import { buildSessionManager } from '../../builders/sessionManager.js'
import { accessRequestsUrl } from '../../util/uriTemplates.js'

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
 * owner-scoped access request endpoint (`accessRequestsUrl(dataOwner)`) AS the
 * requester (`getSession(requester)` — client = the requester's UAS), expecting
 * **202 Accepted (empty body, no Location)**. Delegation and revocation still
 * use the legacy `.sai/grants` route during Phase 2.
 */
export async function forwardNeedBasedAccessRequest(
  input: ForwardNeedBasedAccessRequestInput
): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(input.requester.id)
  const endpoint = accessRequestsUrl(input.request.dataOwner)
  const wireContext = [
    'https://www.w3.org/ns/lws/v1',
    'http://www.w3.org/ns/odrl.jsonld',
    'https://www.w3.org/ns/solid/interop-context/v1',
  ]
  const policies: Array<Record<string, unknown>> = []
  const addNeed = (need: Record<string, unknown>, parentId?: string) => {
    const needId = need.id as string
    const action = (need.accessMode as Array<string>) ?? []
    const instances = (need.hasDataInstance as Array<string> | undefined) ?? []
    const registration = need.hasDataRegistration as string | undefined
    const shapeTree = need.registeredShapeTree as string | undefined
    const permission = (
      type: Array<string>,
      source: Array<string>,
      metadata: { registeredShapeTree?: string; hasDataRegistration?: string } = {}
    ) => {
      const permissionId = `urn:uuid:${crypto.randomUUID()}`
      const targetId = `urn:uuid:${crypto.randomUUID()}`
      return {
        uid: permissionId,
        assigner: input.request.grantedBy,
        assignee: input.request.grantee,
        action,
        target: {
          type,
          uid: targetId,
          owner: input.request.dataOwner,
          source,
          ...(metadata.registeredShapeTree
            ? { registeredShapeTree: metadata.registeredShapeTree }
            : {}),
          ...(metadata.hasDataRegistration
            ? { hasDataRegistration: metadata.hasDataRegistration }
            : {}),
        },
      }
    }
    const policy: Record<string, unknown> = {
      type: [
        'Request',
        'AccessNeed',
        need.required === INTEROP.AccessOptional ? 'AccessOptional' : 'AccessRequired',
      ],
      uid: needId,
      profile: 'AccessProfile',
      accessNeedGroup: input.request.hasAccessNeedGroup.id,
      ...(parentId ? { inheritsFromNeed: parentId } : {}),
    }
    if (instances.length) {
      // SelectedFromRegistry: one Asset permission per instance, matching the
      // grant shape. The registration is advisory on the request and required
      // on the grant/claim.
      policy.scopeOfGrant = 'SelectedFromRegistry'
      policy.permission = instances.map((instance) =>
        permission(['Asset'], [instance], {
          ...(shapeTree ? { registeredShapeTree: shapeTree } : {}),
          ...(registration ? { hasDataRegistration: registration } : {}),
        })
      )
    } else if (registration) {
      // registration-scoped request (plain LWS AssetCollection target): all
      // instances of that registration
      policy.scopeOfGrant = 'AllFromRegistry'
      policy.permission = [
        permission(
          ['AssetCollection', 'DataRegistration'],
          [registration],
          shapeTree ? { registeredShapeTree: shapeTree } : {}
        ),
      ]
    } else {
      policy.permission = [permission(['AssetCollection', 'st:ShapeTree'], [shapeTree])]
    }
    policies.push(policy)
    for (const child of (need.hasInheritingNeed as Array<Record<string, unknown>> | undefined) ??
      []) {
      addNeed(child, needId)
    }
  }
  for (const need of input.request.hasAccessNeedGroup.hasAccessNeed as Array<
    Record<string, unknown>
  >) {
    addNeed(need)
  }
  const response = await session.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/ld+json',
    },
    body: JSON.stringify({
      '@context': wireContext,
      type: ['AccessRequest', 'NeedBasedAccessRequest'],
      access: policies,
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
  if (existing.status === 200) {
    return
  }
  // The storage identifier strategy creates the member and records containment.
  await session.createIdentifierResource(
    session.registrySet.hasAccessRequestRegistry.id,
    input.request.id,
    false,
    withContext(dataModelContext, input.request)
  )
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
 * (`getAccessGrantsForGrantee` — grants arriving for this requester), so a
 * per-grant check is redundant here: requests made by this requester always
 * carry `grantedBy === requester` (self-requests included). For
 * instance-scoped needs the union of the grants for that shape tree must
 * cover every requested instance; partial grants leave the request open.
 * Returns the snapshot ids of the requests to close.
 */
export function matchGrantedRequests(
  requests: Array<OpenSentAccessRequest>,
  grants: Array<{
    grant: string
    grantedBy: string
    shapeTree: string
    scope?: string
    instances?: Array<string>
  }>
): Set<string> {
  const granted = new Set<string>()
  for (const r of requests) {
    const covered = r.shapeTrees.some((shapeTree) => {
      const matching = grants.filter(
        (g) => g.grantedBy === r.dataOwner && g.shapeTree === shapeTree
      )
      if (matching.length === 0) {
        return false
      }
      const requested = r.instancesByShapeTree?.[shapeTree] ?? []
      // a shape-tree-only request keeps the existing best-effort semantics
      if (requested.length === 0) {
        return true
      }
      // a broader grant covers the selected set; SelectedFromRegistry grants
      // are unioned because one request may be satisfied by several grants
      if (matching.some((g) => g.scope !== undefined && g.scope !== INTEROP.SelectedFromRegistry)) {
        return true
      }
      const available = new Set(matching.flatMap((g) => g.instances ?? []))
      return requested.every((instance) => available.has(instance))
    })
    if (covered) {
      granted.add(r.request)
    }
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
  if (open.length === 0) {
    return
  }
  const grants = await getAccessGrantsForGrantee(transport, input.requester.id)
  const matched = matchGrantedRequests(open, grants)
  if (matched.size === 0) {
    return
  }
  const registry = session.registrySet.hasActivityRegistry
  if (!registry) {
    return
  }
  for (const request of open) {
    if (!matched.has(request.request)) {
      continue
    }
    const activity: Omit<AccessRequestGranted, 'id'> = {
      type: ['Activity', 'AccessRequestGranted'],
      actor: input.requester.id,
      // the light ref — the Sent activity's SNAPSHOT id (the open-set query
      // joins `outcome.object.id → sent.object.id`)
      object: { id: request.request, type: [INTEROP.NeedBasedAccessRequest] },
      createdAt: new Date().toISOString(),
    }
    await ActivityRegistry.createActivity(
      registry,
      {
        fetch: session.fetch,
        randomUUID: session.randomUUID,
        identifierStrategies: session.identifierStrategies,
      },
      activity
    )
  }
}
