import { ACCESS_TOKEN_TYPE, createLwsAuthFetch } from '@elfpavlik/lws-auth'
import type { LwsCredential } from '@elfpavlik/lws-auth'
import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import type { JwkGenerator } from '@solid/community-server'
import { generateKeyPair } from 'jose'
import type { GenerateKeyPairResult } from 'jose'

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

  private async buildSelfIssuedSession(
    webid: string
  ): Promise<{ oidc: SelfIssuedSession; dpopKeyPair: GenerateKeyPairResult }> {
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
    return { oidc, dpopKeyPair }
  }

  public async getSession(webid: string, registrySetId?: string): Promise<AuthorizationAgent> {
    const { oidc, dpopKeyPair } = await this.buildSelfIssuedSession(webid)

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

    // The `.sai` API of this server keeps the Solid-OIDC DPoP session; data and
    // registry storages accept only ID-JAG subject tokens, so their requests go
    // through the two-step LWS chain: the self-issued DPoP-bound access token
    // becomes one ID-JAG per storage authorization server, and the storage
    // exchanges it for a bearer access token (C6). The worker is the owner's
    // own UAS, so a claimless data exchange can mint `scope: owner`; the
    // registry exchange is claimless and authorized by ACP.
    const dpopFetch = oidc.authFetch.bind(oidc) as WhatwgFetch
    const credential: LwsCredential = {
      issuer: this.baseUrl,
      clientId: agentId(webid),
      // jose generates WebCrypto keys here; oauth4webapi needs the raw pair
      dpopKeyPair: dpopKeyPair as unknown as CryptoKeyPair,
      subjectTokenType: ACCESS_TOKEN_TYPE,
      getSubjectToken: () => oidc.generateSelfIssuedAccessToken(),
    }
    const lwsFetch = createLwsAuthFetch({
      credential,
      storages: [...sparqlEndpoints.keys(), registryPodUrl],
    })
    const sessionFetch: WhatwgFetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const authBase = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`
      return url.startsWith(authBase) ? dpopFetch(input, init) : lwsFetch(input, init)
    }

    return AuthorizationAgent.build(webid, agentId(webid), registryPodUrl, {
      fetch: sessionFetch,
      randomUUID: crypto.randomUUID.bind(crypto),
      sparqlEndpoint: endpoint,
      sparqlEndpoints,
    })
  }
}
