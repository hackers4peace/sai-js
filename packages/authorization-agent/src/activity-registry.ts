import {
  type ActivityData,
  type ActivityRegistryData,
  type CreateInvitationPojo,
  DataAuthorizationFromJsonLd,
  type EmbeddedAccessRequestRef,
  type EmbeddedAdminAuthorization,
  type EmbeddedAuthorization,
  type EmbeddedNeedBasedAccessRequest,
  type EmbeddedSocialAgentInvitation,
  type EmbeddedSocialAgentRegistration,
  type RoleData,
  dataModelContext,
  isActivityClass,
} from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  LDP,
  type LanguageMap,
  type WhatwgFetch,
  fetchJsonLd,
  frameDoc,
  iriForContained,
  linkedIrisJsonLd,
  putJsonLd,
  withContext,
} from '@janeirodigital/interop-utils'

import type { DataModelDependencies } from './types.ts'

/** The activity resources currently in the registry (ldp:contains). */
export async function getActivityIris(
  data: ActivityRegistryData,
  fetch: WhatwgFetch
): Promise<string[]> {
  return linkedIrisJsonLd(data.id, fetch, LDP.contains)
}

/**
 * PUT a new activity resource into the Activity Registry — same pattern as
 * grants and data authorizations: `iriForContained` + PUT with
 * `If-None-Match: *` (expanded JSON-LD). The typed class tuple
 * (`type: ['Activity', '<Class>', <as:*>]`) and the flat plain-IRI/literal
 * fields + the `as:object` forms serialize directly — no `activityType`,
 * no JSON-string `payload`.
 */
export async function createActivity(
  data: ActivityRegistryData,
  deps: DataModelDependencies,
  activity: Omit<ActivityData, 'id'>
): Promise<ActivityData> {
  const iri = iriForContained(data, deps.randomUUID)
  const doc = withContext(dataModelContext, { ...activity, id: iri })
  await putJsonLd(iri, deps.fetch, doc, { 'If-None-Match': '*' })
  return { ...activity, id: iri } as ActivityData
}

// ──────────────────────────
// Frame + normalization helpers
// ──────────────────────────

/** Whether the fetched activity document carries the given interop class as
 * one of its `@type`s. Sniffs the RAW wire doc (expanded or compacted form)
 * before any framing/compaction with `dataModelContext` — `@type` values are
 * full IRIs, or the compacted term name when the doc embeds `dataModelContext`
 * (test fixtures), so both are matched. */
function docHasClass(doc: unknown, classIri: string): boolean {
  const term = classIri.split(/[#/]/).pop()
  const nodes = Array.isArray(doc) ? doc : [doc]
  return nodes.some((node) => {
    const raw = (node as Record<string, unknown>)?.['@type']
    const types = typeof raw === 'string' ? [raw] : ((raw as string[] | undefined) ?? [])
    return types.some((type) => type === classIri || type === term)
  })
}

/** The need-based classes embed their request SNAPSHOT (never live links). */
const NEED_BASED_CLASSES = [
  INTEROP.NeedBasedAccessRequestSent,
  INTEROP.NeedBasedAccessRequestReceived,
]

/**
 * Frame an activity as a single document (the pinned single-doc read).
 * CLASS-GATED `as:object` handling (docs/jsonld.md TODO 2):
 * - `AuthorizationGranted` — DEFAULT frame (every property
 *   `@embed: '@never'`): the embedded DataAuthorization nodes frame to
 *   plain-IRI string(s); `loadActivity` re-frames the same doc per object id
 *   with `DataAuthorizationFromJsonLd` (two-phase framing — no embedded-node
 *   unwrapping).
 * - need-based classes — the DEEP frame: the request SNAPSHOT embeds with
 *   its COMPLETE group (sparql.md: the activity graph is self-contained;
 *   its needs incl. inherited children ride the graph, or the approval
 *   cannot resolve the group).
 * - every other class — the wildcard `@embed: '@always'`: snapshot objects
 *   embed from the same document (no cross-graph read); a live-link object
 *   is not in the document and stays a plain-IRI string (the framer never
 *   dereferences absent nodes).
 */
async function frameActivity(doc: unknown, id: string): Promise<Record<string, unknown>> {
  if (docHasClass(doc, INTEROP.AuthorizationGranted)) {
    return frameDoc(doc, dataModelContext, id)
  }
  if (NEED_BASED_CLASSES.some((cls) => docHasClass(doc, cls))) {
    return frameDoc(doc, dataModelContext, id, {
      object: {
        '@embed': '@always',
        hasAccessNeedGroup: {
          '@embed': '@always',
          hasAccessNeed: {
            '@embed': '@always',
            hasInheritingNeed: { '@embed': '@always' },
          },
        },
      },
    })
  }
  return frameDoc(doc, dataModelContext, id, { object: { '@embed': '@always' } })
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const node = value as { id?: unknown; '@id'?: unknown }
    if (typeof node.id === 'string') return node.id
    if (typeof node['@id'] === 'string') return node['@id']
  }
  return ''
}

/** Normalize a framed (possibly scalar-or-array) node value to a string. */
function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map(asString)
}

