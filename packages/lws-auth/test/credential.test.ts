import { describe, expect, test } from 'vitest'

import type { SelfIssuedCredentialClaims } from '../src/credential.ts'
import { createSelfIssuedCredential } from '../src/credential.ts'
import { createDpopKeyPair, dpopThumbprint } from '../src/dpop.ts'
import { ACCESS_TOKEN_TYPE } from '../src/tokens.ts'

const ISSUER = 'https://auth/'
const SUBJECT = 'https://id/alice'
const CLIENT = 'https://data/test-client/public/id'

describe('createSelfIssuedCredential', () => {
  test('mints a DPoP-bound access token for the issuer by default', async () => {
    const dpopKeyPair = await createDpopKeyPair()
    const seen: Array<SelfIssuedCredentialClaims> = []
    const credential = createSelfIssuedCredential({
      issuer: ISSUER,
      subject: SUBJECT,
      clientId: CLIENT,
      dpopKeyPair,
      now: () => 1_700_000_000_000,
      lifetime: 120,
      sign: async (claims) => {
        seen.push(claims)
        return 'subject-token'
      },
    })

    await expect(credential.getSubjectToken()).resolves.toBe('subject-token')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      issuer: ISSUER,
      subject: SUBJECT,
      clientId: CLIENT,
      audience: ISSUER,
      iat: 1_700_000_000,
      exp: 1_700_000_120,
    })
    expect(seen[0].jti).toEqual(expect.any(String))
    expect(seen[0].jkt).toBe(await dpopThumbprint(dpopKeyPair.publicKey))

    expect(credential.issuer).toBe(ISSUER)
    expect(credential.subject).toBe(SUBJECT)
    expect(credential.clientId).toBe(CLIENT)
    expect(credential.dpopKeyPair).toBe(dpopKeyPair)
    expect(credential.subjectTokenType).toBe(ACCESS_TOKEN_TYPE)
  })

  test('uses an explicit audience and reuses the cached key thumbprint', async () => {
    const dpopKeyPair = await createDpopKeyPair()
    const seen: Array<SelfIssuedCredentialClaims> = []
    const credential = createSelfIssuedCredential({
      issuer: ISSUER,
      subject: SUBJECT,
      clientId: CLIENT,
      dpopKeyPair,
      lifetime: 60,
      sign: async (claims) => {
        seen.push(claims)
        return `token-${seen.length}`
      },
    })

    await credential.getSubjectToken('https://data/')
    await credential.getSubjectToken('https://registry/')

    expect(seen.map((claims) => claims.audience)).toEqual(['https://data/', 'https://registry/'])
  })
})
