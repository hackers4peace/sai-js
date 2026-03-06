import type { ImmutableDataGrant } from '@janeirodigital/interop-data-model'
import { proxyActivities, startChild } from '@temporalio/workflow'
import type * as activities from '../activities/grants.js'

const {
  findAffectedAuthorizations,
  generateGrants,
  storeDataGrant,
  createAcr,
  storeAccessGrant,
  setAccessGrant,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
})

async function storeGrantAndAcr(grant: ImmutableDataGrant) {
  await storeDataGrant({
    grantIri: grant.iri,
    grantData: grant.data,
  })
  await createAcr({
    grantIri: grant.iri,
    grantData: grant.data,
  })
}

export async function createGrantsForAuthorization(
  payload: activities.CreateGrantsInput
): Promise<void> {
  // 1. Generate and filter grants
  const { accessGrantIri, accessGrantData, dataGrantsToStore } = await generateGrants(payload)

  // 2. Store each NEW data grant
  const grantTasks = dataGrantsToStore.map(storeGrantAndAcr)

  await Promise.all(grantTasks)

  // 3. Store AccessGrant
  await storeAccessGrant({
    accessGrantIri,
    accessGrantData,
    dataGrantsToStore,
  })

  // 4. Link to grantee's registration
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
