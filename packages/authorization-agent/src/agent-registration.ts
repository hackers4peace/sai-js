import {
  type AgentRegistrationData,
  agentRegistrationAcrJsonLd,
  dataModelContext,
  getAccessGrantIris,
} from '@janeirodigital/interop-data-model'
import type { AgentAndClient } from '@janeirodigital/interop-data-model'
import {
  type WhatwgFetch,
  addStatement,
  applyPatch,
  deletePatch,
  discoverAccessResource,
  insertPatch,
  putJsonLd,
  removeStatement,
  withContext,
} from '@janeirodigital/interop-utils'

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────

export async function setAcr(
  data: AgentRegistrationData,
  fetch: WhatwgFetch,
  creator: AgentAndClient,
  peer: AgentAndClient
): Promise<void> {
  const acrLocation = await discoverAccessResource(data.id, fetch)
  if (!acrLocation) {
    throw new Error(`no access resource for ${data.id}`)
  }
  await putJsonLd(
    acrLocation,
    fetch,
    agentRegistrationAcrJsonLd({ id: data.id, owner: creator, peer })
  )
}

export async function addAccessGrant(
  data: AgentRegistrationData,
  fetch: WhatwgFetch,
  grantIri: string
): Promise<void> {
  await addStatement(
    data.id,
    fetch,
    withContext(dataModelContext, { id: data.id, hasDataGrant: grantIri })
  )
  data.hasDataGrant = [...(data.hasDataGrant ?? []), grantIri]
}

export async function removeAccessGrant(
  data: AgentRegistrationData,
  fetch: WhatwgFetch,
  grantIri: string
): Promise<void> {
  await removeStatement(
    data.id,
    fetch,
    withContext(dataModelContext, { id: data.id, hasDataGrant: grantIri })
  )
  data.hasDataGrant = (data.hasDataGrant ?? []).filter((iri) => iri !== grantIri)
}

export async function removeAllAccessGrants(
  data: AgentRegistrationData,
  fetch: WhatwgFetch
): Promise<void> {
  const iris = getAccessGrantIris(data)
  await Promise.all(iris.map((iri) => removeAccessGrant(data, fetch, iri)))
}

/**
 * Replace the registration's hasDataGrant links in a single PATCH: removes
 * the links to grants no longer in the set and adds the new ones, so the
 * registration emits exactly one Update notification. `grantIris` is the FULL
 * new set (may be []). No-op (no PATCH) when the set is unchanged.
 */
export async function replaceAccessGrants(
  data: AgentRegistrationData,
  fetch: WhatwgFetch,
  grantIris: string[]
): Promise<void> {
  const current = getAccessGrantIris(data)
  const currentSet = new Set(current)
  const targetSet = new Set(grantIris)
  const removed = currentSet.difference(targetSet)
  const added = targetSet.difference(currentSet)
  if (removed.size === 0 && added.size === 0) {
    return
  }

  const sparqlUpdate = [
    ...(removed.size
      ? [
          await deletePatch(
            withContext(dataModelContext, { id: data.id, hasDataGrant: [...removed] })
          ),
        ]
      : []),
    ...(added.size
      ? [
          await insertPatch(
            withContext(dataModelContext, { id: data.id, hasDataGrant: [...added] })
          ),
        ]
      : []),
  ].join(';')
  await applyPatch(data.id, fetch, sparqlUpdate)
  data.hasDataGrant = [...grantIris]
}
