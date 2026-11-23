import { frameNode, selectNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type ClientIdDocumentId = {
  id: string
  type: Array<string>
}

export type ClientIdDocumentData = ClientIdDocumentId & {
  callbackEndpoint?: string
  hasAccessNeedGroup?: string
  clientName?: string
  logoUri?: string
}

const CLIENT_ID_DOCUMENT_TERMS = [
  'callbackEndpoint',
  'hasAccessNeedGroup',
  'clientName',
  'logoUri',
] as const

export async function fromJsonLd(doc: unknown, id: string): Promise<ClientIdDocumentData> {
  return selectNode(
    await frameNode(doc, dataModelContext, id),
    CLIENT_ID_DOCUMENT_TERMS
  ) as unknown as ClientIdDocumentData
}
