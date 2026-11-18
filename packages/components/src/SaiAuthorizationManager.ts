import { LWS, ODRL } from '@janeirodigital/interop-utils'
import type { DatasetCore, Quad } from '@rdfjs/types'
import { NotFoundHttpError, arrayifyStream } from '@solid/community-server'
import type { IdentifierStrategy, PodStore, StorageLocationStrategy } from '@solid/community-server'
import type { AuthorizationManager } from '@solidlab/policy-engine'
import { type IBindings, SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { getLoggerFor } from 'global-logger-factory'

import type { PodEndpointStore } from './PodEndpointStore.js'
import { registryId } from './util/uriTemplates.js'

export class SaiAuthorizationManager implements AuthorizationManager {
  private fetcher: SparqlEndpointFetcher
  private readonly logger = getLoggerFor(this)

  public constructor(
    protected readonly identifierStrategy: IdentifierStrategy,
    protected readonly storageStrategy: StorageLocationStrategy,
    private readonly podStore: PodStore,
    private readonly endpointStore: PodEndpointStore
  ) {
    this.fetcher = new SparqlEndpointFetcher()
  }

  /**
   * Path-based parent of a **data** resource — the fallback for hierarchical
   * data pods when `lws:partOf` metadata is unavailable. Registry containment
   * is flat and metadata-only; registry members must never rely on URI paths.
   */
  public getParent(id: string): string | undefined {
    const identifier = { path: id }
    return this.identifierStrategy.isRootContainer(identifier)
      ? undefined
      : this.identifierStrategy.getParentContainer(identifier).path
  }

  public async getStorage(id: string): Promise<string> {
    const storage = await this.storageStrategy.getStorageIdentifier({ path: id })
    return storage.path
  }

  /**
   * With per-pod datasets the grants live in the storage owner's **registry
   * pod** dataset, not the data pod's. Resolve it from the pod's owner WebID;
   * returns `undefined` (no grants, deny) when the owner is unknown, and
   * propagates a store outage (fail-closed).
   */
  private async resolveRegistryEndpoint(storageUrl: string): Promise<string | undefined> {
    const pod = await this.podStore.findByBaseUrl(storageUrl)
    if (!pod) return undefined
    const owner = (await this.podStore.getOwners(pod.id))?.[0]?.webId
    if (!owner) return undefined
    const record = await this.endpointStore.findSparqlByPodUrl(registryId(owner))
    return record?.endpoint
  }

  public async getAuthorizationData(id: string): Promise<DatasetCore | Quad[] | undefined> {
    let storage: { path: string }
    try {
      storage = await this.storageStrategy.getStorageIdentifier({ path: id })
    } catch {
      // not under any pod — no grants, deny
      return undefined
    }
    const endpoint = await this.resolveRegistryEndpoint(storage.path)
    if (!endpoint) return undefined

    try {
      const bindingsStream = await this.fetcher.fetchBindings(
        endpoint,
        `
        SELECT DISTINCT ?g WHERE {
          GRAPH ?g {
            ?grant <${LWS.access}> ?policy .
            ?policy <${ODRL.permission}> ?permission .
            ?permission <${ODRL.target}> ?target .
            ?target <${LWS.storage}> <${storage.path}> .
          }
        }
      `
      )
      const results = await arrayifyStream<IBindings>(bindingsStream)
      const grants = results.map((b) => b.g.value)

      let data: Quad[] = []
      for (const grant of grants) {
        const grantsStream = await this.fetcher.fetchTriples(
          endpoint,
          `
            CONSTRUCT { ?s ?p ?o } WHERE {
              GRAPH <${grant}> { ?s ?p ?o }
            }
          `
        )
        const grantQuads = await arrayifyStream<Quad>(grantsStream)
        data = data.concat(grantQuads)
      }
      // AdminGrants carry `storage` too (the Read-only DataRegistry-scoped
      // ones) — they ride along in the same dataset. The storage exchange
      // policy consumes them by type/scope/policy assignee when it mints
      // `scope: admin`; the request-time engine never matches them.
      return data
    } catch (err) {
      if (NotFoundHttpError.isInstance(err)) {
        return
      }
      throw err
    }
  }
}
