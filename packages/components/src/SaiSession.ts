import type { SelfIssuedCredential } from '@elfpavlik/lws-auth'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

import { isSaiUrl, isWithinBaseUrl } from './util/url.js'

/**
 * The server-side `.sai` session of an agent.
 *
 * The session has one self-issued, DPoP-bound credential. It is only presented
 * to the agent's own UAS, in the token exchange that mints an ID-JAG; every
 * `.sai` request itself carries that ID-JAG (or a storage access token for
 * data/registry requests). There is no DPoP proof on the `.sai` hop.
 */
export class SaiSession {
  public constructor(
    readonly credential: SelfIssuedCredential,
    private readonly authIdJagFetch: WhatwgFetch,
    private readonly storageFetch: WhatwgFetch
  ) {}

  get webid(): string {
    return this.credential.subject
  }

  get clientId(): string {
    return this.credential.clientId
  }

  get issuer(): string {
    return this.credential.issuer
  }

  get dpopKeyPair(): CryptoKeyPair {
    return this.credential.dpopKeyPair
  }

  /** The first-hop credential, minted for this UAS by default. */
  generateSelfIssuedAccessToken(audience = this.issuer): Promise<string> {
    return this.credential.getSubjectToken(audience)
  }

  /**
   * Routes `.sai` requests through the ID-JAG fetch (including `.sai` routes
   * of other UASs) and storage requests through the LWS access-token chain.
   */
  authFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return isSaiUrl(url) || isWithinBaseUrl(url, this.issuer)
      ? this.authIdJagFetch(url, init)
      : this.storageFetch(url, init)
  }
}
