import {
  type AccessGrantData,
  type DataGrantData,
  type FinalAccessGrantData,
  type FinalDataGrantData,
  dataGrantTemplate,
} from '@janeirodigital/interop-data-model'
import {
  discoverAuthorizationAgent,
  discoverDelegationIssuanceEndpoint,
  fetchWrapper,
  getAcl,
} from '@janeirodigital/interop-utils'
import { buildSessionManager } from '../../builders/sessionManager.js'

export interface FindAffectedAuthorizationsInput {
  webId: string
  peerId: string
}

export interface UpdateGrantsInput {
  webId: string
  authorizationId: string
}

export async function findAffectedAuthorizations(
  payload: FindAffectedAuthorizationsInput
): Promise<UpdateGrantsInput[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId)
  const affectedAuthorizations =
    await session.registrySet.hasAuthorizationRegistry.findAuthorizationsDelegatingFromOwner(
      payload.peerId
    )
  return affectedAuthorizations.map((authorization) => ({
    webId: payload.webId,
    authorizationId: authorization.iri,
  }))
}

export interface CreateGrantsInput {
  webId: string
  authorizationId: string
}

export async function generateGrants(payload: CreateGrantsInput): Promise<AccessGrantData> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId)

  return session.generateAccessGrant(payload.authorizationId)
}

export async function storeDataGrant(payload: FinalDataGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.dataOwner)

  const grant = session.factory.immutable.dataGrant(payload.id, payload)
  return grant.put()
}

export async function createAcr(payload: FinalDataGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.dataOwner)
  // TODO: improve error handling
  let uasId
  try {
    uasId = await discoverAuthorizationAgent(payload.grantee, fetchWrapper(fetch))
  } catch {}
  let peer
  let client
  if (uasId) {
    peer = {
      agent: payload.grantedBy,
      client: payload.grantee,
    }
  } else {
    peer = {
      agent: payload.grantedBy,
      client: await discoverAuthorizationAgent(payload.grantedBy, fetchWrapper(fetch)),
    }
    client = {
      agent: payload.grantedBy,
      client: payload.grantee,
    }
  }
  const headResponse = await session.rawFetch(payload.id, {
    method: 'HEAD',
  })
  const acrId = getAcl(headResponse.headers.get('link'))
  const acr = dataGrantTemplate({
    id: acrId,
    resource: payload.id,
    owner: {
      agent: session.webId,
      client: session.agentId,
    },
    peer,
    client,
  }).replaceAll('\n', '')
  const response = await session.rawFetch(acrId, {
    method: 'PUT',
    body: acr,
    headers: {
      'content-type': 'text/turtle',
    },
  })
  if (!response.ok) {
    throw new Error(`${response.status} - ${acrId}`)
  }
}

export async function requestDelegation(payload: { grantData: DataGrantData }): Promise<string[]> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.grantData.grantedBy)

  // TODO: do discovery in previous workflow step and pass endpoint in activity payload
  const endpoint = await discoverDelegationIssuanceEndpoint(
    payload.grantData.dataOwner,
    session.fetch
  )
  const response = await session.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload.grantData),
  })
  if (!response.ok) {
    throw new Error(await response.json())
  }
  if (response.status !== 200) {
    throw new Error(`expected 200 but received ${response.status}`)
  }
  return response.json() as Promise<string[]>
}

// TODO: check case when granted === false
export async function storeAccessGrant(payload: FinalAccessGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.grantedBy)

  const accessGrant = session.factory.immutable.accessGrant(payload.id, payload)

  return accessGrant.put()
}

export async function setAccessGrant(payload: FinalAccessGrantData): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.grantedBy)

  const agentRegistration = await session.registrySet.hasAgentRegistry.findRegistration(
    payload.grantee
  )

  if (!agentRegistration) {
    throw new Error('agent registration for the grantee does not exist')
  }

  await agentRegistration.setAccessGrant(payload.id)
}
