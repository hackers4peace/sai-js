import {
  ACCESS_TOKEN_TYPE,
  ID_JAG_TOKEN_TYPE,
  createIdJagFetch,
  createLwsAuthFetch,
  requestIdJag,
} from '@elfpavlik/lws-auth'
import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import {
  SAI_ADMIN_IMPERSONATION_SCOPE,
  SAI_IMPERSONATE_PARAM,
  createLwsFetch,
  discoverAuthorizationAgent,
  discoverLwsAuthorizationServerMetadata,
} from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import type { JwkGenerator } from '@solid/community-server'

import { buildAccountLoginStorage } from './builders/accountLoginStorage.js'
import { CustomWebIdStore } from './CustomWebIdStore.js'
import { PodEndpointStore } from './PodEndpointStore.js'
import type { SparqlEndpointRecord } from './PodEndpointStore.js'
import { createSelfIssuedCredentialWithJwk } from './util/selfIssuedCredential.js'
import { agentId, registryId } from './util/uriTemplates.js'
import { isSaiUrl, isWithinBaseUrl, saiAudience } from './util/url.js'

/**
 * Shared lazy endpoint store for contexts without config injection (the worker
 * and the test harness `buildSessionManager()`). Built once so the many
 * `buildSessionManager()` call sites don't each open a Postgres pool.
 */
let sharedEndpointStorePromise: Promise<PodEndpointStore> | undefined

export function getSharedEndpointStore(): Promise<PodEndpointStore> {
  if (sharedEndpointStorePromise === undefined) {
    sharedEndpointStorePromise = (async () => {
      const storage = (await buildAccountLoginStorage()) as any
      const webIdStore = new CustomWebIdStore(storage)
      await webIdStore.handle()
      const store = new PodEndpointStore(storage, webIdStore)
      await store.handle()
      return store
    })()
  }
  return sharedEndpointStorePromise
}

export class SessionManager {
  private endpointStore?: PodEndpointStore
  /** Cached impersonation fetch per (admin, organization, peer storage). */
  private readonly impersonationFetches = new Map<string, Promise<WhatwgFetch>>()
  /** Cached storage-scoped fetch per (agent, storage). */
  private readonly storageFetches = new Map<string, Promise<WhatwgFetch>>()

  public constructor(
    private readonly baseUrl: string,
    private readonly jwkGenerator: JwkGenerator,
    private regOrigin: string,
    private readonly expiration: number,
    endpointStore?: PodEndpointStore
  ) {
    this.endpointStore = endpointStore
  }

  /**
   * The endpoint registry is injected by the CSS config on the auth server. In
   * the worker and the test harness `buildSessionManager()` constructs the
   * manager without one, so fall back to the shared lazy store (and the env-var
   * endpoint if even that is unavailable).
   */
  private async resolveEndpointStore(): Promise<PodEndpointStore | undefined> {
    if (this.endpointStore) {
      return this.endpointStore
    }
    // Worker/test: the lazy shared store is unavailable when postgres is not
    // configured — that is the only tolerated failure. A query against an
    // available store must surface instead of silently falling back.
    try {
      return await getSharedEndpointStore()
    } catch {
      return undefined
    }
  }

  private async buildCredential(
    webid: string
  ): Promise<Awaited<ReturnType<typeof createSelfIssuedCredentialWithJwk>>> {
    return createSelfIssuedCredentialWithJwk({
      issuer: this.baseUrl,
      subject: webid,
      clientId: agentId(webid),
      jwkGenerator: this.jwkGenerator,
      // `expiration` is in minutes, the token lifetime in seconds.
      lifetime: this.expiration * 60,
    })
  }

  /**
   * A fetch for one storage that presents the agent's own credential, minting
   * `scope: owner` (the owner) or `scope: admin` (a DataRegistry admin) at that
   * storage. Used for the org context's **own** pods: the admin's own token is
   * read-only there, unlike an in-process org session, which the storage AS
   * would treat as the owner (`scope: owner`, all modes).
   */
  public async storageFetch(webid: string, storage: string): Promise<WhatwgFetch> {
    const key = `${webid}\n${storage}`
    const cached = this.storageFetches.get(key)
    if (cached !== undefined) {
      return cached
    }
    const created = (async (): Promise<WhatwgFetch> => {
      const credential = await this.buildCredential(webid)
      return createLwsAuthFetch({ credential, storages: [storage] })
    })()
    this.storageFetches.set(key, created)
    created.catch(() => this.storageFetches.delete(key))
    return created
  }

