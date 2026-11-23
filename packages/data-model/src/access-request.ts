import { frameNode, selectNode } from '@janeirodigital/interop-utils'

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
const NEED_BASED_ACCESS_REQUEST_TERMS = [
  'grantee',
  'grantedBy',
  'dataOwner',
  'hasAccessNeedGroup',
] as const

export async function fromJsonLd(doc: unknown, id: string): Promise<NeedBasedAccessRequestData> {
  const node = await frameNode(doc, dataModelContext, id, {
    hasAccessNeedGroup: {
      '@embed': '@always',
      hasAccessNeed: {
        '@embed': '@always',
        hasInheritingNeed: { '@embed': '@always' },
      },
    },
  })
  const selected = selectNode(node, NEED_BASED_ACCESS_REQUEST_TERMS)
  const group = selected.hasAccessNeedGroup as unknown as Record<string, unknown> | undefined
  return {
    id,
    type: node.type ?? [],
    grantee: node.grantee as string,
    grantedBy: node.grantedBy as string,
    dataOwner: node.dataOwner as string,
    hasAccessNeedGroup: group
      ? {
          id: group.id as string,
          type: (group.type as Array<string> | undefined) ?? [],
          // the deep frame EMBEDS the need nodes (children incl. inherited
          // children ride the graph) — pass them through, not as IRI strings
          hasAccessNeed: (group.hasAccessNeed as Array<unknown> | undefined) ?? [],
        }
      : { id: '', type: [], hasAccessNeed: [] },
  }
}
