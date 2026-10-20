import type { Readable } from 'node:stream'

import {
  NotFoundHttpError,
  NotImplementedHttpError,
  UnsupportedMediaTypeHttpError,
} from '@solid/community-server'
import type {
  DataAccessor,
  Guarded,
  Representation,
  RepresentationMetadata,
  ResourceIdentifier,
  StorageLocationStrategy,
} from '@solid/community-server'

import type { ObjectEndpointRecord, PodEndpointStore } from './PodEndpointStore.js'
import { S3DataAccessor } from './S3DataAccessor.js'

/**
 * Routes binary LDP reads/writes to the object (S3) bucket of the resource's
 * data pod (openwiki/architecture/storage-isolation.md).
 *
 * Mirrors {@link RoutedSparqlDataAccessor}: `StorageLocationStrategy` yields
 * the pod base URL, which is the `objectEndpoint` registry's key, so a single
 * `findObjectByPodUrl` resolves the pod's bucket and credentials. There is
 * **no shared/default bucket** — a non-pod identifier (no storage) is a 404
 * and a pod without an object record fails closed with a 500, so a storage
 * outage or a missing record can never silently widen the scope.
 *
 * Delegates to a cached {@link S3DataAccessor} per `(endpoint, bucket)`. The
 * S3 service endpoint is bucket-less; the delegate appends the bucket.
 */
export class RoutedS3DataAccessor implements DataAccessor {
  private readonly accessors = new Map<string, S3DataAccessor>()

  public constructor(
    private readonly storageStrategy: StorageLocationStrategy,
    private readonly endpointStore: PodEndpointStore,
    private readonly region: string
  ) {}

  private accessorFor(record: ObjectEndpointRecord): S3DataAccessor {
    const key = `${record.endpoint}/${record.bucket}`
    let accessor = this.accessors.get(key)
    if (!accessor) {
      accessor = new S3DataAccessor({
        endpoint: record.endpoint,
        bucket: record.bucket,
        accessKeyId: record.accessKeyId,
        secretAccessKey: record.secretAccessKey,
        region: this.region,
      })
      this.accessors.set(key, accessor)
    }
    return accessor
  }

  private async recordFor(identifier: ResourceIdentifier): Promise<ObjectEndpointRecord> {
    let podUrl: string
    try {
      podUrl = (await this.storageStrategy.getStorageIdentifier(identifier)).path
    } catch {
      // Not under any pod (e.g. the server root, or an ancestor ACL/ACR read
      // that walks up to it). This is not a storage misconfiguration — there
      // simply is no such resource: surface 404.
      throw new NotFoundHttpError()
    }
    const record = await this.endpointStore.findObjectByPodUrl(podUrl)
    if (!record) {
      throw new Error(`no object endpoint for pod ${podUrl}`)
    }
    return record
  }

  /**
   * Binary-only gate, independent of the endpoint. Mirrors
   * `S3DataAccessor.canHandle` without needing a resolved pod.
   */
  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.')
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    return this.accessorFor(await this.recordFor(identifier)).getData(identifier)
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata
  ): Promise<void> {
    return this.accessorFor(await this.recordFor(identifier)).writeDocument(
      identifier,
      data,
      metadata
    )
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    return this.accessorFor(await this.recordFor(identifier)).deleteResource(identifier)
  }

  // The object plane is binary-only — metadata and containers live in the
  // SPARQL plane (`HybridDataAccessor` routes them there and never calls these
  // on the binary accessor). Same contract as S3DataAccessor.
  public async getMetadata(): Promise<RepresentationMetadata> {
    throw new NotImplementedHttpError('RoutedS3DataAccessor does not support getMetadata')
  }

  public getChildren(): AsyncIterableIterator<RepresentationMetadata> {
    throw new NotImplementedHttpError('RoutedS3DataAccessor does not support getChildren')
  }

  public async writeContainer(): Promise<void> {
    throw new NotImplementedHttpError('RoutedS3DataAccessor does not support writeContainer')
  }

  public async writeMetadata(): Promise<void> {
    throw new NotImplementedHttpError('RoutedS3DataAccessor does not support writeMetadata')
  }
}
