import { frameNode, selectNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type DataRegistrationId = {
  id: string
  type: Array<string>
}

export type DataRegistrationData = DataRegistrationId & {
  registeredShapeTree: string
  /** Resources contained in the registration (LDP containment, server-managed). */
  contains: Array<string>
  /**
   * The container the registration belongs to (flat LWS storage keeps this in
   * metadata, so it does not follow from the registration's URI path).
   */
  partOf?: string
}

const DATA_REGISTRATION_TERMS = ['registeredShapeTree', 'contains', 'lwsContains', 'lwsPartOf']

export async function fromJsonLd(doc: unknown, id: string): Promise<DataRegistrationData> {
  // `@container: '@set'` guarantees an array for values that are present, but
  // framing omits a property with no values (`buildFrame` sets
  // `@omitDefault: true` on every term). A registration with no instances has
  // no `ldp:contains` triples, so the frame supplies `@default: []` for
  // `contains` — the framed node is always an array, matching the type
  // (JSON-LD 1.1 Framing: `@default` + `@omitDefault`).
  const node = (await selectNode(
    await frameNode(doc, dataModelContext, id, {
      contains: { '@embed': '@never', '@default': [] },
      lwsContains: { '@embed': '@never', '@default': [] },
    }),
    DATA_REGISTRATION_TERMS
  )) as DataRegistrationData & { lwsContains?: Array<string>; lwsPartOf?: string }
  // Flat LWS storage keeps membership as `lws:contains` and the parent as
  // `lws:partOf`; path-based storage uses `ldp:contains` and the URI path.
  // Both are exposed as `contains` / `partOf`.
  const { lwsContains, lwsPartOf, ...rest } = node
  return {
    ...rest,
    contains: [...new Set([...(rest.contains ?? []), ...(lwsContains ?? [])])],
    ...(lwsPartOf ? { partOf: lwsPartOf } : {}),
  }
}
