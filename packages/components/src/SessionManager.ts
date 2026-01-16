import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { JwkGenerator } from '@solid/community-server'
import { generateKeyPair } from 'jose'
import { SelfIssuedSession } from './SelfIssuedSession.js'
import { agentId } from './util/uriTemplates.js'

export class SessionManager {
  public constructor(
    private readonly baseUrl: string,
    private readonly jwkGenerator: JwkGenerator,
    private readonly expiration: number
  ) {}

  public async getSession(webid: string): Promise<AuthorizationAgent> {
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

    return AuthorizationAgent.build(webid, agentId(webid), {
      fetch: oidc.authFetch.bind(oidc),
      randomUUID: crypto.randomUUID.bind(crypto),
    })
  }
}
