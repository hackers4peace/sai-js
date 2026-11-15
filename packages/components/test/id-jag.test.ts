import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

import { ODRL_ID_JAG_CONTEXT, createLwsTokenDpopProof } from '@janeirodigital/interop-utils'
import type {
  HttpResponse,
  JwkGenerator,
  SubjectTokenVerifierInput,
  VerifiedSubject,
} from '@solid/community-server'
import { SubjectTokenVerifier } from '@solid/community-server'
import type { JWK } from 'jose'
import { calculateJwkThumbprint, exportJWK, generateKeyPair, jwtVerify } from 'jose'
import type { GenerateKeyPairResult } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'

import { ID_JAG_JWT_TYPE, ID_JAG_TOKEN_TYPE, IdJagIssuer } from '../src/IdJagIssuer.js'
import { ID_JAG_GRANT_TYPE, IdJagTokenHandler } from '../src/IdJagTokenHandler.js'
import {
  CLAIM_CLIENT,
  CLAIM_OTHER_STORAGE,
  CLAIM_STORAGE,
  CLAIM_SUBJECT,
  accessClaim,
} from './access-claim-helpers.js'

const BASE_URL = 'https://auth/'
const TOKEN_ENDPOINT = 'https://auth/.well-known/lws/token'
const DATA = 'https://data/'
const CLIENT = 'https://data/test-client/public/id'
const WEBID = 'https://id/alice/'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

let keys: GenerateKeyPairResult
let publicJwk: JWK

/** Records the input it was asked to verify and answers with a fixed subject. */
class StubVerifier extends SubjectTokenVerifier {
  public last?: SubjectTokenVerifierInput

  public async canHandle(): Promise<void> {
    // accept every token type
  }

  public async handle(input: SubjectTokenVerifierInput): Promise<VerifiedSubject> {
    this.last = input
    return { subject: WEBID, issuer: BASE_URL, client: CLIENT }
  }
}

function makeRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from([body]) as unknown as IncomingMessage
  request.method = 'POST'
  request.headers = { 'content-type': 'application/x-www-form-urlencoded', ...headers }
  return request
}

interface Captured {
  status?: number
  headers?: Record<string, string>
  body?: string
}

function makeResponse(): { response: HttpResponse; captured: Captured } {
  const captured: Captured = {}
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      return this
    },
    end(body: string) {
      captured.body = body
      return this
    },
  } as unknown as HttpResponse
  return { response, captured }
}

function tokenRequest(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    grant_type: ID_JAG_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: DATA,
    subject_token: 'id-token',
    subject_token_type: ID_TOKEN_TYPE,
    ...overrides,
  })
  return params.toString()
}

async function call(
  handler: IdJagTokenHandler,
  body: string,
  headers: Record<string, string> = {}
): Promise<Captured> {
  const { response, captured } = makeResponse()
  await handler.handle({ request: makeRequest(body, headers), response })
  return captured
}

beforeAll(async () => {
  keys = await generateKeyPair('ES256', { extractable: true })
  publicJwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256' }
  await calculateJwkThumbprint(publicJwk)
})

function buildHandler(): { handler: IdJagTokenHandler; verifier: StubVerifier } {
  const generator: JwkGenerator = {
    alg: 'ES256',
    getPublicKey: async () => publicJwk as JWK & { alg: 'ES256' },
    getPrivateKey: async () => (await exportJWK(keys.privateKey)) as JWK & { alg: 'ES256' },
  }
  const verifier = new StubVerifier()
  const issuer = new IdJagIssuer(BASE_URL, generator, 300)
  const handler = new IdJagTokenHandler({
    issuer,
    verifier,
    storageOrigins: ['data', 'registry'],
  })
  return { handler, verifier }
}

