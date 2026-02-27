import { Readable } from 'node:stream'
import type { ReadableStream as ReadableStreamNode } from 'node:stream/web'
import type {
  DataAccessor,
  Guarded,
  Representation,
  RepresentationMetadata,
  ResourceIdentifier,
} from '@solid/community-server'
import {
  NotFoundHttpError,
  NotImplementedHttpError,
  UnsupportedMediaTypeHttpError,
  guardStream,
} from '@solid/community-server'
import { S3mini } from 's3mini'

export interface S3DataAccessorArgs {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}
export class S3DataAccessor implements DataAccessor {
  private readonly s3: S3mini
  public constructor(args: S3DataAccessorArgs) {
    this.s3 = new S3mini({
      endpoint: args.endpoint,
      accessKeyId: args.accessKeyId,
      secretAccessKey: args.secretAccessKey,
      region: args.region,
    })
  }

  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.')
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const response = await this.s3.getObjectResponse(identifier.path)
    if (!response || !response.body) {
      throw new NotFoundHttpError()
    }
    return guardStream(Readable.fromWeb(response.body as ReadableStreamNode))
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata
  ): Promise<void> {
    await this.s3.putAnyObject(
      identifier.path,
      Readable.toWeb(data) as ReadableStream,
      metadata.contentType
    )
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    await this.s3.deleteObject(identifier.path)
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    throw new NotImplementedHttpError('S3DataAccessor does not support getMetadata')
  }
  public getChildren(
    identifier: ResourceIdentifier
  ): AsyncIterableIterator<RepresentationMetadata> {
    throw new NotImplementedHttpError('S3DataAccessor does not support getChildren')
  }
  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata
  ): Promise<void> {
    throw new NotImplementedHttpError('S3DataAccessor does not support writeContainer')
  }
  public async writeMetadata(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata
  ): Promise<void> {
    throw new NotImplementedHttpError('S3DataAccessor does not support writeMetadata')
  }
}