/**
 * The embedded snapshot's label. With the language-map container now in the
 * shared context, the embedded value frames as a language map already — pass
 * it through unchanged. (Older callers may still pass a plain string or a
 * `{ '@value', '@language' }` value object if the doc carried its own scalar
 * context.)
 */
function embeddedLabel(value: unknown): LanguageMap {
  if (isLanguageMap(value)) return value
  const entries = Array.isArray(value) ? value : [value]
  const map: LanguageMap = {}
  for (const entry of entries) {
    if (typeof entry === 'string') {
      map['@none'] = entry
    } else if (entry && typeof entry === 'object') {
      const v = entry as { '@value'?: unknown; '@language'?: unknown }
      if (typeof v['@value'] === 'string') {
        const lang = typeof v['@language'] === 'string' ? v['@language'] : '@none'
        map[lang] = v['@value']
      }
    }
  }
  return map
}

/** A framed language map (`@none` and/or bare language-tag string entries). */
function isLanguageMap(value: unknown): value is LanguageMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  return (
    keys.length > 0 &&
    keys.every((key) =>
      key.startsWith('@') ? key === '@none' : typeof candidate[key] === 'string'
    )
  )
}

/** The ASV activity types ride the `type` tuple beside the interop class. */
const ASV_ACTIVITY_TYPES = new Set(['as:Accept', 'as:Create', 'as:Add', 'as:Update'])

/**
 * The activity class — the `type` tuple element that is neither the generic
 * `Activity` nor an ASV type. JSON-LD `@type` is an UNORDERED set (the
 * SPARQL store may frame it back in any order), so the class is found by set
 * membership, never by position.
 */
function activityClass(type: string[]): string {
  return type.find((t) => t !== 'Activity' && !ASV_ACTIVITY_TYPES.has(t)) ?? 'Activity'
}

/** Read an activity resource from the Activity Registry into an ActivityData
 * (discriminated on the framed `type`). Refs come back as plain IRIs
 * (storage law); snapshot objects embed their POJO projection. The returned
 * `type` tuple is canonicalized to `['Activity', '<Class>', <as:*>]` — the
 * write order — regardless of the order the store returned it in. */
