import type { DataGrantData, ImmutableDataGrant } from '@janeirodigital/interop-data-model'
import { proxyActivities, startChild } from '@temporalio/workflow'
import type * as activities from '../activities/grants.js'

const {
  findAffectedAuthorizations,
  generateGrants,
  storeDataGrant,
  requestDelegation,
  createAcr,
  storeAccessGrant,
  setAccessGrant,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
})

async function storeGrantAndAcr(iri: string, data: DataGrantData) {
  await storeDataGrant({
    grantIri: iri,
    grantData: data,
  })
  await createAcr({
    grantIri: iri,
    grantData: data,
  })
}

export async function storeGrant(payload: {
  iri: string
  data: DataGrantData
}): Promise<void> {
  return storeGrantAndAcr(payload.iri, payload.data)
}

export async function createGrantsForAuthorization(
  payload: activities.CreateGrantsInput
): Promise<void> {
  // Generate and filter grants
  const { accessGrantIri, accessGrantData, dataGrantsToStore } = await generateGrants(payload)

  // Store each NEW data grant
  const sourceGrants = dataGrantsToStore.filter(
    (grant) => grant.data.dataOwner === grant.data.grantedBy
  )
  const grantTasks = sourceGrants.map((grant) => storeGrantAndAcr(grant.iri, grant.data))
  await Promise.all(grantTasks)

  // Request issuance of delegated grants
  const delegatedGrants = dataGrantsToStore.filter(
    (grant) => grant.data.dataOwner !== grant.data.grantedBy
  )
  // TODO:
  const delegatedTasks = delegatedGrants.map((grant) =>
    requestDelegation({ grantData: grant.data })
  )
  const delegatedGrantsIds = await Promise.all(delegatedTasks)

  // Store AccessGrant
  await storeAccessGrant({
    accessGrantIri,
    accessGrantData,
    dataGrantsToStore: [
      ...sourceGrants,
      ...delegatedGrantsIds.map((id) => ({ iri: id, data: {} as DataGrantData })),
    ],
  })

  // Link to grantee's registration
  await setAccessGrant({
    accessGrantIri,
    grantedBy: accessGrantData.grantedBy,
    grantee: accessGrantData.grantee,
  })
}

export async function updateDelegatedGrants(
  payload: activities.FindAffectedAuthorizationsInput
): Promise<void> {
  const result = await findAffectedAuthorizations(payload)
  // TODO let resource owner's UAS issue the grants
  await Promise.all(
    result.map((payload) =>
      startChild(updateGrantsForAuthorization, {
        args: [payload],
        parentClosePolicy: 'ABANDON',
      })
    )
  )
}

export async function updateGrantsForAuthorization(
  payload: activities.UpdateGrantsInput
): Promise<void> {
  await createGrantsForAuthorization({
    webId: payload.webId,
    authorizationId: payload.authorizationId,
  })
}
