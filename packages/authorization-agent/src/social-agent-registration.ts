import {
  SocialAgentRegistration,
  type SocialAgentRegistrationData,
  type SocialAgentRegistryData,
  dataModelContext,
  getAdminGrantIris,
} from '@janeirodigital/interop-data-model'
const loadSocialAgentRegistration = loader(SocialAgentRegistration.fromJsonLd)

import {
  INTEROP,
  type WhatwgFetch,
  applyPatch,
  deletePatch,
  insertPatch,
  loader,
  createResource,
  withContext,
} from '@janeirodigital/interop-utils'

/**
 * Lazily load the peer's reciprocal registration — only consumers that need its
 * data (access grants) call this. The leaf read
 * (`loadSocialAgentRegistration`) no longer recurses into the reciprocal.
 */
export async function loadReciprocalRegistration(
  data: SocialAgentRegistrationData,
  fetch: WhatwgFetch
): Promise<SocialAgentRegistrationData | undefined> {
  if (!data.reciprocalRegistration) {
    return undefined
  }
  return loadSocialAgentRegistration(data.reciprocalRegistration, fetch)
}

export async function createSocialAgentRegistration(
  registry: SocialAgentRegistryData,
  data: SocialAgentRegistrationData,
  fetch: WhatwgFetch
): Promise<void> {
  const doc = withContext(dataModelContext, {
    ...data,
    type: [...new Set([...(data.type ?? []), INTEROP.SocialAgentRegistration])],
  })
  // The identifier strategy creates the flat container member (POST + Slug,
  // `lws:Container` link); container bodies are applied as a description patch.
  await createResource(registry.id, data.id, { fetch }, true, doc)
}

/**
 * Replace the registration's `hasAdminGrant` links to exactly `grantIris` in a
 * single PATCH (remove old + insert new) — exactly one Update notification on
 * the registration. `grantIris: []` unlinks (admin revoked). No-op when the
 * links already match (idempotent against re-delivery).
 */
export async function replaceAdminGrantLinks(
  data: SocialAgentRegistrationData,
  fetch: WhatwgFetch,
  grantIris: Array<string>
): Promise<void> {
  const current = getAdminGrantIris(data)
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
            withContext(dataModelContext, { id: data.id, hasAdminGrant: [...removed] })
          ),
        ]
      : []),
    ...(added.size
      ? [
          await insertPatch(
            withContext(dataModelContext, { id: data.id, hasAdminGrant: [...added] })
          ),
        ]
      : []),
  ].join(';')
  await applyPatch(data.id, fetch, sparqlUpdate)
  data.hasAdminGrant = [...grantIris]
}
