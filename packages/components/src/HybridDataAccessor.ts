import type { Readable } from 'node:stream'
import type { Quad } from '@rdfjs/types'
import type {
  DataAccessor,
  FileDataAccessor,
  Guarded,
  Representation,
  ResourceIdentifier,
  SparqlDataAccessor,
} from '@solid/community-server'
import {
  CONTENT_TYPE,
  INTERNAL_QUADS,
  NotFoundHttpError,
  RepresentationMetadata,
  UnsupportedMediaTypeHttpError,
  arrayifyStream,
} from '@solid/community-server'
import { DataFactory as DF } from 'n3'

export class HybridDataAccessor implements DataAccessor {
  public constructor(
    private binaryAccessor: FileDataAccessor,
    private sparqlAccessor: SparqlDataAccessor
  ) {}
  public async canHandle(representation: Representation): Promise<void> {
    if (representation.binary) {
      return this.binaryAccessor.canHandle(representation)
    }
    throw new UnsupportedMediaTypeHttpError('Only binary data is supported.')
  }
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    return this.binaryAccessor.getData(identifier)
  }
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    // @ts-ignore - accessing private method
    const name = this.sparqlAccessor.getMetadataNode(DF.namedNode(identifier.path))
    // @ts-ignore - accessing private method
    const query = this.sparqlAccessor.sparqlConstruct(name)
    // @ts-ignore - accessing private method
    const stream = await this.sparqlAccessor.sendSparqlConstruct(query)
    const quads: Quad[] = await arrayifyStream(stream)
    if (quads.length === 0) {
      throw new NotFoundHttpError()
    }
    const metadata = new RepresentationMetadata(identifier).addQuads(quads)
    // DON'T override content-type - preserve what's in SPARQL
    return metadata
  }
  public getChildren(
    identifier: ResourceIdentifier
  ): AsyncIterableIterator<RepresentationMetadata> {
    // @ts-ignore - accessing private method
    return this.sparqlAccessor.getChildren(identifier)
  }
  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata
  ): Promise<void> {
    // Write binary to binaryAccessor (minimal metadata - just content-type for extension)
    const fileMetadata = new RepresentationMetadata({ [CONTENT_TYPE]: metadata.contentType })
    await this.binaryAccessor.writeDocument(identifier, data, fileMetadata)

    // Write full metadata to SPARQL
    await this.sparqlAccessor.writeMetadata(identifier, metadata)
  }
  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata
  ): Promise<void> {
    await this.sparqlAccessor.writeContainer(identifier, metadata)
  }

  public async writeMetadata(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata
  ): Promise<void> {
    // If incoming content-type is internal/quads, preserve the original content-type
    if (metadata.contentType === INTERNAL_QUADS) {
      // Get original metadata from SPARQL
      const original = await this.getMetadata(identifier)
      if (original.contentType) {
        metadata.contentType = original.contentType
      }
    }

    await this.sparqlAccessor.writeMetadata(identifier, metadata)
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    // Delete from both stores
    await this.sparqlAccessor.deleteResource(identifier)
    await this.binaryAccessor.deleteResource(identifier)
  }
}
