import { MetadataWriter, addHeader } from '@solid/community-server'
import type { MetadataWriterInput } from '@solid/community-server'
import { DataFactory } from 'n3'

const ACCOUNT_COOKIE = DataFactory.namedNode('urn:npm:solid:community-server:http:accountCookie')
const ACCOUNT_COOKIE_EXPIRATION = DataFactory.namedNode(
  'urn:npm:solid:community-server:http:accountCookieExpiration'
)

/**
 * Writes the account cookie as `SameSite=None; Secure`.
 *
 * A unified deployment can serve the authorization UI from another site than
 * the auth service (`https://ui.auth` and `https://auth` in the Dagger stack).
 * The UI then reaches `/.sai/api` and the `.account` interaction API with
 * cross-site requests, which neither store nor send a `SameSite=Lax` cookie.
 * Every SAI deployment is HTTPS, so `Secure` is always valid.
 *
 * Replaces CSS's `CookieMetadataWriter`, which hardcodes `SameSite=Lax`.
 */
export class AccountCookieMetadataWriter extends MetadataWriter {
  public constructor(private readonly cookieName: string) {
    super()
  }

  public async handle({ response, metadata }: MetadataWriterInput): Promise<void> {
    const value = metadata.get(ACCOUNT_COOKIE)?.value
    if (!value) {
      return
    }
    const expiration = metadata.get(ACCOUNT_COOKIE_EXPIRATION)?.value
    const expires = typeof expiration === 'string' ? new Date(expiration) : undefined
    const attributes = ['Path=/', 'SameSite=None', 'Secure']
    if (expires) {
      attributes.push(`Expires=${expires.toUTCString()}`)
    }
    addHeader(
      response,
      'Set-Cookie',
      `${this.cookieName}=${encodeURIComponent(value)}; ${attributes.join('; ')}`
    )
  }
}
