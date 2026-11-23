import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { type GenerateKeyPairResult, SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { dpopThumbprint } from '../src/dpop.ts'
import { createBrowserSession } from '../src/session.ts'
import { memoryStore } from '../src/store.ts'
import { json, makeJwt, type RecordedRequest } from './helpers.ts'

const ISSUER = 'https://auth/'
const CLIENT = 'https://app/id'
const REDIRECT = 'https://app/redirect'
const WEBID = 'https://id/alice'
const AUTHORIZE = 'https://auth/authorize'
const DISCOVERY = 'https://auth/.well-known/openid-configuration'
const TOKEN = 'https://auth/token'
const JWKS = 'https://auth/jwks'
const RESOURCE = 'https://api.example/data'

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE,
  token_endpoint: TOKEN,
  jwks_uri: JWKS,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['openid', 'webid', 'offline_access'],
  token_endpoint_auth_methods_supported: ['none'],
  dpop_signing_alg_values_supported: ['ES256'],
  id_token_signing_alg_values_supported: ['ES256'],
  subject_types_supported: ['public'],
  authorization_response_iss_parameter_supported: true,
}

let signing: GenerateKeyPairResult
let signingJwk: Record<string, unknown>

beforeAll(async () => {
  signing = await generateKeyPair('ES256', { extractable: true })
  signingJwk = { ...(await exportJWK(signing.publicKey)), kid: 'test' }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Fake {
  fetch: WhatwgFetch
  requests: Array<RecordedRequest>
}

/** A recording fetch; oauth4webapi fetches the JWKS with the global fetch, which is stubbed too. */
function fakeFetch(handler: (url: URL, request: RecordedRequest) => Response | Promise<Response>) {
  const requests: Array<RecordedRequest> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = request.body ? await request.clone().text() : undefined
    const recorded: RecordedRequest = {
      url: url.href,
      method: request.method,
      headers: new Headers(request.headers),
      body,
    }
    requests.push(recorded)
    return handler(url, recorded)
  }
  return { fetch: fetchImpl as WhatwgFetch, requests }
}

async function idToken(nonce: string): Promise<string> {
  return new SignJWT({ webid: WEBID, nonce })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer(ISSUER)
    .setSubject(WEBID)
    .setAudience(CLIENT)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey)
}

