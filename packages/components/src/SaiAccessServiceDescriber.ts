import { INTEROP, LWS, discoverAuthorizationAgent } from '@janeirodigital/interop-utils'
import type { WebIdStore } from '@solid/community-server'
import { LwsStorageDescriber } from '@solid/community-server'
import type { LwsStorageDescriberInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { PodEndpointStore } from './PodEndpointStore.js'

type LwsService = {
  type: string
  serviceEndpoint: string
  conformsTo: Array<string>
}

/**
 * Advertises the owner-scoped SAI access services in an LWS storage
 * description:
 *
 * - `AccessRequestService` → `/.sai/access-requests/<base64url(owner)>`
 * - `AccessGrantService`   → `/.sai/grants/<base64url(owner)>`
 *
 * The endpoint lives on the owner's authorization agent, so the describer
 * resolves the storage's account/owner WebID from the pod endpoint records and
 * the WebID store, then discovers the owner's authorization agent origin from
 * the WebID document. Storages without a resolvable owner are left unchanged.
 */
export class SaiAccessServiceDescriber extends LwsStorageDescriber {
  protected readonly logger = getLoggerFor(this)

  public constructor(
    private readonly endpointStore: PodEndpointStore,
    private readonly webIdStore: WebIdStore
  ) {
    super()
  }

  public async handle({ storage, description }: LwsStorageDescriberInput): Promise<void> {
    const endpoint = await this.endpointStore.findSparqlByPodUrl(storage.path)
    if (!endpoint) {
      return
    }
    const owner = (await this.webIdStore.findLinks(endpoint.accountId))[0]?.webId
    if (!owner) {
      return
    }

    let authorizationAgent: string | undefined
    try {
      authorizationAgent = await discoverAuthorizationAgent(owner, fetch)
    } catch (error) {
      this.logger.warn(
        `Could not discover the authorization agent for ${owner}: ${(error as Error).message}`
      )
      return
    }
    if (!authorizationAgent) {
      return
    }

    const origin = new URL(authorizationAgent).origin
    const segment = Buffer.from(owner).toString('base64url')
    const services: Array<LwsService> = [
      {
        type: 'AccessRequestService',
        serviceEndpoint: `${origin}/.sai/access-requests/${segment}`,
        // the request endpoint also accepts the plain LWS ODRL request shape
        // (w3c/lws-protocol#303); `interop:AccessProfile` is the SAI
        // sub-profile with the access-need extensions
        conformsTo: [LWS.AccessProfile, INTEROP.AccessProfile],
      },
      {
        type: 'AccessGrantService',
        serviceEndpoint: `${origin}/.sai/grants/${segment}`,
        conformsTo: [INTEROP.AccessProfile],
      },
    ]
    description.service.push(...services)
  }
}
