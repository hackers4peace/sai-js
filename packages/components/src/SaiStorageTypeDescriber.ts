import { SAI_CONTEXT_URI } from '@janeirodigital/interop-utils'
import type { LwsStorageDescriberInput } from '@solid/community-server'
import { LwsStorageDescriber } from '@solid/community-server'

/**
 * Adds the SAI storage role to the LWS storage description:
 * `sai:DataStorage` on a data storage and `sai:RegistryStorage` on a registry.
 *
 * The description is public, so a UAS can discover whether a storage is a
 * claimless registry (ACP authorizes it) before deriving an ODRL claim. This
 * replaces the deployment-local `claimlessStorageOrigins` allowlist and keeps
 * federation open-world.
 *
 * The SAI context aliases the terms as bare `DataStorage`/`RegistryStorage`
 * values; the same context URI is added to the description so JSON-LD
 * consumers expand them correctly.
 */
export class SaiStorageTypeDescriber extends LwsStorageDescriber {
  public constructor(private readonly storageType: string) {
    super()
  }

  public async handle({ description }: LwsStorageDescriberInput): Promise<void> {
    const current = Array.isArray(description.type)
      ? description.type
      : description.type
        ? [description.type]
        : []
    if (!current.includes(this.storageType)) {
      description.type = [...current, this.storageType]
    }

    const contexts = Array.isArray(description['@context'])
      ? description['@context']
      : description['@context']
        ? [description['@context']]
        : []
    if (!contexts.includes(SAI_CONTEXT_URI)) {
      description['@context'] = [...contexts, SAI_CONTEXT_URI]
    }
  }
}