describe('IdJagTokenHandler', () => {
  test('issues an ID-JAG restricted to the requested storage', async () => {
    const { handler, verifier } = buildHandler()
    const captured = await call(handler, tokenRequest())

    expect(captured.status).toBe(200)
    expect(captured.headers?.['content-type']).toBe('application/json')

    const body = JSON.parse(String(captured.body))
    expect(body).toMatchObject({
      issued_token_type: ID_JAG_TOKEN_TYPE,
      token_type: 'N_A',
      expires_in: 300,
    })

    const { protectedHeader, payload } = await jwtVerify(body.access_token, keys.publicKey)
    expect(protectedHeader.typ).toBe(ID_JAG_JWT_TYPE)
    expect(protectedHeader.alg).toBe('ES256')
    expect(payload).toMatchObject({
      iss: BASE_URL,
      aud: DATA,
      sub: WEBID,
      client_id: CLIENT,
    })
    expect(payload.jti).toEqual(expect.any(String))
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300)

    // the subject token is verified against this server, not against the storage
    expect(verifier.last).toMatchObject({
      token: 'id-token',
      tokenType: ID_TOKEN_TYPE,
      audience: BASE_URL,
    })
    expect(verifier.last?.proofKeyThumbprint).toBeUndefined()
  })

  test('rejects an audience that is not one of its storages', async () => {
    const { handler } = buildHandler()
    const captured = await call(handler, tokenRequest({ audience: 'https://elsewhere.example/' }))

    expect(captured.status).toBe(400)
    expect(JSON.parse(String(captured.body)).error).toBe('invalid_target')
  })

  test('only answers token exchange requests that ask for an ID-JAG', async () => {
    const { handler } = buildHandler()

    const wrongGrant = await call(handler, tokenRequest({ grant_type: 'authorization_code' }))
    expect(wrongGrant.status).toBe(400)
    expect(JSON.parse(String(wrongGrant.body)).error).toBe('unsupported_grant_type')

    const wrongType = await call(
      handler,
      tokenRequest({ requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' })
    )
    expect(wrongType.status).toBe(400)
    expect(JSON.parse(String(wrongType.body)).error).toBe('invalid_request')
  })

  test('requires the form content type and the required parameters', async () => {
    const { handler } = buildHandler()

    const wrongContentType = await call(handler, tokenRequest(), {
      'content-type': 'application/json',
    })
    expect(wrongContentType.status).toBe(400)
    expect(JSON.parse(String(wrongContentType.body)).error).toBe('invalid_request')

    const params = new URLSearchParams(tokenRequest())
    params.delete('audience')
    const missingAudience = await call(handler, params.toString())
    expect(missingAudience.status).toBe(400)
    expect(JSON.parse(String(missingAudience.body)).error).toBe('invalid_request')
  })

  test('forwards the DPoP proof thumbprint to the verifier', async () => {
    const { handler, verifier } = buildHandler()
    const proof = await createLwsTokenDpopProof(TOKEN_ENDPOINT, keys)

    const captured = await call(handler, tokenRequest(), { dpop: proof })

    expect(captured.status).toBe(200)
    expect(verifier.last?.proofKeyThumbprint).toBe(await calculateJwkThumbprint(publicJwk))
  })

  test('issues an ID-JAG carrying the ODRL access claim and its context', async () => {
    const { handler } = buildHandler()
    const claim = accessClaim()
    const captured = await call(handler, tokenRequest({ access: JSON.stringify(claim) }))

    expect(captured.status).toBe(200)
    const { payload } = await jwtVerify(
      JSON.parse(String(captured.body)).access_token,
      keys.publicKey
    )
    expect(payload['@context']).toBe(ODRL_ID_JAG_CONTEXT)
    expect(payload.access).toEqual(claim)
    expect(payload).toMatchObject({ sub: CLAIM_SUBJECT, client_id: CLAIM_CLIENT })
  })

  test('rejects an access claim spanning more than one storage', async () => {
    const { handler } = buildHandler()
    const claim = [...accessClaim(), ...accessClaim({ storage: CLAIM_OTHER_STORAGE })]
    const captured = await call(handler, tokenRequest({ access: JSON.stringify(claim) }))

    expect(captured.status).toBe(400)
    expect(JSON.parse(String(captured.body)).error).toBe('invalid_request')
    expect(JSON.parse(String(captured.body)).error_description).toContain('same lws:storage')
  })

  test('rejects malformed and wrongly assigned access claims', async () => {
    const { handler } = buildHandler()

    const malformed = await call(handler, tokenRequest({ access: 'not-json' }))
    expect(malformed.status).toBe(400)
    expect(JSON.parse(String(malformed.body)).error).toBe('invalid_request')

    const wrongAssigner = await call(
      handler,
      tokenRequest({
        access: JSON.stringify(accessClaim({ assigner: 'https://id/mallory' })),
      })
    )
    expect(wrongAssigner.status).toBe(400)
    expect(JSON.parse(String(wrongAssigner.body)).error_description).toContain(
      'assigned by the authenticated subject'
    )

    const wrongAssignee = await call(
      handler,
      tokenRequest({
        access: JSON.stringify(accessClaim({ assignee: 'https://id/mallory' })),
      })
    )
    expect(wrongAssignee.status).toBe(400)
    expect(JSON.parse(String(wrongAssignee.body)).error_description).toContain(
      'assigned to the authenticated client'
    )
  })

  test('binds a claim to the requested resource when one is supplied', async () => {
    const { handler } = buildHandler()
    const request = tokenRequest({
      access: JSON.stringify(accessClaim()),
      resource: CLAIM_STORAGE,
    })
    expect((await call(handler, request)).status).toBe(200)

    const mismatch = await call(
      handler,
      tokenRequest({
        access: JSON.stringify(accessClaim()),
        resource: CLAIM_OTHER_STORAGE,
      })
    )
    expect(mismatch.status).toBe(400)
    expect(JSON.parse(String(mismatch.body)).error).toBe('invalid_target')
  })

  test('rejects a proof for another endpoint or a malformed proof', async () => {
    const { handler } = buildHandler()

    const wrongHtu = await createLwsTokenDpopProof('https://data/.well-known/lws/token', keys)
    const wrongEndpoint = await call(handler, tokenRequest(), { dpop: wrongHtu })
    expect(wrongEndpoint.status).toBe(400)
    expect(JSON.parse(String(wrongEndpoint.body)).error).toBe('invalid_dpop_proof')

    const malformed = await call(handler, tokenRequest(), { dpop: 'not-a-jwt' })
    expect(malformed.status).toBe(400)
    expect(JSON.parse(String(malformed.body)).error).toBe('invalid_dpop_proof')
  })
})
