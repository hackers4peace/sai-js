import { frameNode, selectNode, withContext } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type GrantId = {
  id?: string
  type: string[]
}

export type GrantData = GrantId & {
  grantee: string
  grantedBy: string
  dataOwner: string
  registeredShapeTree: string
  hasDataRegistration: string
  hasStorage: string
  scopeOfGrant: string
  accessMode: string[]
  creatorAccessMode?: string[]
  hasDataInstance?: string[]
  inheritsFromGrant?: string // parent grant IRI (Inherited scope)
  hasInheritingGrant?: string[] // child grant IRIs
}

/** A grant that has been assigned its storage IRI. */
export type FinalGrantData = GrantData & Required<Pick<GrantData, 'id'>>

export interface GeneratedGrants {
  sourceGrants: FinalGrantData[]
  delegatedGrants: GrantData[]
}

const GRANT_TERMS = [
  'grantee',
  'grantedBy',
  'dataOwner',
  'registeredShapeTree',
  'hasDataRegistration',
  'hasStorage',
  'scopeOfGrant',
  'accessMode',
  'creatorAccessMode',
  'hasDataInstance',
  'inheritsFromGrant',
  'hasInheritingGrant',
] as const

export async function fromJsonLd(doc: unknown, id: string): Promise<GrantData> {
  return selectNode(await frameNode(doc, dataModelContext, id), GRANT_TERMS) as unknown as GrantData
}
export function toJsonLd(grant: FinalGrantData): Record<string, unknown> {
  return withContext(dataModelContext, grant)
}

export function dataRegistryIri(grant: GrantData): string {
  const parts = grant.hasDataRegistration.split('/')
  return `${parts.slice(0, -2).join('/')}/`
}