export async function loadActivity(id: string, fetch: WhatwgFetch): Promise<ActivityData> {
  const doc = await fetchJsonLd(id, fetch)
  const node = await frameActivity(doc, id)
  const type = (node.type as string[] | undefined) ?? []
  const cls = activityClass(type)
  const canonicalType = ['Activity', cls, ...type.filter((t) => ASV_ACTIVITY_TYPES.has(t))]
  const base = {
    id,
    target: asString(node.target),
    createdAt: asString(node.createdAt),
  }
  const actor = asString(node.actor)
  switch (cls) {
    case 'InvitationAccepted':
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'InvitationAccepted', 'as:Accept'],
        actor,
        // the urn:uuid snapshot — fields normalized (a single rdf:type
        // frames as a scalar string; the embedded POJOs type it as string[])
        object: {
          id: asString((node.object as EmbeddedSocialAgentInvitation)?.id),
          type: asStringArray((node.object as EmbeddedSocialAgentInvitation)?.type),
          capabilityUrl: asString((node.object as EmbeddedSocialAgentInvitation)?.capabilityUrl),
          label: embeddedLabel((node.object as EmbeddedSocialAgentInvitation)?.label),
          note:
            (node.object as EmbeddedSocialAgentInvitation)?.note === undefined
              ? undefined
              : asString((node.object as EmbeddedSocialAgentInvitation)?.note),
        },
      }
    case 'InvitationCreated':
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'InvitationCreated', 'as:Create'],
        actor,
        object: {
          id: asString((node.object as CreateInvitationPojo)?.id),
          type: asStringArray((node.object as CreateInvitationPojo)?.type),
          label: embeddedLabel((node.object as CreateInvitationPojo)?.label),
          note:
            (node.object as CreateInvitationPojo)?.note === undefined
              ? undefined
              : asString((node.object as CreateInvitationPojo)?.note),
        },
      }
    case 'NeedBasedAccessRequestSent': {
      // forwards it to the data owner's (reused) issuance endpoint // access need group) rides the object; the requester-side workflow // target dropped — the request snapshot (urn:uuid id, the embedded
      const embedded = node.object as EmbeddedNeedBasedAccessRequest | undefined
      const group = embedded?.hasAccessNeedGroup
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'NeedBasedAccessRequestSent'],
        actor,
        object: {
          id: asString(embedded?.id),
          type: asStringArray(embedded?.type),
          grantee: asString(embedded?.grantee),
          grantedBy: asString(embedded?.grantedBy),
          dataOwner: asString(embedded?.dataOwner),
          // the framed group node is NORMALIZED like the other embedded
          // objects — a single rdf:type frames as a scalar, so `type`
          // goes through asStringArray (no shape assertion)
          hasAccessNeedGroup: {
            id: asString(group),
            type: asStringArray(group?.type),
            hasAccessNeed: group?.hasAccessNeed ?? [],
          },
        },
      }
    }
    case 'NeedBasedAccessRequestReceived': {
      // the owner-side workflow PUTs the AccessRequest resource there // the request-to-be as a REAL-ID embedded projection at the minted id; // minted half — `target` = the AccessRequest registry; the object is
      const embedded = node.object as EmbeddedNeedBasedAccessRequest | undefined
      const group = embedded?.hasAccessNeedGroup
      return {
        ...base,
        type: canonicalType as ['Activity', 'NeedBasedAccessRequestReceived'],
        actor,
        object: {
          id: asString(embedded?.id),
          type: asStringArray(embedded?.type),
          grantee: asString(embedded?.grantee),
          grantedBy: asString(embedded?.grantedBy),
          dataOwner: asString(embedded?.dataOwner),
          hasAccessNeedGroup: {
            id: asString(group),
            type: asStringArray(group?.type),
            hasAccessNeed: group?.hasAccessNeed ?? [],
          },
        },
      }
    }
    case 'AgentRegistrationAdded':
      return {
        ...base,
        type: canonicalType as ['Activity', 'AgentRegistrationAdded', 'as:Add'],
        actor,
        object: {
          id: asString((node.object as EmbeddedSocialAgentRegistration)?.id),
          type: asStringArray((node.object as EmbeddedSocialAgentRegistration)?.type),
          registeredAgent: asString(
            (node.object as EmbeddedSocialAgentRegistration)?.registeredAgent
          ),
          label: embeddedLabel((node.object as EmbeddedSocialAgentRegistration)?.label),
          note:
            (node.object as EmbeddedSocialAgentRegistration)?.note === undefined
              ? undefined
              : asString((node.object as EmbeddedSocialAgentRegistration)?.note),
        },
      }
    case 'AdminAuthorizationGranted':
      // target dropped (step 5) — the AdminAuthorization-to-be (real-id
      // embedded projection at the pre-minted id) rides the object; the
      // addAdmin workflow PUTs the resource at object.id
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'AdminAuthorizationGranted'],
        actor,
        object: {
          id: asString((node.object as EmbeddedAdminAuthorization)?.id),
          type: asStringArray((node.object as EmbeddedAdminAuthorization)?.type),
          grantee: asString((node.object as EmbeddedAdminAuthorization)?.grantee),
          grantedBy: asString((node.object as EmbeddedAdminAuthorization)?.grantedBy),
          scopeOfAuthorization: asString(
            (node.object as EmbeddedAdminAuthorization)?.scopeOfAuthorization
          ),
        },
      }
    case 'AdminAuthorizationRevoked':
      // target dropped (step 6) — the existing AdminAuthorization (real-id
      // embedded projection at its id, alive at write) rides the object; the
      // removeAdmin workflow DELETEs the resource at object.id
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'AdminAuthorizationRevoked'],
        actor,
        object: {
          id: asString((node.object as EmbeddedAdminAuthorization)?.id),
          type: asStringArray((node.object as EmbeddedAdminAuthorization)?.type),
          grantee: asString((node.object as EmbeddedAdminAuthorization)?.grantee),
          grantedBy: asString((node.object as EmbeddedAdminAuthorization)?.grantedBy),
          scopeOfAuthorization: asString(
            (node.object as EmbeddedAdminAuthorization)?.scopeOfAuthorization
          ),
        },
      }
    case 'AuthorizationGranted': {
      // two-phase framing (docs/jsonld.md TODO 2): phase 1 (default frame)
      // gave the object as plain-IRI string(s) — a single embedded node
      // frames as a scalar (jsonld.md gotcha 1), so wrap it; phase 2
      // re-frames the SAME doc per object id via the standard
      // data-authorization read path → full `DataAuthorizationData` POJOs
      // (plain-IRI refs, @reverse children resolved), no node unwrapping.
      // Declines are `AuthorizationDenied` (Step 4): no snapshot form lives
      // on this class anymore.
      const objectIds = asStringArray(node.object)
      return {
        ...base,
        type: canonicalType as ['Activity', 'AuthorizationGranted'],
        actor,
        // the owner-span close (see the OpenWiki `services/activity-lifecycle.md`) — optional,
        // direct approvals without a request carry none
        satisfiesAccessRequest:
          node.satisfiesAccessRequest === undefined
            ? undefined
            : asString(node.satisfiesAccessRequest),
        object: await Promise.all(
          objectIds.map((objectId) => DataAuthorizationFromJsonLd(doc, objectId))
        ),
      }
    }
    case 'AuthorizationDenied': {
      // decline — no `target`; the request-structure snapshot (urn:uuid)
      // carrying `grantee` rides the object; cast once per object
      const embedded = node.object as EmbeddedAuthorization | undefined
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'AuthorizationDenied'],
        actor,
        // the owner-span close (see the OpenWiki `services/activity-lifecycle.md`) — optional,
        // direct declines without a request carry none
        satisfiesAccessRequest:
          node.satisfiesAccessRequest === undefined
            ? undefined
            : asString(node.satisfiesAccessRequest),
        object: {
          id: asString(embedded?.id),
          type: asStringArray(embedded?.type),
          grantee: asString(embedded?.grantee),
          hasAccessNeedGroup: embedded?.hasAccessNeedGroup
            ? asString(embedded?.hasAccessNeedGroup)
            : undefined,
        },
      }
    }
    case 'AccessRequestGranted': {
      // requester-side resolution (see the OpenWiki `services/activity-lifecycle.md`) — the
      // light `{ id, type }` ref of the Sent activity's SNAPSHOT id (the
      // grant landed — written by the detectGrantedRequests child). No
      // `target`, no `ActivityCompleted` (terminal resolution).
      const embedded = node.object as EmbeddedAccessRequestRef | undefined
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'AccessRequestGranted'],
        actor,
        object: {
          id: asString(embedded?.id),
          type: asStringArray(embedded?.type),
        },
      }
    }
    case 'AccessRequestArchived': {
      // requester-side user close (see the OpenWiki `services/activity-lifecycle.md`) — the
      // light `{ id, type }` ref of the Sent activity's SNAPSHOT id (the
      // archiveAccessRequest RPC). No `target`, no `ActivityCompleted`.
      const embedded = node.object as EmbeddedAccessRequestRef | undefined
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'AccessRequestArchived'],
        actor,
        object: {
          id: asString(embedded?.id),
          type: asStringArray(embedded?.type),
        },
      }
    }
    case 'AuthorizationRevoked':
      return {
        ...base,
        type: canonicalType as ['Activity', 'AuthorizationRevoked'],
        actor,
        object: asStringArray(node.object),
      }
    case 'RoleCreated':
      // target dropped (step 9) — the role-to-be (real-id embedded
      // projection at the PRE-MINTED id) rides the object; the workflow
      // PUTs the role at object.id
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'RoleCreated', 'as:Add'],
        actor,
        object: {
          id: asString((node.object as RoleData)?.id),
          type: asStringArray((node.object as RoleData)?.type),
          // the decode surfaces the picked plain string — re-wrap it into the
          // language map the RoleData type carries
          label: embeddedLabel((node.object as RoleData)?.label),
          members: asStringArray((node.object as RoleData)?.members),
        },
      }
    case 'RoleMembershipChanged':
      // target dropped (step 2) — the role-to-be (real-id embedded
      // projection) rides the object; the workflow PATCHes the role to it
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'RoleMembershipChanged', 'as:Update'],
        actor,
        object: {
          id: asString((node.object as RoleData)?.id),
          type: asStringArray((node.object as RoleData)?.type),
          // the decode surfaces the picked plain string — re-wrap it into the
          // language map the RoleData type carries
          label: embeddedLabel((node.object as RoleData)?.label),
          members: asStringArray((node.object as RoleData)?.members),
        },
      }
    case 'RoleDeleted':
      // target dropped (step 3) — the role-to-be-deleted (real-id embedded
      // projection, alive at write) rides the object; the workflow DELETEs it
      return {
        id,
        createdAt: asString(node.createdAt),
        type: canonicalType as ['Activity', 'RoleDeleted'],
        actor,
        object: {
          id: asString((node.object as RoleData)?.id),
          type: asStringArray((node.object as RoleData)?.type),
          // the decode surfaces the picked plain string — re-wrap it into the
          // language map the RoleData type carries
          label: embeddedLabel((node.object as RoleData)?.label),
          members: asStringArray((node.object as RoleData)?.members),
        },
      }
    case 'DelegatedGrantsUpdated':
      return {
        ...base,
        type: canonicalType as ['Activity', 'DelegatedGrantsUpdated'],
        actor,
        object: asString(node.object),
      }
    case 'ActivityCompleted':
      return { ...base, type: canonicalType as ['Activity', 'ActivityCompleted'] }
    default:
      throw new Error(`unknown activity class: ${JSON.stringify(type)}`)
  }
}