  /**
   * Read-only admin impersonation of an organization for one peer storage
   * (org context). Both token hops happen here, server-side:
   *
   * 1. the admin's own UAS mints an identity-only ID-JAG for the organization's
   *    UAS, with the admin-impersonation `scope` and the peer storage as
   *    `resource`;
   * 2. the organization's UAS checks the admin grant, derives the
   *    organization's claim for that storage, narrows it to `read`, and issues
   *    an ID-JAG as the organization;
   * 3. the storage's authorization server trades that ID-JAG for an access
   *    token (through `createLwsFetch`, which caches it and retries a `401`).
   *
   * The admin is dropped at hop 2: neither the organization's ID-JAG nor the
   * access token names the admin, and neither reaches the caller's UI.
   */
  public async impersonationFetch(
    adminWebId: string,
    orgWebId: string,
    storage: string
  ): Promise<WhatwgFetch> {
    const key = `${adminWebId}\n${orgWebId}\n${storage}`
    const cached = this.impersonationFetches.get(key)
    if (cached !== undefined) {
      return cached
    }
    const created = (async (): Promise<WhatwgFetch> => {
      const credential = await this.buildCredential(adminWebId)
      const clientId = credential.clientId
      const organizationUas = await this.organizationUas(orgWebId)
      const ras = await discoverLwsAuthorizationServerMetadata(storage, fetch)

      // Hop 1: the admin's own UAS mints an identity-only ID-JAG for the
      // organization's UAS. No scope here — the request scope is only
      // meaningful at the organization's UAS (hop 2).
      const idJag = await requestIdJag({
        uas: this.baseUrl,
        audience: organizationUas,
        resource: storage,
        subjectToken: await credential.getSubjectToken(),
        subjectTokenType: ACCESS_TOKEN_TYPE,
        clientId,
        dpopKeyPair: credential.dpopKeyPair,
      })
      // Hop 2: the organization's UAS checks the admin grant, derives the
      // organization's claim for this storage and narrows it to `read`.
      const impersonated = await requestIdJag({
        uas: organizationUas,
        audience: ras.issuer,
        resource: storage,
        scope: SAI_ADMIN_IMPERSONATION_SCOPE,
        subjectToken: idJag,
        subjectTokenType: ID_JAG_TOKEN_TYPE,
        clientId,
        dpopKeyPair: credential.dpopKeyPair,
        extraParameters: { [SAI_IMPERSONATE_PARAM]: orgWebId },
      })

      return createLwsFetch({
        storages: [storage],
        subjectToken: () => Promise.resolve(impersonated),
      })
    })()
    this.impersonationFetches.set(key, created)
    created.catch(() => this.impersonationFetches.delete(key))
    return created
  }

  /** The organization's own UAS origin (its authorization agent's origin). */
  private async organizationUas(orgWebId: string): Promise<string> {
    const agent = await discoverAuthorizationAgent(orgWebId, fetch).catch(() => undefined)
    return agent ? `${new URL(agent).origin}/` : this.baseUrl
  }

  public async getSession(webid: string, registrySetId?: string): Promise<AuthorizationAgent> {
    const credential = await this.buildCredential(webid)

    // per-pod endpoint registry (openwiki/architecture/storage-isolation.md): the
    // owner's records from the internal account storage are the session's
    // endpoint allowlist; the registry pod URL is the registry-set IRI. There
    // is no shared/default endpoint — a missing registry record fails closed.
    const registryPodUrl = registrySetId ?? registryId(webid)
    const store = await this.resolveEndpointStore()
    const records: Array<SparqlEndpointRecord> = store ? await store.findSparqlByWebId(webid) : []
    const sparqlEndpoints = new Map<string, string>(
      records.map((record) => [record.podUrl, record.endpoint])
    )
    const endpoint = sparqlEndpoints.get(registryPodUrl)
    if (!endpoint) {
      throw new Error(`no registry-pod SPARQL endpoint for ${webid} (${registryPodUrl})`)
    }

    // `.sai` requests are authenticated with an ID-JAG (D34); data and
    // registry storages accept only ID-JAG subject tokens, so their requests go
    // through the two-step LWS chain: the self-issued DPoP-bound access token
    // becomes one ID-JAG per storage authorization server, and the storage
    // exchanges it for a bearer access token (C6). The worker is the owner's
    // own UAS, so a claimless data exchange can mint `scope: owner`; the
    // registry exchange is claimless and authorized by ACP.
    const authorizationFetch = createIdJagFetch({ credential, audience: saiAudience })
    const lwsFetch = createLwsAuthFetch({
      credential,
      storages: [...sparqlEndpoints.keys(), registryPodUrl],
    })
    const sessionFetch: WhatwgFetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return isSaiUrl(url) || isWithinBaseUrl(url, this.baseUrl)
        ? authorizationFetch(input, init)
        : lwsFetch(input, init)
    }

    return AuthorizationAgent.build(webid, agentId(webid), registryPodUrl, {
      fetch: sessionFetch,
      randomUUID: crypto.randomUUID.bind(crypto),
      sparqlEndpoint: endpoint,
      sparqlEndpoints,
    })
  }
}
