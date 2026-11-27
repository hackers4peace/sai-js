import { frameNode, projectNode, required } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'
/** The embedded access need group of a need-based access request — the
 *  framed group node (Project + inherited needs; descriptions follow-up). The
 *  values are (expanded-form) IRIs — bare class names are NOT expanded by
 *  `dataModelContext`, so the payload carries full IRIs for `type`,
 *  `registeredShapeTree`, `required` and `accessMode`. */
export type NeedBasedAccessRequestGroup = {
  id: string
  type: Array<string>
  hasAccessNeed: Array<unknown>
}

/**
 * The stored need-based access request — the immutable resource the
 * owner-side workflow materializes in the AccessRequestRegistry
 * (authorization-granting.md §6.3). `hasAccessNeedGroup` holds the embedded
 * (framed) group — no status field: granting only ever REFERENCES the
 * request, dataOwner's registry never mutates it.
 */
export interface NeedBasedAccessRequestData {
  id: string
  type: Array<string>
  grantee: string
  grantedBy: string
  dataOwner: string
  hasAccessNeedGroup: NeedBasedAccessRequestGroup
}

/**
 * Frame a stored AccessRequest document into `NeedBasedAccessRequestData`
 * (authorization-granting.md §6.3). The embedded group node is EMBEDDED
 * (`hasAccessNeedGroup` is `@type: '@id'`-coerced, so the default framing
 * would return only its id string) and normalized like the activity read —
 * a single `rdf:type` frames as a scalar, so `type` goes through the
 * array-form.
 */
type FramedAccessNeedGroup = {
  id: string
  type?: Array<string>
  hasAccessNeed: Array<unknown>
}

type FramedAccessRequest = {
  id: string
  type?: Array<string>
  grantee?: string
  grantedBy?: string
  dataOwner?: string
  hasAccessNeedGroup?: FramedAccessNeedGroup | null
}

const NEED_BASED_ACCESS_REQUEST_TERMS = [
  'grantee',
  'grantedBy',
  'dataOwner',
  'hasAccessNeedGroup',
] as const

const ACCESS_NEED_GROUP_TERMS = ['type', 'hasAccessNeed'] as const

/**
 * The embedded group must be a framed node with at least one access need.
 * A group node without `hasAccessNeed` never matches the nested frame (a
 * subframe's property list is a match requirement — Framing §4.2), so it
 * arrives as `null`; a node with no projected properties at all compacts to a
 * bare IRI string. Both, and an empty need list, are invalid requests.
 */
function framedGroup(value: unknown, id: string): NeedBasedAccessRequestGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`access request ${id} has no embedded access need group`)
  }
  const node = projectNode(value as FramedAccessNeedGroup, ACCESS_NEED_GROUP_TERMS)
  if (node.hasAccessNeed.length === 0) {
    throw new Error(`access request ${id} has an access need group without access needs`)
  }
  return node
}

export async function fromJsonLd(doc: unknown, id: string): Promise<NeedBasedAccessRequestData> {
  const framed = (await frameNode(doc, dataModelContext, id, {
    terms: NEED_BASED_ACCESS_REQUEST_TERMS,
    overrides: {
      hasAccessNeedGroup: {
        '@embed': '@always',
        hasAccessNeed: {
          '@embed': '@always',
          hasInheritingNeed: { '@embed': '@always' },
        },
      },
    },
  })) as unknown as FramedAccessRequest
  const node = projectNode(framed, NEED_BASED_ACCESS_REQUEST_TERMS)
  return {
    ...node,
    grantee: required(node, 'grantee'),
    grantedBy: required(node, 'grantedBy'),
    dataOwner: required(node, 'dataOwner'),
    hasAccessNeedGroup: framedGroup(node.hasAccessNeedGroup, id),
  }
}
