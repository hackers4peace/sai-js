import { frameNode, projectNode, required } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedDataRegistration = {
  id: string
  type?: Array<string>
  registeredShapeTree?: string
  contains: Array<string>
  lwsContains: Array<string>
  lwsPartOf?: string
}

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

const DATA_REGISTRATION_TERMS = [
  'registeredShapeTree',
  'contains',
  'lwsContains',
  'lwsPartOf',
] as const

export async function fromJsonLd(doc: unknown, id: string): Promise<DataRegistrationData> {
  const framed = (await frameNode(doc, dataModelContext, id, {
    terms: DATA_REGISTRATION_TERMS,
  })) as unknown as FramedDataRegistration
  const node = projectNode(framed, DATA_REGISTRATION_TERMS)
  // Flat LWS storage keeps membership as `lws:contains` and the parent as
  // `lws:partOf`; path-based storage uses `ldp:contains` and the URI path.
  // Both are exposed as `contains` / `partOf`.
  const { lwsContains, lwsPartOf, ...rest } = node
  return {
    ...rest,
    registeredShapeTree: required(rest, 'registeredShapeTree'),
    contains: [...new Set([...rest.contains, ...lwsContains])],
    ...(lwsPartOf ? { partOf: lwsPartOf } : {}),
  }
}
