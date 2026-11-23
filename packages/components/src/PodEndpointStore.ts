import {
  ACCOUNT_TYPE,
  Initializer,
  InternalServerError,
  createErrorMessage,
} from '@solid/community-server'
import type { AccountLoginStorage } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { CustomWebIdStore } from './CustomWebIdStore.js'

/** Internal SPARQL endpoint of a pod (every pod has one). */
export const SPARQL_ENDPOINT_STORAGE_TYPE = 'sparqlEndpoint'
export const SPARQL_ENDPOINT_STORAGE_DESCRIPTION = {
  accountId: `id:${ACCOUNT_TYPE}`,
  podUrl: 'string',
  endpoint: 'string',
} as const

/** Object (S3-compatible) endpoint of a **data** pod. */
export const OBJECT_ENDPOINT_STORAGE_TYPE = 'objectEndpoint'
export const OBJECT_ENDPOINT_STORAGE_DESCRIPTION = {
  accountId: `id:${ACCOUNT_TYPE}`,
  podUrl: 'string',
  endpoint: 'string',
  bucket: 'string',
  accessKeyId: 'string',
  secretAccessKey: 'string',
} as const

export interface SparqlEndpointRecord {
  id: string
  /** account that created the pod — the indirect link to the owner WebIDs */
  accountId: string
  /**
   * Base URL of the pod whose dataset the endpoint serves. A registry pod's
   * pod URL is its registry-set IRI (`https://<regOrigin>/<handle>/`); a data
   * pod's is its storage base URL. `registryId(webId)` derives the registry one.
   */
  podUrl: string
  /** internal SPARQL endpoint for the pod's dataset */
  endpoint: string
}

export interface ObjectEndpointRecord {
  id: string
  accountId: string
  /** base URL of the data pod the object storage serves */
  podUrl: string
  /** S3-compatible service endpoint (bucket-less) */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Typed registry of the internal storage endpoints of every pod, held in an
 * {@link AccountLoginStorage}. Two endpoint kinds share the store:
 *
 * - **SPARQL** — one per pod (registry pods and data pods);
 * - **object (S3)** — data pods only.
 *
 * Endpoints are associated **directly with the pod** (`podUrl`) and only
 * indirectly with the user: the record carries the owning `accountId`, and the
 * owner WebIDs are reached through the account / the pod's owner records.
 * `findByWebId` finders resolve the account first (the reverse `webIdLink` lookup).
 *
 * Needs to be initialized before it can be used.
 */
export class PodEndpointStore extends Initializer {
  private readonly logger = getLoggerFor(this)

  private readonly storage: AccountLoginStorage<{
    [SPARQL_ENDPOINT_STORAGE_TYPE]: typeof SPARQL_ENDPOINT_STORAGE_DESCRIPTION
    [OBJECT_ENDPOINT_STORAGE_TYPE]: typeof OBJECT_ENDPOINT_STORAGE_DESCRIPTION
  }>
  private readonly webIdStore?: CustomWebIdStore
  private initialized = false

  // Wrong typings to prevent Components.js typing issues
  public constructor(
    storage: AccountLoginStorage<Record<string, never>>,
    webIdStore?: CustomWebIdStore
  ) {
    super()
    this.storage = storage as unknown as typeof this.storage
    this.webIdStore = webIdStore
  }

  // Initialize the type definitions
  public async handle(): Promise<void> {
    if (this.initialized) {
      return
    }
    try {
      await this.storage.defineType(
        SPARQL_ENDPOINT_STORAGE_TYPE,
        SPARQL_ENDPOINT_STORAGE_DESCRIPTION,
        false
      )
      await this.storage.createIndex(SPARQL_ENDPOINT_STORAGE_TYPE, 'podUrl')
      await this.storage.createIndex(SPARQL_ENDPOINT_STORAGE_TYPE, 'accountId')
      await this.storage.defineType(
        OBJECT_ENDPOINT_STORAGE_TYPE,
        OBJECT_ENDPOINT_STORAGE_DESCRIPTION,
        false
      )
      await this.storage.createIndex(OBJECT_ENDPOINT_STORAGE_TYPE, 'podUrl')
      await this.storage.createIndex(OBJECT_ENDPOINT_STORAGE_TYPE, 'accountId')
      this.initialized = true
    } catch (cause: unknown) {
      throw new InternalServerError(
        `Error defining pod endpoints in storage: ${createErrorMessage(cause)}`,
        { cause }
      )
    }
  }

  // ──────────────────────────
  // SPARQL endpoints
  // ──────────────────────────

