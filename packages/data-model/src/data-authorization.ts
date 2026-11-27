import { frameNode, projectNode, withContext } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedDataAuthorization = {
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
  accessMode?: Array<string>
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

const DATA_AUTHORIZATION_TERMS = [
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

export async function fromJsonLd(doc: unknown, id: string): Promise<DataAuthorizationData> {
  const framed = (await frameNode(doc, dataModelContext, id)) as unknown as FramedDataAuthorization
  const node = projectNode(framed, DATA_AUTHORIZATION_TERMS)
  return {
    ...node,
    grantee: node.grantee ?? '',
    grantedBy: node.grantedBy ?? '',
    registeredShapeTree: node.registeredShapeTree ?? '',
    scopeOfAuthorization: node.scopeOfAuthorization ?? '',
    accessMode: node.accessMode ?? [],
  }
}

export function toJsonLd(data: FinalDataAuthorizationData): Record<string, unknown> {
  return withContext(dataModelContext, data)
}
