import {
  INTEROP,
  frameNode,
  projectNode,
  required,
  withContext,
} from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type FramedDataAuthorization = {
  id?: string
  type?: Array<string>
  grantee?: string
  grantedBy?: string
  registeredShapeTree?: string
  scopeOfAuthorization?: string
  dataOwner?: string
  hasDataRegistration?: string
  satisfiesAccessNeed?: string
  inheritsFromAuthorization?: string
  accessMode: Array<string>
  hasDataInstance?: Array<string>
  hasInheritingAuthorization?: Array<string>
}

export type DataAuthorizationId = {
  id?: string
  type: Array<string>
}

export type DataAuthorizationData = DataAuthorizationId & {
  grantee: string
  grantedBy: string
  registeredShapeTree: string
  scopeOfAuthorization: string
  dataOwner?: string
  hasDataRegistration?: string
  satisfiesAccessNeed?: string
  inheritsFromAuthorization?: string // parent data authorization IRI (Inherited scope)
  accessMode: Array<string>
  hasDataInstance?: Array<string>
  // Children discovered via inverse quads in the dataset (lazily resolved)
  hasInheritingAuthorization?: Array<string> // child data authorization IRIs
}

/** A data authorization that has been assigned its IRI. */
export type FinalDataAuthorizationData = DataAuthorizationData &
  Required<Pick<DataAuthorizationData, 'id'>>

export const DATA_AUTHORIZATION_TERMS = [
  'grantee',
  'grantedBy',
  'registeredShapeTree',
  'scopeOfAuthorization',
  'dataOwner',
  'hasDataRegistration',
  'satisfiesAccessNeed',
  'inheritsFromAuthorization',
  'accessMode',
  'hasDataInstance',
  'hasInheritingAuthorization',
] as const

/**
 * A required term, validated only when the node IS a data authorization.
 *
 * The same decoder doubles as a probe over an authorization registry
 * container, where `AdminAuthorization` (and other) resources share the
 * container and are filtered by type at the call site (`getDataAuthorization`
 * in sparql.ts). Foreign nodes keep the tolerant empty-field POJO; a real
 * `interop:DataAuthorization` missing a required term throws.
 */
function requiredTerm(node: Record<string, unknown>, key: string, strict: boolean): string {
  return strict ? required(node, key) : ((node[key] as string | undefined) ?? '')
}

/**
 * The POJO projection of an already-framed node — the shared decoder for a
 * direct read and for a caller that framed the node in a larger frame (the
 * activity decode frames an activity and its embedded DataAuthorizations in
 * one multi-`@id` call).
 */
export function fromFramedNode(framed: FramedDataAuthorization): DataAuthorizationData {
  const node = projectNode(framed, DATA_AUTHORIZATION_TERMS)
  const strict = node.type.includes(INTEROP.DataAuthorization)
  return {
    ...node,
    grantee: requiredTerm(node, 'grantee', strict),
    grantedBy: requiredTerm(node, 'grantedBy', strict),
    registeredShapeTree: requiredTerm(node, 'registeredShapeTree', strict),
    scopeOfAuthorization: requiredTerm(node, 'scopeOfAuthorization', strict),
  }
}

export async function fromJsonLd(doc: unknown, id: string): Promise<DataAuthorizationData> {
  const framed = (await frameNode(doc, dataModelContext, id, {
    terms: DATA_AUTHORIZATION_TERMS,
  })) as unknown as FramedDataAuthorization
  return fromFramedNode(framed)
}

export function toJsonLd(data: FinalDataAuthorizationData): Record<string, unknown> {
  return withContext(dataModelContext, data)
}
