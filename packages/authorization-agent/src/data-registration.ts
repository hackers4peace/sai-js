import { dataModelContext } from '@janeirodigital/interop-data-model'
import type { DataRegistrationData } from '@janeirodigital/interop-data-model'
import { createResource, withContext } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

// ──────────────────────────
// Write path: DataRegistrationData → container (container.create)
// ──────────────────────────

export async function createDataRegistration(
  data: DataRegistrationData,
  fetch: WhatwgFetch
): Promise<void> {
  if (!data.partOf) {
    throw new Error(`data registration ${data.id} has no containing data registry (partOf)`)
  }
  // The identifier strategy creates the container at its pre-minted id: POST
  // to the data registry with the id's UUID as Slug, then patch the new
  // container's description resource.
  await createResource(data.partOf, data.id, { fetch }, true, withContext(dataModelContext, data))
}