function tokenResponse(
  accessToken: string,
  idTokenValue: string | undefined,
  options: { tokenType?: string; expiresIn?: number } = {}
): Response {
  return json({
    access_token: accessToken,
    token_type: options.tokenType ?? 'dpop',
    expires_in: options.expiresIn ?? 300,
    refresh_token: 'refresh-token',
    ...(idTokenValue ? { id_token: idTokenValue } : {}),
  })
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

function decodeProof(proof: string): {
  header: { jwk: JsonWebKey }
  claims: Record<string, unknown>
} {
  const [header, claims] = proof.split('.')
  return { header: decodePart(header) as { jwk: JsonWebKey }, claims: decodePart(claims) }
}

function callback(state: string): string {
  const url = new URL(REDIRECT)
  url.searchParams.set('code', 'authorization-code')
  url.searchParams.set('state', state)
  url.searchParams.set('iss', ISSUER)
  return url.href
}

function buildSession(fake: Fake, options: { dpop?: boolean; now?: () => number } = {}) {
  vi.stubGlobal('fetch', fake.fetch)
  return createBrowserSession({
    issuer: ISSUER,
    clientId: CLIENT,
    redirectUrl: REDIRECT,
    store: memoryStore(),
    fetch: fake.fetch,
    ...options,
  })
}

describe('createBrowserSession', () => {
  test('starts a PKCE + DPoP flow with one non-extractable key pair', async () => {
    const fake = fakeFetch((url) => {
      if (url.href === DISCOVERY) {
        return json(METADATA)
      }
      return new Response('not found', { status: 404 })
    })
    const session = buildSession(fake)

    const url = new URL(await session.login())

    expect(url.origin + url.pathname).toBe(AUTHORIZE)
    expect(url.searchParams.get('client_id')).toBe(CLIENT)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid webid offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('nonce')).toBeTruthy()

    const keyPair = session.dpopKeyPair
    expect(keyPair?.privateKey.extractable).toBe(false)
    expect(url.searchParams.get('dpop_jkt')).toBe(await dpopThumbprint(keyPair!.publicKey))
  })

  test('exchanges the code and signs resource requests with the same key', async () => {
    let nonce = ''
    let accessToken = ''
    const fake = fakeFetch(async (url) => {
      if (url.href === DISCOVERY) {
        return json(METADATA)
      }
      if (url.href === JWKS) {
        return json({ keys: [signingJwk] })
      }
      if (url.href === TOKEN) {
        accessToken = makeJwt({ webid: WEBID, aud: 'solid', iss: ISSUER })
        return tokenResponse(accessToken, await idToken(nonce))
      }
      if (url.href === RESOURCE) {
        return new Response('ok')
      }
      return new Response('not found', { status: 404 })
    })
    const session = buildSession(fake)

    const authorizationUrl = new URL(await session.login())
    nonce = authorizationUrl.searchParams.get('nonce') ?? ''
    const state = authorizationUrl.searchParams.get('state') ?? ''

    const info = await session.handleRedirect(callback(state))
    expect(info).toEqual({ issuer: ISSUER, clientId: CLIENT, webId: WEBID })

    // The token request proves possession of the same key `dpop_jkt` names.
    const tokenRequest = fake.requests.find((request) => request.url === TOKEN)!
    expect(tokenRequest.body).toContain('grant_type=authorization_code')
    expect(tokenRequest.headers.get('authorization')).toBeNull()
    const codeProof = decodeProof(tokenRequest.headers.get('dpop')!)
    expect(codeProof.claims).toMatchObject({ htm: 'POST', htu: TOKEN })
    expect(await dpopThumbprint(codeProof.header.jwk)).toBe(
      authorizationUrl.searchParams.get('dpop_jkt')
    )

    // Resource requests carry the access token and a proof for the same key.
    const response = await session.fetch(RESOURCE)
    expect(response.status).toBe(200)
    const resourceRequest = fake.requests.find((request) => request.url === RESOURCE)!
    expect(resourceRequest.headers.get('authorization')).toBe(`DPoP ${accessToken}`)
    const resourceProof = decodeProof(resourceRequest.headers.get('dpop')!)
    expect(resourceProof.claims).toMatchObject({ htm: 'GET', htu: RESOURCE })
    expect(typeof resourceProof.claims.ath).toBe('string')
    expect(await dpopThumbprint(resourceProof.header.jwk)).toBe(
      authorizationUrl.searchParams.get('dpop_jkt')
    )
  })

  test('refreshes the access token with the same key when it nears expiry', async () => {
    let clock = Date.UTC(2026, 10, 14, 12, 0, 0)
    let nonce = ''
    let refreshCalls = 0
    const fake = fakeFetch(async (url, request) => {
      if (url.href === DISCOVERY) {
        return json(METADATA)
      }
      if (url.href === JWKS) {
        return json({ keys: [signingJwk] })
      }
      if (url.href === TOKEN) {
        const body = new URLSearchParams(request.body ?? '')
        if (body.get('grant_type') === 'refresh_token') {
          refreshCalls += 1
          return tokenResponse(makeJwt({ webid: WEBID, aud: 'solid', iss: ISSUER }), undefined, {
            expiresIn: 60,
          })
        }
        return tokenResponse(
          makeJwt({ webid: WEBID, aud: 'solid', iss: ISSUER }),
          await idToken(nonce),
          {
            expiresIn: 60,
          }
        )
      }
      if (url.href === RESOURCE) {
        return new Response('ok')
      }
      return new Response('not found', { status: 404 })
    })
    const session = buildSession(fake, { now: () => clock })

    const authorizationUrl = new URL(await session.login())
    nonce = authorizationUrl.searchParams.get('nonce') ?? ''
    await session.handleRedirect(callback(authorizationUrl.searchParams.get('state') ?? ''))

    // inside the 30 s renewal margin → refreshed before the request
    clock += 40_000
    expect((await session.fetch(RESOURCE)).status).toBe(200)
    expect(refreshCalls).toBe(1)

    const refreshRequest = fake.requests.filter((request) => request.url === TOKEN).at(-1)!
    expect(refreshRequest.body).toContain('grant_type=refresh_token')
    expect(await dpopThumbprint(decodeProof(refreshRequest.headers.get('dpop')!).header.jwk)).toBe(
      authorizationUrl.searchParams.get('dpop_jkt')
    )
  })

  test('can run the session on a bearer token while DPoP rolls out', async () => {
    let nonce = ''
    const fake = fakeFetch(async (url) => {
      if (url.href === DISCOVERY) {
        return json(METADATA)
      }
      if (url.href === JWKS) {
        return json({ keys: [signingJwk] })
      }
      if (url.href === TOKEN) {
        return tokenResponse(
          makeJwt({ webid: WEBID, aud: 'solid', iss: ISSUER }),
          await idToken(nonce),
          {
            tokenType: 'bearer',
          }
        )
      }
      if (url.href === RESOURCE) {
        return new Response('ok')
      }
      return new Response('not found', { status: 404 })
    })
    const session = buildSession(fake, { dpop: false })

    const authorizationUrl = new URL(await session.login())
    expect(authorizationUrl.searchParams.get('dpop_jkt')).toBeNull()
    nonce = authorizationUrl.searchParams.get('nonce') ?? ''
    await session.handleRedirect(callback(authorizationUrl.searchParams.get('state') ?? ''))

    expect((await session.fetch(RESOURCE)).status).toBe(200)
    const resourceRequest = fake.requests.find((request) => request.url === RESOURCE)!
    expect(resourceRequest.headers.get('authorization')).toMatch(/^Bearer /u)
    expect(resourceRequest.headers.get('dpop')).toBeNull()
  })

  test('rejects a redirect whose state does not match the pending flow', async () => {
    const fake = fakeFetch((url) => {
      if (url.href === DISCOVERY) {
        return json(METADATA)
      }
      return new Response('not found', { status: 404 })
    })
    const session = buildSession(fake)
    await session.login()

    await expect(session.handleRedirect(callback('not-the-state'))).rejects.toThrow()
  })
})
