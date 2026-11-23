import { dpopThumbprint, createDpopKeyPair } from '@elfpavlik/lws-auth'
import type { JwkGenerator } from '@solid/community-server'
import {
  BadRequestHttpError,
  NotImplementedHttpError,
  TOKEN_TYPE_ACCESS_TOKEN,
} from '@solid/community-server'
import type { JWK } from 'jose'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { GenerateKeyPairResult } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'

import { SaiSelfIssuedAccessTokenVerifier } from '../src/SaiSelfIssuedAccessTokenVerifier.js'
import { createSelfIssuedCredentialWithJwk } from '../src/util/selfIssuedCredential.js'

const ISSUER = 'https://auth/'
const SUBJECT = 'https://id/alice'
const CLIENT = 'https://data/test-client/public/id'
const AT_JWT = 'at+jwt'

let keys: GenerateKeyPairResult
let publicJwk: JWK
let privateJwk: JWK
let dpopKeyPair: CryptoKeyPair
let jkt: string

function verifier(): SaiSelfIssuedAccessTokenVerifier {
  const generator: JwkGenerator = {
    alg: 'ES256',
    getPublicKey: async () => publicJwk as JWK & { alg: 'ES256' },
    getPrivateKey: async () => privateJwk as JWK & { alg: 'ES256' },
  }
  return new SaiSelfIssuedAccessTokenVerifier({ issuer: ISSUER, jwkGenerator: generator })
}

interface TokenOverrides {
  typ?: string
  iss?: string
  aud?: string | Array<string>
  sub?: string
  client?: string
  cnf?: unknown
}

async function mint(overrides: TokenOverrides = {}): Promise<string> {
  return new SignJWT({
    client_id: overrides.client ?? CLIENT,
    cnf: 'cnf' in overrides ? overrides.cnf : { jkt },
  })
    .setProtectedHeader({ alg: 'ES256', typ: overrides.typ ?? AT_JWT })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? ISSUER)
    .setSubject(overrides.sub ?? SUBJECT)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .setJti('c0ffee00-0000-4000-8000-000000000000')
    .sign(keys.privateKey)
}

function input(token: string, proofKeyThumbprint: string | null = jkt) {
  return {
    token,
    tokenType: TOKEN_TYPE_ACCESS_TOKEN,
    audience: ISSUER,
    ...(proofKeyThumbprint === null ? {} : { proofKeyThumbprint }),
  }
}

beforeAll(async () => {
  keys = await generateKeyPair('ES256', { extractable: true })
  publicJwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256' }
  privateJwk = { ...(await exportJWK(keys.privateKey)), alg: 'ES256' }
  dpopKeyPair = await createDpopKeyPair()
  jkt = await dpopThumbprint(dpopKeyPair.publicKey)
})

describe('SaiSelfIssuedAccessTokenVerifier', () => {
  test('accepts a locally signed, sender-constrained access token', async () => {
    const credential = await createSelfIssuedCredentialWithJwk({
      issuer: ISSUER,
      subject: SUBJECT,
      clientId: CLIENT,
      jwkGenerator: {
        alg: 'ES256',
        getPublicKey: async () => publicJwk as JWK & { alg: 'ES256' },
        getPrivateKey: async () => privateJwk as JWK & { alg: 'ES256' },
      },
      lifetime: 300,
      dpopKeyPair,
    })

    await expect(
      verifier().handleSafe(input(await credential.getSubjectToken(), jkt))
    ).resolves.toEqual({ subject: SUBJECT, issuer: ISSUER, client: CLIENT })
  })

  test('pins the at+jwt type', async () => {
    await expect(verifier().handleSafe(input(await mint({ typ: 'JWT' })))).rejects.toThrow(
      BadRequestHttpError
    )
  })

  test('requires the DPoP key that the token is bound to', async () => {
    const token = await mint()
    await expect(verifier().handleSafe(input(token, null))).rejects.toThrow('sender-constrained')
    await expect(verifier().handleSafe(input(token, 'another-thumbprint'))).rejects.toThrow(
      'sender-constrained'
    )
    await expect(verifier().handleSafe(input(await mint({ cnf: undefined })))).rejects.toThrow(
      'cnf.jkt'
    )
  })

  test('requires this UAS as issuer and audience', async () => {
    await expect(
      verifier().handleSafe(input(await mint({ iss: 'https://other/' })))
    ).rejects.toThrow('issuer')
    await expect(
      verifier().handleSafe(input(await mint({ aud: 'https://other/' })))
    ).rejects.toThrow()
    // an additional audience is fine as long as this UAS is present
    await expect(
      verifier().handleSafe(input(await mint({ aud: [ISSUER, 'solid'] })))
    ).resolves.toMatchObject({ subject: SUBJECT })
  })

  test('requires HTTPS subject and client identifiers', async () => {
    await expect(
      verifier().handleSafe(input(await mint({ sub: 'urn:agent:alice' })))
    ).rejects.toThrow('HTTPS URI')
    await expect(verifier().handleSafe(input(await mint({ client: 'alice' })))).rejects.toThrow(
      'HTTPS URI'
    )
  })

  test('only claims the access-token subject type', async () => {
    const token = await mint()
    await expect(
      verifier().handleSafe({
        token,
        tokenType: 'urn:ietf:params:oauth:token-type:id_token',
        audience: ISSUER,
        proofKeyThumbprint: jkt,
      })
    ).rejects.toThrow(NotImplementedHttpError)
  })
})
