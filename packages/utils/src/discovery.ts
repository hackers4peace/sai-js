import type { DatasetCore } from '@rdfjs/types'
import { DataFactory } from 'n3'
import type { RdfFetch, WhatwgFetch } from './fetch'
import { parseJsonld } from './jsonld-parser'
import {
  getAcl,
  getAgentRegistrationIri,
  getDescriptionResource,
  getStorageDescription,
} from './link-header'
import { getOneMatchingQuad } from './match'
import { INTEROP, NOTIFY } from './namespaces'

export class RequestError extends Error {
  constructor(
    message: string,
    public response: Response
  ) {
    super(message)
  }
}

export class AgentRegistrationDiscoveryError extends RequestError {
  constructor(public response: Response) {
    super('Discovery: Agent Registration - request failed', response)
  }
}

export class DescriptionResourceDiscoveryError extends RequestError {
  constructor(public response: Response) {
    super('Discovery: Resource Description - request failed', response)
  }
}

export class AccessResourceDiscoveryError extends RequestError {
  constructor(public response: Response) {
    super('Discovery: Access Resource - request failed', response)
  }
}

export class StorageDescriptionDiscoveryError extends RequestError {
  constructor(public response: Response) {
    super('Discovery: Storage Description - request failed', response)
  }
}

export async function discoverAuthorizationAgent(
  webId: string,
  rdfFetch: RdfFetch
): Promise<string | undefined> {
  const userDataset: DatasetCore = await (await rdfFetch(webId)).dataset()
  const authorizationAgentPattern = [
    DataFactory.namedNode(webId),
    INTEROP.hasAuthorizationAgent,
    null,
  ]
  return getOneMatchingQuad(userDataset, ...authorizationAgentPattern)?.object.value
}

export async function discoverDelegationIssuanceEndpoint(
  webId: string,
  rdfFetch: RdfFetch
): Promise<string | undefined> {
  const userDataset: DatasetCore = await (await rdfFetch(webId)).dataset()
  const delegationIssuanceEndpointPattern = [
    DataFactory.namedNode(webId),
    INTEROP.hasDelegationIssuanceEndpoint,
    null,
  ]
  return getOneMatchingQuad(userDataset, ...delegationIssuanceEndpointPattern)?.object.value
}

export async function discoverAgentRegistration(
  authorizationAgentIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(authorizationAgentIri, { method: 'HEAD' })
  if (!response.ok) throw new AgentRegistrationDiscoveryError(response)
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) return undefined
  return getAgentRegistrationIri(linkHeader)
}

export async function discoverDescriptionResource(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, { method: 'HEAD' })
  if (!response.ok) throw new DescriptionResourceDiscoveryError(response)
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) return undefined
  return getDescriptionResource(linkHeader)
}

export async function discoverAccessResource(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, { method: 'HEAD' })
  if (!response.ok) throw new AccessResourceDiscoveryError(response)
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) return undefined
  return getAcl(linkHeader)
}

export async function discoverStorageDescription(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, { method: 'HEAD' })
  if (!response.ok) throw new StorageDescriptionDiscoveryError(response)
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) return undefined
  return getStorageDescription(linkHeader)
}

export async function discoverAuthorizationRedirectEndpoint(
  authorizationAgentIri: string,
  fetch: WhatwgFetch
): Promise<string> {
  const authzAgentDocumentResponse = await fetch(authorizationAgentIri, {
    headers: { Accept: 'application/ld+json' },
  })
  const doc = await parseJsonld(
    await authzAgentDocumentResponse.text(),
    authzAgentDocumentResponse.url
  )
  return getOneMatchingQuad(doc, null, INTEROP.hasAuthorizationRedirectEndpoint)!.object.value
}

export async function discoverWebPushService(
  authorizationAgentIri: string,
  fetch: WhatwgFetch
): Promise<{ id: string; vapidPublicKey: string } | undefined> {
  const authzAgentDocumentResponse = await fetch(authorizationAgentIri, {
    headers: { Accept: 'application/ld+json' },
  })
  const doc = await parseJsonld(
    await authzAgentDocumentResponse.text(),
    authzAgentDocumentResponse.url
  )
  const serviceQuad = getOneMatchingQuad(doc, null, INTEROP.pushService)
  const publicKeyQuad = getOneMatchingQuad(doc, null, NOTIFY.vapidPublicKey)
  if (!serviceQuad || !publicKeyQuad) return
  return {
    id: serviceQuad.object.value,
    vapidPublicKey: publicKeyQuad.object.value,
  }
}
