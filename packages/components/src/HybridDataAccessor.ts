import type { Readable } from 'node:stream'
import { BasicRepresentation } from '@solid/community-server'
import type {
  DataAccessor,
  FileDataAccessor,
  Guarded,
  Representation,
  RepresentationConverter,
  ResourceIdentifier,
  SparqlDataAccessor,
} from '@solid/community-server'
import {
  CONTENT_TYPE,
  INTERNAL_QUADS,
  NotFoundHttpError,
  RepresentationMetadata,
  arrayifyStream,
} from '@solid/community-server'
import type { Quad } from 'n3'
import { DataFactory as DF } from 'n3'
export class HybridDataAccessor implements DataAccessor {
  public constructor(
    private binaryAccessor: FileDataAccessor,
    private sparqlAccessor: SparqlDataAccessor,
    private converter: RepresentationConverter
  ) {}

  public async canHandle(representation: Representation): Promise<void> {
    // can handle everything since it falls back to binaryAccessor
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const metadata = await this.getMetadata(identifier)
    if (metadata.contentType === INTERNAL_QUADS) {
      return this.sparqlAccessor.getData(identifier)
    }
    return this.binaryAccessor.getData(identifier)
  }
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    return this.sparqlAccessor.getMetadata(identifier)
  }
  public getChildren(
    identifier: ResourceIdentifier
  ): AsyncIterableIterator<RepresentationMetadata> {
    return this.sparqlAccessor.getChildren(identifier)
  }
  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata
  ): Promise<void> {
    if (metadata.contentType === INTERNAL_QUADS) {
      await this.sparqlAccessor.writeDocument(identifier, data, metadata)
      return
    }
    try {
      const converted = await this.converter.handle({
        representation: new BasicRepresentation(data, metadata),
        identifier,
        preferences: { type: { [INTERNAL_QUADS]: 1 } },
      })
      if (converted.metadata.contentType === INTERNAL_QUADS) {
        await this.sparqlAccessor.writeDocument(identifier, converted.data, converted.metadata)
        return
      }
      throw new Error('Conversion did not result in internal/quads')
    } catch {
      // pass only contentType to binaryAccessor (for file extension)
      const fileMetadata = new RepresentationMetadata({ [CONTENT_TYPE]: metadata.contentType })
      await this.binaryAccessor.writeDocument(identifier, data, fileMetadata)
      await this.sparqlAccessor.writeMetadata(identifier, metadata)
    }
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
    // If content-type is internal/quads, preserve the original content-type from the main resource
    if (metadata.contentType === INTERNAL_QUADS) {
      try {
        const originalMetadata = await this.getMetadata(identifier)
        if (originalMetadata.contentType) {
          metadata.contentType = originalMetadata.contentType
        }
      } catch {
        // Ignore - proceed with internal/quads
      }
    }
    await this.sparqlAccessor.writeMetadata(identifier, metadata)
  }
  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    try {
      await this.binaryAccessor.deleteResource(identifier)
    } catch {
      // Ignore if not found in binary store
    }
    try {
      await this.sparqlAccessor.deleteResource(identifier)
    } catch {
      // Ignore if not found in sparql store
    }
  }
}