  public async createSparql(record: Omit<SparqlEndpointRecord, 'id'>): Promise<void> {
    await this.storage.create(SPARQL_ENDPOINT_STORAGE_TYPE, { ...record })
    this.logger.debug(`Added SPARQL endpoint ${record.endpoint} for pod ${record.podUrl}`)
  }

  public async findSparqlByPodUrl(podUrl: string): Promise<SparqlEndpointRecord | undefined> {
    const records = await this.storage.find(SPARQL_ENDPOINT_STORAGE_TYPE, { podUrl })
    return (records as unknown as SparqlEndpointRecord[])[0]
  }

  public async findSparqlByAccountId(accountId: string): Promise<SparqlEndpointRecord[]> {
    const records = await this.storage.find(SPARQL_ENDPOINT_STORAGE_TYPE, { accountId })
    return records as unknown as SparqlEndpointRecord[]
  }

  public async findSparqlByWebId(webId: string): Promise<SparqlEndpointRecord[]> {
    const accountId = await this.resolveAccount(webId)
    return accountId ? this.findSparqlByAccountId(accountId) : []
  }

  /** The record whose `podUrl` is the longest prefix of `iri`. */
  public async findSparqlByIri(iri: string): Promise<SparqlEndpointRecord | undefined> {
    return this.findByIri<SparqlEndpointRecord>(SPARQL_ENDPOINT_STORAGE_TYPE, iri)
  }

  public async deleteSparql(id: string): Promise<void> {
    this.logger.debug(`Deleting SPARQL endpoint record ${id}`)
    return this.storage.delete(SPARQL_ENDPOINT_STORAGE_TYPE, id)
  }

  // ──────────────────────────
  // Object (S3) endpoints
  // ──────────────────────────

  public async createObject(record: Omit<ObjectEndpointRecord, 'id'>): Promise<void> {
    await this.storage.create(OBJECT_ENDPOINT_STORAGE_TYPE, { ...record })
    this.logger.debug(`Added object endpoint bucket ${record.bucket} for pod ${record.podUrl}`)
  }

  public async findObjectByPodUrl(podUrl: string): Promise<ObjectEndpointRecord | undefined> {
    const records = await this.storage.find(OBJECT_ENDPOINT_STORAGE_TYPE, { podUrl })
    return (records as unknown as ObjectEndpointRecord[])[0]
  }

  public async findObjectByAccountId(accountId: string): Promise<ObjectEndpointRecord[]> {
    const records = await this.storage.find(OBJECT_ENDPOINT_STORAGE_TYPE, { accountId })
    return records as unknown as ObjectEndpointRecord[]
  }

  public async findObjectByWebId(webId: string): Promise<ObjectEndpointRecord[]> {
    const accountId = await this.resolveAccount(webId)
    return accountId ? this.findObjectByAccountId(accountId) : []
  }

  /** The record whose `podUrl` is the longest prefix of `iri`. */
  public async findObjectByIri(iri: string): Promise<ObjectEndpointRecord | undefined> {
    return this.findByIri<ObjectEndpointRecord>(OBJECT_ENDPOINT_STORAGE_TYPE, iri)
  }

  public async deleteObject(id: string): Promise<void> {
    this.logger.debug(`Deleting object endpoint record ${id}`)
    return this.storage.delete(OBJECT_ENDPOINT_STORAGE_TYPE, id)
  }

  // ──────────────────────────
  // Shared helpers
  // ──────────────────────────

  /**
   * The record of `type` whose `podUrl` is the longest prefix of `iri` —
   * resolves a registry resource (`https://registry/<owner>/grant/<id>`) or a
   * data resource to its pod. The registry currently scans all records; a
   * deterministic derivation of the pod URL from the IRI (the registry pod is
   * `${regOrigin}/${handle}/`) is the intended replacement.
   */
  private async findByIri<T extends { podUrl: string }>(
    type: typeof SPARQL_ENDPOINT_STORAGE_TYPE | typeof OBJECT_ENDPOINT_STORAGE_TYPE,
    iri: string
  ): Promise<T | undefined> {
    if (!iri) {
      return undefined
    }
    let best: T | undefined
    for await (const entry of this.storage.entries(type)) {
      const record = entry as unknown as T
      if (
        (iri === record.podUrl || iri.startsWith(record.podUrl)) &&
        (!best || record.podUrl.length > best.podUrl.length)
      ) {
        best = record
      }
    }
    return best
  }

  private async resolveAccount(webId: string): Promise<string | undefined> {
    if (!this.webIdStore) {
      throw new InternalServerError(
        'PodEndpointStore has no WebID store; resolving endpoints by WebID is not available'
      )
    }
    return this.webIdStore.findAccount(webId)
  }
}
