import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { JwkGenerator } from '@solid/community-server'
import { generateKeyPair } from 'jose'

import { buildAccountLoginStorage } from './builders/accountLoginStorage.js'
import { CustomWebIdStore } from './CustomWebIdStore.js'
import { PodEndpointStore } from './PodEndpointStore.js'
import type { SparqlEndpointRecord } from './PodEndpointStore.js'
import { SelfIssuedSession } from './SelfIssuedSession.js'
import { agentId, registryId } from './util/uriTemplates.js'

/**
 * Shared lazy endpoint store for contexts without config injection (the worker
 * and the test harness `buildSessionManager()`). Built once so the many
 * `buildSessionManager()` call sites don't each open a Postgres pool.
 */
let sharedEndpointStorePromise: Promise<PodEndpointStore> | undefined

export function getSharedEndpointStore(): Promise<PodEndpointStore> {
  if (!sharedEndpointStorePromise) {
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
    return getSharedEndpointStore().catch(() => undefined)
  }

  public async getSession(webid: string, registrySetId?: string): Promise<AuthorizationAgent> {
    const privateKey = await this.jwkGenerator.getPrivateKey()
    const publicKey = await this.jwkGenerator.getPublicKey()

    const dpopKeyPair = await generateKeyPair('ES256')

    const oidc = new SelfIssuedSession({
      webid,
      clientId: agentId(webid),
      issuer: this.baseUrl,
      expiresIn: this.expiration * 60 * 1000,
      privateKey,
      publicKey,
      dpopKeyPair,
    })
    await oidc.login()

    // per-pod endpoint registry (openwiki/architecture/storage-isolation.md): the
    // owner's records from the internal account storage are the session's
    // endpoint allowlist; the registry pod URL is the registry-set IRI. There
    // is no shared/default endpoint — a missing registry record fails closed.
    const registryPodUrl = registrySetId ?? registryId(webid)
    const store = await this.resolveEndpointStore()
    const records: SparqlEndpointRecord[] = store ? await store.findSparqlByWebId(webid) : []
    const sparqlEndpoints = new Map<string, string>(
      records.map((record) => [record.podUrl, record.endpoint])
    )
    const endpoint = sparqlEndpoints.get(registryPodUrl)
    if (!endpoint) {
      throw new Error(`no registry-pod SPARQL endpoint for ${webid} (${registryPodUrl})`)
    }

    return AuthorizationAgent.build(webid, agentId(webid), registryPodUrl, {
      fetch: oidc.authFetch.bind(oidc),
      randomUUID: crypto.randomUUID.bind(crypto),
      sparqlEndpoint: endpoint,
      sparqlEndpoints,
    })
  }
}
