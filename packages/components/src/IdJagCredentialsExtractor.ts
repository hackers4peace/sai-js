import type { Credentials, HttpRequest, SubjectTokenVerifier } from '@solid/community-server'
import {
  CredentialsExtractor as CredentialsExtractorBase,
  NotImplementedHttpError,
  matchesAuthorizationScheme,
} from '@solid/community-server'

import { ID_JAG_TOKEN_TYPE } from './IdJagIssuer.js'

/**
 * Extracts the agent's credentials from a `.sai` request authenticated with an
 * ID-JAG.
 *
 * The ID-JAG travels as a plain Bearer token: DPoP is only used at the first
 * exchange that mints it, not on `.sai` requests. The audience is checked by
 * the verifier against the auth service's base URL prefix (one-time interaction
 * URLs and target UAS base URLs), while the request itself never has to match
 * the exact URL.
 *
 * A request without a Bearer token is left to the `PublicCredentialsExtractor`
 * fallback, so anonymous agent discovery keeps working.
 */
export class IdJagCredentialsExtractor extends CredentialsExtractorBase {
  public constructor(
    private readonly verifier: SubjectTokenVerifier,
    private readonly baseUrl: string
  ) {
    super()
  }

  public async canHandle({ headers }: HttpRequest): Promise<void> {
    if (!matchesAuthorizationScheme('Bearer', headers.authorization)) {
      throw new NotImplementedHttpError('No Bearer ID-JAG specified.')
    }
  }

  public async handle(request: HttpRequest): Promise<Credentials> {
    const token = request.headers.authorization!.replace(/^Bearer\s+/iu, '').trim()
    const verified = await this.verifier.handleSafe({
      token,
      tokenType: ID_JAG_TOKEN_TYPE,
      audience: this.baseUrl,
    })
    return {
      agent: { webId: verified.subject },
      client: { clientId: verified.client },
      issuer: { url: verified.issuer },
      ...(verified.access === undefined
        ? {}
        : {
            access: verified.access,
            accessContext: verified.accessContext,
          }),
    }
  }
}
