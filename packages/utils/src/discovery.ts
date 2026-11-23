import { documentValues, fetchJsonLd } from './jsonld.ts'
import {
  getAcl,
  getAgentRegistrationIri,
  getDescriptionResource,
  getLwsStorage,
  getStorageDescription,
  getUp,
} from './link-header.ts'
import { INTEROP, LWS, NOTIFY } from './namespaces.ts'
import type { WhatwgFetch } from './whatwg-fetch.ts'

export class RequestError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class AgentRegistrationDiscoveryError extends RequestError {
  constructor(response: Response) {
    super('Discovery: Agent Registration - request failed', response)
  }
}

export class DescriptionResourceDiscoveryError extends RequestError {
  constructor(response: Response) {
    super('Discovery: Resource Description - request failed', response)
  }
}

export class AccessResourceDiscoveryError extends RequestError {
  constructor(response: Response) {
    super('Discovery: Access Resource - request failed', response)
  }
}

export class StorageDescriptionDiscoveryError extends RequestError {
  constructor(response: Response) {
    super('Discovery: Storage Description - request failed', response)
  }
}

export async function discoverAuthorizationAgent(
  webId: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const doc = await fetchJsonLd(webId, fetch)
  return (await documentValues(doc, webId, INTEROP.hasAuthorizationAgent))[0]
}

type CidService = {
  type?: string | string[]
  serviceEndpoint?: string
}

/** CID media type for WebID/ClientID service documents. */
export const CID_ACCEPT = 'application/cid'

function serviceTypeMatches(type: unknown, expected: string): boolean {
  return type === expected || type === expected.split('#').pop()
}

async function fetchCidServices(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<Record<string, unknown>[]> {
  const response = await fetch(resourceIri, { headers: { Accept: CID_ACCEPT } })
  if (!response.ok) {
    return []
  }
  let doc: unknown
  try {
    doc = await response.json()
  } catch {
    return []
  }
  if (!doc || typeof doc !== 'object') {
    return []
  }
  const raw = (doc as { service?: unknown }).service
  const services = Array.isArray(raw) ? raw : raw ? [raw] : []
  return services.filter(
    (service): service is Record<string, unknown> => Boolean(service) && typeof service === 'object'
  )
}

/** Find a service endpoint in a WebID/ClientID CID document. */
export async function discoverCidService(
  resourceIri: string,
  fetch: WhatwgFetch,
  serviceType: string
): Promise<string | undefined> {
  const services = await fetchCidServices(resourceIri, fetch)
  for (const service of services as CidService[]) {
    const types = Array.isArray(service.type) ? service.type : [service.type]
    if (!types.some((type) => serviceTypeMatches(type, serviceType))) {
      continue
    }
    if (typeof service.serviceEndpoint === 'string') {
      return service.serviceEndpoint
    }
  }
  return undefined
}

export async function discoverAccessRequestService(
  webId: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  return discoverCidService(webId, fetch, LWS.AccessRequestService)
}

export async function discoverAccessGrantService(
  webId: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  return discoverCidService(webId, fetch, LWS.AccessGrantService)
}

export async function discoverAgentRegistration(
  authorizationAgentIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(authorizationAgentIri, { method: 'HEAD' })
  if (!response.ok) {
    throw new AgentRegistrationDiscoveryError(response)
  }
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) {
    return undefined
  }
  return getAgentRegistrationIri(linkHeader)
}

/**
 * `Accept` for auxiliary-resource discovery HEADs (`rel="acl"`,
 * `rel="describedby"`). A concrete type is required: a **storage root**
 * answers a wildcard-only (or absent) `Accept` with the public LWS storage
 * description (`application/lws+cid`, `wildcardDescribes`), and that response
 * carries no auxiliary links — only the root container representation does
 * (see `LwsStorageDescriptionHandler`). Registry sets and pods are storage
 * roots under flat LWS, so this affects every registry-set ACL lookup. The
 * low-quality wildcard keeps non-RDF resources discoverable.
 */
export const AUXILIARY_DISCOVERY_ACCEPT = 'text/turtle, application/ld+json;q=0.9, */*;q=0.1'

/**
 * The parent container of `resourceIri`, from the LWS `up` link relation on a
 * HEAD response (LWS, §Containment; the storage's stored `lws:partOf`).
 *
 * This is what flat LWS storage requires: the parent is NOT derivable from the
 * IRI path (members are allocated directly under the storage root as UUIDs).
 * Returns `undefined` when the response has no `up` link (a storage root, an
 * auxiliary resource, or a server that does not implement LWS §Containment) —
 * the caller decides what that means.
 *
 * The wildcard-`Accept` warning in TODO §Gotchas applies to storage ROOTS
 * (they answer with the public storage description, which has no `up` link);
 * a data resource answers its own metadata, and the low-quality wildcard
 * keeps non-RDF (blob) instances discoverable too.
 */
export async function upContainer(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, {
    method: 'HEAD',
    headers: { Accept: AUXILIARY_DISCOVERY_ACCEPT },
  })
  if (!response.ok) {
    return undefined
  }
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) {
    return undefined
  }
  const up = getUp(linkHeader)
  // the header is absolute in practice; resolve defensively so a relative
  // reference can never leak out as a bogus identifier
  return up ? new URL(up, resourceIri).toString() : undefined
}

export async function discoverDescriptionResource(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, {
    method: 'HEAD',
    headers: { Accept: AUXILIARY_DISCOVERY_ACCEPT },
  })
  if (!response.ok) {
    throw new DescriptionResourceDiscoveryError(response)
  }
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) {
    return undefined
  }
  return getDescriptionResource(linkHeader)
}

