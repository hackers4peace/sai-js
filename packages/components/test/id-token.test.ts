import type { CredentialsExtractor, ResourceIdentifier } from '@solid/community-server'
import { BadRequestHttpError, ForbiddenHttpError } from '@solid/community-server'
import type { GenerateKeyPairResult } from 'jose'
import { SignJWT, decodeJwt, exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { IdTokenHandler } from '../src/IdTokenHandler.js'
import { IdTokenIssuer } from '../src/IdTokenIssuer.js'

const BASE_URL = 'https://auth/'
const ENDPOINT = 'https://auth/.sai/id-token'
const WEBID = 'https://id/alice'
const CLIENT = 'https://ui.auth/id'

let keys: GenerateKeyPairResult

const originalBaseUrl = process.env.CSS_BASE_URL

beforeAll(async () => {
  // `agentId()` (the default client) is built from the server's base URL
  process.env.CSS_BASE_URL = BASE_URL
  keys = await generateKeyPair('ES256', { extractable: true })
})

afterAll(() => {
  process.env.CSS_BASE_URL = originalBaseUrl
})

function buildIssuer(): IdTokenIssuer {
  return new IdTokenIssuer(
    BASE_URL,
    {
      alg: 'ES256',
      getPublicKey: async () => ({ ...(await exportJWK(keys.publicKey)), alg: 'ES256' }),
      getPrivateKey: async () => ({ ...(await exportJWK(keys.privateKey)), alg: 'ES256' }),
    },
    300
  )
}

/** A DPoP proof for this endpoint, signed with `keys` (the browser's stand-in). */
async function dpopProof(jkt: string, method = 'GET'): Promise<string> {
  return new SignJWT({ htm: method, htu: ENDPOINT })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(keys.publicKey) })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(keys.privateKey)
}

async function jkt(): Promise<string> {
  const { calculateJwkThumbprint } = await import('jose')
  return calculateJwkThumbprint(await exportJWK(keys.publicKey))
}

function buildHandler(webId: string | null = WEBID): IdTokenHandler {
  const extractor = {
    handleSafe: async () => (webId ? { agent: { webId } } : {}),
  } as unknown as CredentialsExtractor
  return new IdTokenHandler(extractor, buildIssuer())
}

interface Call {
  method?: string
  url?: string
  headers?: Record<string, string>
}

async function call(handler: IdTokenHandler, { method = 'GET', url, headers = {} }: Call = {}) {
  return handler.handle({
    operation: { method, target: { path: ENDPOINT } as ResourceIdentifier } as never,
    request: { url: url ?? `${ENDPOINT}?dpop_jkt=${await jkt()}`, headers } as never,
  })
}

async function bodyOf(response: { data: unknown }): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of response.data as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

describe('IdTokenIssuer', () => {
  test('issues a DPoP-bound credential for the session', async () => {
    const token = await buildIssuer().issue(WEBID, CLIENT, 'thumbprint')
    const { protectedHeader, payload } = await jwtVerify(token, keys.publicKey)
    expect(protectedHeader).toMatchObject({ typ: 'at+jwt', alg: 'ES256' })
    expect(payload).toMatchObject({
      iss: BASE_URL,
      aud: 'solid',
      sub: WEBID,
      webid: WEBID,
      client_id: CLIENT,
      azp: CLIENT,
      cnf: { jkt: 'thumbprint' },
    })
    expect(payload.jti).toEqual(expect.any(String))
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300)
  })
})

describe('IdTokenHandler', () => {
  test('hands the session a credential bound to the requested key', async () => {
    const handler = buildHandler()
    const response = await call(handler, {
      url: `${ENDPOINT}?dpop_jkt=${await jkt()}&client_id=${encodeURIComponent(CLIENT)}`,
    })

    expect(response.statusCode).toBe(200)
    const body = await bodyOf(response as { data: unknown })
    expect(body).toMatchObject({ token_type: 'N_A', expires_in: 300, issuer: BASE_URL })

    const { payload } = await jwtVerify(String(body.id_token), keys.publicKey)
    expect(payload).toMatchObject({ webid: WEBID, client_id: CLIENT, cnf: { jkt: await jkt() } })
  })

  test('defaults the client to the agent identifier', async () => {
    const handler = buildHandler()
    const response = await call(handler)
    const body = await bodyOf(response as { data: unknown })
    const { payload } = await jwtVerify(String(body.id_token), keys.publicKey)
    expect(payload.client_id).toBe(
      `${BASE_URL}.sai/agents/${Buffer.from(WEBID).toString('base64url')}`
    )
  })

  test('requires an authenticated session', async () => {
    await expect(call(buildHandler(null))).rejects.toThrow(ForbiddenHttpError)
  })

  test('requires a dpop_jkt binding or a DPoP proof', async () => {
    await expect(call(buildHandler(), { url: ENDPOINT })).rejects.toThrow(BadRequestHttpError)
  })

  test('derives the binding from the DPoP proof when dpop_jkt is omitted', async () => {
    const proof = await dpopProof(await jkt())
    const response = await call(buildHandler(), { url: ENDPOINT, headers: { dpop: proof } })
    expect(response.statusCode).toBe(200)
    const body = await bodyOf(response)
    const claims = decodeJwt(String(body.id_token))
    expect((claims.cnf as { jkt: string }).jkt).toBe(await jkt())
  })

  test('accepts a matching DPoP proof and rejects a mismatching one', async () => {
    const handler = buildHandler()
    const proof = await dpopProof(await jkt())
    const response = await call(handler, {
      url: `${ENDPOINT}?dpop_jkt=${await jkt()}`,
      headers: { dpop: proof },
    })
    expect(response.statusCode).toBe(200)

    const other = await generateKeyPair('ES256', { extractable: true })
    const foreign = await new SignJWT({ htm: 'GET', htu: ENDPOINT })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(other.publicKey) })
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .sign(other.privateKey)
    await expect(
      call(handler, { url: `${ENDPOINT}?dpop_jkt=${await jkt()}`, headers: { dpop: foreign } })
    ).rejects.toThrow(/does not match dpop_jkt/u)
  })

  test('is GET only', async () => {
    await expect(call(buildHandler(), { method: 'POST' })).rejects.toThrow(/GET/u)
  })
})