/**
 * Record the completion of an activity: PUT a minimal `activityCompleted`
 * activity whose `target` is the completed activity's IRI. Activity resources
 * are never mutated — 'done' is represented by the existence of a completion,
 * not by a status change. Uses a random IRI like any other activity; duplicate
 * completions (concurrent completers) are accepted for now.
 */
export async function createCompletion(
  data: ActivityRegistryData,
  deps: DataModelDependencies,
  completedId: string
): Promise<void> {
  const iri = iriForContained(data, deps.randomUUID)
  const doc = withContext(dataModelContext, {
    id: iri,
    type: ['Activity', 'ActivityCompleted'],
    target: completedId,
    createdAt: new Date().toISOString(),
  })
  await putJsonLd(iri, deps.fetch, doc, { 'If-None-Match': '*' })
}

/**
 * IRIs of all completed activities — the `target`s of every `activityCompleted`
 * activity in the registry (the `type` discriminant). Completions are terminal
 * and never reference each other, so no transitive closure is needed. (One
 * load per activity; used by the pending filters and by tests.)
 */
export async function getCompletedActivityIris(
  data: ActivityRegistryData,
  fetch: WhatwgFetch
): Promise<string[]> {
  const iris = await getActivityIris(data, fetch)
  const completed: string[] = []
  for (const iri of iris) {
    const activity = await loadActivity(iri, fetch)
    if (isActivityClass(activity, 'ActivityCompleted') && 'target' in activity) {
      completed.push(activity.target)
    }
  }
  return completed
}
