import type { FinalAccessGrantData, FinalDataGrantData } from '@janeirodigital/interop-data-model'
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

async function storeGrantAndAcr(grant: FinalDataGrantData) {
  await storeDataGrant(grant)
  await createAcr(grant)
}

export async function storeGrant(payload: FinalDataGrantData[]): Promise<void> {
  await Promise.all(payload.map((grant) => storeGrantAndAcr(grant)))
}

export async function createGrantsForAuthorization(
  payload: activities.CreateGrantsInput
): Promise<void> {
  const accessGrantData = await generateGrants(payload)

  await Promise.all(accessGrantData.sourceGrants.map((grant) => storeGrantAndAcr(grant)))

  const delegatedGrantIds = await Promise.all(
    // if grant has inheriting it delegation will return a flat array with all the ids
    accessGrantData.delegatedGrants.map((grant) => requestDelegation({ grantData: grant }))
  )

  // TODO: use ids only for dataGrants at this point
  const finalAccessGrantData: FinalAccessGrantData = {
    ...accessGrantData,
    dataGrants: [...accessGrantData.sourceGrants.map((g) => g.id), ...delegatedGrantIds.flat()],
  }

  await storeAccessGrant(finalAccessGrantData)

  await setAccessGrant(finalAccessGrantData)
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
