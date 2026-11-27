import { frameNode, projectNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedClientIdDocument = {
  id: string
  type?: Array<string>
  callbackEndpoint?: string
  hasAccessNeedGroup?: string
  clientName?: string
  logoUri?: string
}

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
  const framed = (await frameNode(doc, dataModelContext, id, {
    terms: CLIENT_ID_DOCUMENT_TERMS,
  })) as unknown as FramedClientIdDocument
  return projectNode(framed, CLIENT_ID_DOCUMENT_TERMS)
}
