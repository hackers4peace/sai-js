import {
  type AccessGrantData,
  type DataGrantData,
  ImmutableDataGrant,
} from '@janeirodigital/interop-data-model'
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

export interface GenerateGrantsOutput {
  accessGrantIri: string
  accessGrantData: AccessGrantData
  dataGrantsToStore: Array<{ iri: string; data: DataGrantData }>
}

export async function generateGrants(payload: CreateGrantsInput): Promise<GenerateGrantsOutput> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.webId)

  const accessGrant = await session.generateAccessGrant(payload.authorizationId)

  // @ts-ignore - hasInheritingGrant contains class instances, map to plain objects for serialization
  const dataGrantsToStore = accessGrant.dataGrants
    .filter((grant): grant is ImmutableDataGrant => grant instanceof ImmutableDataGrant)
    .map((grant) => ({
      iri: grant.iri,
      data: {
        ...grant.data,
        hasInheritingGrant: grant.data.hasInheritingGrant?.map((child) => ({ iri: child.iri })),
      },
    })) as any

  return {
    accessGrantIri: accessGrant.iri,
    accessGrantData: {
      ...accessGrant.data,
      // @ts-ignore - dataGrants contains class instances, map to plain objects for serialization
      dataGrants: accessGrant.dataGrants.map((grant) => ({ iri: grant.iri })),
    },
    dataGrantsToStore,
  }
}

export interface StoreDataGrantInput {
  grantIri: string
  grantData: DataGrantData
}

export async function storeDataGrant(payload: StoreDataGrantInput): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.grantData.grantedBy)

  const grant = session.factory.immutable.dataGrant(payload.grantIri, payload.grantData)
  await grant.put()
}

export interface StoreAccessGrantInput {
  accessGrantIri: string
  accessGrantData: AccessGrantData
  dataGrantsToStore: Array<{ iri: string; data: DataGrantData }>
}

// TODO: check case when granted === false
export async function storeAccessGrant(payload: StoreAccessGrantInput): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.accessGrantData.grantedBy)

  const dataGrants = payload.dataGrantsToStore.map((grant) =>
    session.factory.immutable.dataGrant(grant.iri, grant.data)
  )

  const accessGrant = session.factory.immutable.accessGrant(payload.accessGrantIri, {
    ...payload.accessGrantData,
    dataGrants,
  })

  await accessGrant.put()
}

export interface SetAccessGrantInput {
  accessGrantIri: string
  grantedBy: string
  grantee: string
}

export async function setAccessGrant(payload: SetAccessGrantInput): Promise<void> {
  const manager = buildSessionManager()
  const session = await manager.getSession(payload.grantedBy)

  const agentRegistration = await session.registrySet.hasAgentRegistry.findRegistration(
    payload.grantee
  )

  if (!agentRegistration) {
    throw new Error('agent registration for the grantee does not exist')
  }

  await agentRegistration.setAccessGrant(payload.accessGrantIri)
}
