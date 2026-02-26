// Types from @solid/community-server
import type {
  ChangeMap,
  Conditions,
  DataAccessorBasedStore,
  Patch,
  Representation,
  RepresentationPreferences,
  ResourceIdentifier,
  ResourceStore,
} from '@solid/community-server'

const RDF_CONTENT_TYPES = [
  'text/turtle',
  'application/ld+json',
  'application/n-triples',
  'application/n-quads',
]

export class HybridResourceStore {
  public constructor(
    private sparqlStore: DataAccessorBasedStore,
    private binaryStore: DataAccessorBasedStore
  ) {}
  private prefersRdf(preferences: RepresentationPreferences): boolean {
    const types = preferences.type
    if (!types) return false
    return Object.keys(types).some((type) => RDF_CONTENT_TYPES.some((rt) => type.includes(rt)))
  }
  private isRdfContentType(contentType: string | undefined): boolean {
    if (!contentType) return false
    return RDF_CONTENT_TYPES.some((rt) => contentType.includes(rt))
  }
  public async hasResource(identifier: ResourceIdentifier): Promise<boolean> {
    const [binaryHas, sparqlHas] = await Promise.all([
      this.binaryStore.hasResource(identifier).catch(() => false),
      this.sparqlStore.hasResource(identifier).catch(() => false),
    ])
    return binaryHas || sparqlHas
  }
  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions
  ): Promise<Representation> {
    if (this.prefersRdf(preferences)) {
      return this.sparqlStore.getRepresentation(identifier)
    }
    return this.binaryStore.getRepresentation(identifier)
  }
  public async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions
  ): Promise<ChangeMap> {
    if (this.isRdfContentType(representation.metadata.contentType)) {
      return this.sparqlStore.addResource(container, representation, conditions)
    }
    return this.binaryStore.addResource(container, representation, conditions)
  }
  public async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions
  ): Promise<ChangeMap> {
    if (this.isRdfContentType(representation.metadata.contentType)) {
      return this.sparqlStore.setRepresentation(identifier, representation, conditions)
    }
    return this.binaryStore.setRepresentation(identifier, representation, conditions)
  }
  public async deleteResource(
    identifier: ResourceIdentifier,
    conditions?: Conditions
  ): Promise<ChangeMap> {
    // Try binaryStore first (metadata is there), then sparqlStore
    try {
      if (await this.binaryStore.hasResource(identifier)) {
        return this.binaryStore.deleteResource(identifier, conditions)
      }
    } catch {
      // Fall through
    }
    return this.sparqlStore.deleteResource(identifier, conditions)
  }
  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions
  ): Promise<ChangeMap> {
    // For binary resources, route to binaryStore
    // For RDF resources, route to sparqlStore
    const binaryHas = await this.binaryStore.hasResource(identifier).catch(() => false)
    if (binaryHas) {
      return this.binaryStore.modifyResource(identifier, patch, conditions)
    }
    return this.sparqlStore.modifyResource(identifier, patch, conditions)
  }
}
