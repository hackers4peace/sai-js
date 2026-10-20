import type { Readable } from 'node:stream'

import {
  INTERNAL_QUADS,
  NotFoundHttpError,
  SparqlDataAccessor,
  UnsupportedMediaTypeHttpError,
} from '@solid/community-server'
import type {
  DataAccessor,
  Guarded,
  IdentifierStrategy,
  Representation,
  RepresentationMetadata,
  ResourceIdentifier,
  StorageLocationStrategy,
} from '@solid/community-server'

import type { PodEndpointStore } from './PodEndpointStore.js'

/**
 * Routes LDP reads/writes to the SPARQL dataset of the resource's pod
 * (openwiki/architecture/storage-isolation.md).
 *
 * `StorageLocationStrategy.getStorageIdentifier` yields the pod base URL for
 * both server shapes: a subdomain pod on the data server, the first container
 * on the path-based registry server. The pod URL is the endpoint registry's
 * key, so a single `findSparqlByPodUrl` resolves the dataset. There is **no
 * shared/default endpoint**: an identifier with no storage (e.g. the root
 * container) or no endpoint record fails closed, so a storage outage or a
 * missing record can never silently widen the scope.
 *
 * Delegates to a cached {@link SparqlDataAccessor} per endpoint.
 */
export class RoutedSparqlDataAccessor implements DataAccessor {
  private readonly accessors = new Map<string, SparqlDataAccessor>()

  public constructor(
    private readonly identifierStrategy: IdentifierStrategy,
    private readonly storageStrategy: StorageLocationStrategy,
    private readonly endpointStore: PodEndpointStore
  ) {}

  private accessorFor(endpoint: string): SparqlDataAccessor {
    let accessor = this.accessors.get(endpoint)
    if (!accessor) {
      accessor = new SparqlDataAccessor(endpoint, this.identifierStrategy)
      this.accessors.set(endpoint, accessor)
    }
    return accessor
  }

  private async endpointFor(identifier: ResourceIdentifier): Promise<string> {
    let podUrl: string
    try {
      podUrl = (await this.storageStrategy.getStorageIdentifier(identifier)).path
    } catch {
      // Not under any pod (e.g. the server root, or an ancestor ACL/ACR read
      // that walks up to it). This is not a storage misconfiguration, there
      // simply is no such resource: surface it as 404 so authorization treats
      // the root as having no ACL/ACR.
      throw new NotFoundHttpError()
    }
    const record = await this.endpointStore.findSparqlByPodUrl(podUrl)
    if (!record) {
      throw new Error(`no SPARQL endpoint for pod ${podUrl}`)
    }
    return record.endpoint
  }

  /**
   * Content-type gate, independent of the endpoint. Mirrors
   * `SparqlDataAccessor.canHandle` without needing a resolved pod.
   */
  public async canHandle(representation: Representation): Promise<void> {
    if (representation.binary || representation.metadata.contentType !== INTERNAL_QUADS) {
      throw new UnsupportedMediaTypeHttpError('Only Quad data is supported.')
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    return this.accessorFor(await this.endpointFor(identifier)).getData(identifier)
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    return this.accessorFor(await this.endpointFor(identifier)).getMetadata(identifier)
  }

  public async *getChildren(
    identifier: ResourceIdentifier
  ): AsyncIterableIterator<RepresentationMetadata> {
    yield* this.accessorFor(await this.endpointFor(identifier)).getChildren(identifier)
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata
  ): Promise<void> {
    return this.accessorFor(await this.endpointFor(identifier)).writeDocument(
      identifier,
      data,
      metadata
    )
  }

  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata
  ): Promise<void> {
    return this.accessorFor(await this.endpointFor(identifier)).writeContainer(identifier, metadata)
  }

  public async writeMetadata(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata
  ): Promise<void> {
    return this.accessorFor(await this.endpointFor(identifier)).writeMetadata(identifier, metadata)
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    return this.accessorFor(await this.endpointFor(identifier)).deleteResource(identifier)
  }
}
