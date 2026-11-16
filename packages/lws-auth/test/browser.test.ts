import { exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'

import { createBrowserCredential, createBrowserLwsFetch } from '../src/browser.ts'
import { dpopThumbprint } from '../src/dpop.ts'
import type { BrowserSession } from '../src/session.ts'
import { ACCESS_TOKEN_TYPE } from '../src/tokens.ts'
import { createFakeFetch, formBody, json, makeJwt } from './helpers.ts'

const AUTH = 'https://auth/'
const WEBID = 'https://id/alice'
const CLIENT = 'https://ui.auth/id'
const DATA_AS = 'https://data/'
const DATA_STORAGE = 'https://data/alice-work/'
const SESSION_ACCESS_TOKEN = makeJwt({
  iss: AUTH,
  aud: AUTH,
  sub: WEBID,
  webid: WEBID,
  client_id: CLIENT,
})

let keyPair: CryptoKeyPair

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
})

/** The parts of a signed-in {@link BrowserSession} the credential and the chain use. */
function fakeSession(
  accessToken = async (): Promise<string> => SESSION_ACCESS_TOKEN
): BrowserSession {
  return {
    issuer: AUTH,
    clientId: CLIENT,
    webId: WEBID,
    dpopKeyPair: keyPair,
    dpop: true,
    isLoggedIn: true,
    accessToken,
  } as unknown as BrowserSession
}

describe('dpopThumbprint', () => {
  test('matches the RFC 7638 thumbprint of the same key', async () => {
    const { publicKey } = await generateKeyPair('ES256', { extractable: true })
    const jwk = await exportJWK(publicKey)
    expect(await dpopThumbprint(publicKey as unknown as CryptoKey)).toBe(
      await calculateJwkThumbprint(jwk)
    )
    // a raw JWK works too
    expect(await dpopThumbprint(jwk)).toBe(await calculateJwkThumbprint(jwk))
  })
})

describe('createBrowserCredential', () => {
  test('uses the session access token as the subject token', async () => {
    const credential = await createBrowserCredential(fakeSession())

    expect(credential.issuer).toBe(AUTH)
    expect(credential.clientId).toBe(CLIENT)
    expect(credential.dpopKeyPair).toBe(keyPair)
    expect(credential.subjectTokenType).toBe(ACCESS_TOKEN_TYPE)
    expect(credential.dpopJkt).toBe(await dpopThumbprint(keyPair.publicKey))
    await expect(credential.getSubjectToken()).resolves.toBe(SESSION_ACCESS_TOKEN)
  })

  test('asks the session for the token every time, so a refresh is picked up', async () => {
    const tokens = ['first', 'second']
    const credential = await createBrowserCredential(
      fakeSession(async () => tokens.shift() ?? 'unused')
    )

    await expect(credential.getSubjectToken()).resolves.toBe('first')
    await expect(credential.getSubjectToken()).resolves.toBe('second')
  })

  test('rejects a session without a key pair', async () => {
    await expect(
      createBrowserCredential({ ...fakeSession(), dpopKeyPair: undefined } as BrowserSession)
    ).rejects.toThrow(/no DPoP key pair/u)
  })
})

describe('createBrowserLwsFetch', () => {
  test('runs the two-step chain with the session access token', async () => {
    const { fetch, requests } = createFakeFetch((url, request): Response | undefined => {
      if (url.pathname === '/.well-known/lws/token' && request.method === 'POST') {
        const body = formBody(request)
        return json({
          access_token: `access-${body.get('resource')}`,
          token_type: 'Bearer',
          expires_in: 300,
        })
      }
      if (url.pathname.includes('/.well-known/oauth-protected-resource/')) {
        return json({ resource: url.href, authorization_servers: [DATA_AS] })
      }
      if (url.pathname === '/.well-known/lws-configuration') {
        return json({
          issuer: DATA_AS,
          token_endpoint: `${DATA_AS}.well-known/lws/token`,
          jwks_uri: `${DATA_AS}.well-known/lws/jwks`,
        })
      }
      if (!url.pathname.includes('/.well-known/')) {
        const authorization = request.headers.get('authorization') ?? ''
        return authorization.startsWith('Bearer access-')
          ? new Response('<urn:a> <urn:b> "c".', {
              status: 200,
              headers: { 'content-type': 'text/turtle' },
            })
          : new Response(undefined, {
              status: 401,
              headers: {
                'www-authenticate': `Bearer resource_metadata="${DATA_STORAGE}.well-known/oauth-protected-resource/x", as_uri="${DATA_AS}", realm="${DATA_STORAGE}"`,
              },
            })
      }
    })

    const lwsFetch = await createBrowserLwsFetch({
      session: fakeSession(),
      fetch,
      tokenFetch: fetch,
    })

    const response = await lwsFetch(`${DATA_STORAGE}k3pqsb`)
    expect(response.status).toBe(200)

    // The UAS leg carries the session token as an access token and proves the
    // session key, so the `cnf.jkt` of the token is enforced.
    const idJagRequest = requests.find(
      (request) => new URL(request.url).pathname === '/.well-known/lws/token'
    )
    expect(idJagRequest).toBeDefined()
    const body = formBody(idJagRequest!)
    expect(body.get('subject_token')).toBe(SESSION_ACCESS_TOKEN)
    expect(body.get('subject_token_type')).toBe(ACCESS_TOKEN_TYPE)
    expect(body.get('audience')).toBe(DATA_AS)
    expect(idJagRequest!.headers.get('dpop')).toContain('.')
  })
})
