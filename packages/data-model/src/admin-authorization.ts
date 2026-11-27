import { frameNode, projectNode, withContext } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedAdminAuthorization = {
  id: string
  type?: Array<string>
  grantee?: string
  grantedBy?: string
  scopeOfAuthorization?: string
}

const ADMIN_AUTHORIZATION_TERMS = ['grantee', 'grantedBy', 'scopeOfAuthorization'] as const

export type AdminAuthorizationData = {
  id: string
  type: Array<string>
  grantee: string
  grantedBy: string
  scopeOfAuthorization: string
}

export async function fromJsonLd(doc: unknown, id: string): Promise<AdminAuthorizationData> {
  const framed = (await frameNode(doc, dataModelContext, id)) as unknown as FramedAdminAuthorization
  const node = projectNode(framed, ADMIN_AUTHORIZATION_TERMS)
  return {
    ...node,
    grantee: node.grantee ?? '',
    grantedBy: node.grantedBy ?? '',
    scopeOfAuthorization: node.scopeOfAuthorization ?? '',
  }
}

export function toJsonLd(data: AdminAuthorizationData): Record<string, unknown> {
  return withContext(dataModelContext, data)
}