export async function discoverAccessResource(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, {
    method: 'HEAD',
    headers: { Accept: AUXILIARY_DISCOVERY_ACCEPT },
  })
  if (!response.ok) {
    throw new AccessResourceDiscoveryError(response)
  }
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) {
    return undefined
  }
  return getAcl(linkHeader)
}

export async function discoverStorageDescription(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, { method: 'HEAD' })
  if (!response.ok) {
    throw new StorageDescriptionDiscoveryError(response)
  }
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) {
    return undefined
  }
  return getStorageDescription(linkHeader)
}

/** Media type of the LWS storage description resource (LWS, §Discovery and Binding). */
export const LWS_STORAGE_DESCRIPTION_ACCEPT = 'application/lws+cid'

/** The service type of the storage root in the LWS storage description. */
const LWS_STORAGE_ROOT_TYPES = ['StorageRoot', 'https://www.w3.org/ns/lws#StorageRoot']

/**
 * Discovers the storage a resource belongs to through the LWS `storage` link
 * relation (LWS, §Discovery and Binding).
 */
export async function discoverLwsStorage(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const response = await fetch(resourceIri, { method: 'HEAD' })
  if (!response.ok) {
    return undefined
  }
  const linkHeader = response.headers.get('Link')
  if (!linkHeader) {
    return undefined
  }
  return getLwsStorage(linkHeader)
}

/** Fetches the LWS storage description (`application/lws+cid`). */
export async function fetchLwsStorageDescription(
  storage: string,
  fetch: WhatwgFetch
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(storage, {
    headers: { Accept: LWS_STORAGE_DESCRIPTION_ACCEPT },
  })
  if (!response.ok) {
    return undefined
  }
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes(LWS_STORAGE_DESCRIPTION_ACCEPT)) {
    return undefined
  }
  return (await response.json()) as Record<string, unknown>
}

/**
 * The storage types advertised by an LWS storage description. The SAI context
 * aliases `sai:DataStorage` and `sai:RegistryStorage` to the bare terms
 * `DataStorage` and `RegistryStorage`, so accept both the compact and the
 * expanded IRI.
 */
export function descriptionStorageTypes(description: Record<string, unknown>): string[] {
  const raw = description.type
  const types = Array.isArray(raw) ? raw : raw ? [raw] : []
  return types.filter((type): type is string => typeof type === 'string')
}

/** Whether the storage description advertises `type` (compact alias or expanded IRI). */
export function descriptionHasStorageType(
  description: Record<string, unknown>,
  type: string
): boolean {
  const compact = type.slice(Math.max(type.lastIndexOf('#'), type.lastIndexOf('/')) + 1)
  return descriptionStorageTypes(description).some(
    (candidate) => candidate === type || candidate === compact
  )
}

/** The exact `StorageRoot` service endpoint advertised by the description. */
export function storageRootFromDescription(
  description: Record<string, unknown>
): string | undefined {
  const rawServices = description.service
  const services = Array.isArray(rawServices) ? rawServices : rawServices ? [rawServices] : []
  for (const service of services) {
    if (!service || typeof service !== 'object') {
      continue
    }
    const record = service as Record<string, unknown>
    const types = Array.isArray(record.type) ? record.type : [record.type]
    if (!types.some((type) => LWS_STORAGE_ROOT_TYPES.includes(type as string))) {
      continue
    }
    if (typeof record.serviceEndpoint === 'string') {
      return record.serviceEndpoint
    }
  }
  return undefined
}

/**
 * Resolves the storage root of a resource through LWS discovery:
 * `rel="https://www.w3.org/ns/lws#storage"` → storage description → the
 * `StorageRoot` service entry. The endpoint is used verbatim — no URL
 * normalization or trailing-slash changes.
 */
export async function lwsStorageRoot(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string | undefined> {
  const storage = await discoverLwsStorage(resourceIri, fetch)
  if (!storage) {
    return undefined
  }
  const description = await fetchLwsStorageDescription(storage, fetch)
  if (!description) {
    return undefined
  }
  return storageRootFromDescription(description)
}

/**
 * The storage root of a resource, resolved through LWS discovery only
 * (`rel="storage"` → `StorageRoot` service). Callers that need a definite
 * answer (grant `hasStorage`, registry labels) handle `undefined` themselves —
 * the Solid `space:Storage` fallback is gone: every data and registry pod in
 * this deployment advertises the LWS storage link, and the auth server is an
 * authorization server, not a storage.
 */
export async function requireLwsStorageRoot(
  resourceIri: string,
  fetch: WhatwgFetch
): Promise<string> {
  const storage = await lwsStorageRoot(resourceIri, fetch)
  if (!storage) {
    throw new Error(`cannot discover the LWS storage root of ${resourceIri}`)
  }
  return storage
}

export async function discoverAuthorizationRedirectEndpoint(
  authorizationAgentIri: string,
  fetch: WhatwgFetch
): Promise<string> {
  const doc = await fetchJsonLd(authorizationAgentIri, fetch)
  return (
    await documentValues(doc, authorizationAgentIri, INTEROP.hasAuthorizationRedirectEndpoint)
  )[0]!
}

export async function discoverWebPushService(
  authorizationAgentIri: string,
  fetch: WhatwgFetch
): Promise<{ id: string; vapidPublicKey: string } | undefined> {
  const doc = await fetchJsonLd(authorizationAgentIri, fetch)
  const [id] = await documentValues(doc, authorizationAgentIri, INTEROP.pushService)
  const [vapidPublicKey] = await documentValues(doc, authorizationAgentIri, NOTIFY.vapidPublicKey)
  if (!id || !vapidPublicKey) {
    return
  }
  return { id, vapidPublicKey }
}
