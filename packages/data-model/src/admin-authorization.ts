import { frameNode, selectNode, withContext } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type AdminAuthorizationData = {
  id: string
  type: Array<string>
  grantee: string
  grantedBy: string
  scopeOfAuthorization: string
}

const ADMIN_AUTHORIZATION_TERMS = ['grantee', 'grantedBy', 'scopeOfAuthorization']

export async function fromJsonLd(doc: unknown, id: string): Promise<AdminAuthorizationData> {
  return selectNode(
    await frameNode(doc, dataModelContext, id),
    ADMIN_AUTHORIZATION_TERMS
  ) as unknown as AdminAuthorizationData
}

export function toJsonLd(data: AdminAuthorizationData): Record<string, unknown> {
  return withContext(dataModelContext, data)
}
