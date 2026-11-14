import { exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'

import { createBrowserCredential, createBrowserLwsFetch } from '../src/browser.ts'
import { dpopThumbprint } from '../src/dpop.ts'
import { createFakeFetch, json, makeJwt } from './helpers.ts'

const AUTH = 'https://auth/'
const ID_TOKEN_ENDPOINT = 'https://auth/.sai/id-token'
const WEBID = 'https://id/alice'
const CLIENT = 'https://ui.auth/id'
const DATA_AS = 'https://data/'
const DATA_STORAGE = 'https://data/alice-work/'

let keyPair: CryptoKeyPair

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
})

/** The mint endpoint of `auth`, answering with a credential bound to `jkt`. */
function mintRoute(grantLifetime: number, clock: () => number) {
  return (url: URL): Response | undefined => {
    if (url.pathname !== '/.sai/id-token') return undefined
    return json({
      id_token: makeJwt({
        iss: AUTH,
        aud: 'solid',
        sub: WEBID,
        webid: WEBID,
        azp: url.searchParams.get('client_id'),
        client_id: url.searchParams.get('client_id'),
        cnf: { jkt: url.searchParams.get('dpop_jkt') },
        exp: Math.floor(clock() / 1000) + grantLifetime,
      }),
      token_type: 'N_A',
      expires_in: grantLifetime,
      issuer: AUTH,
    })
  }
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
  test('mints a credential bound to the browser key, with the client and jkt', async () => {
    const clock = () => Date.UTC(2026, 10, 14, 12, 0, 0)
    const { fetch, requests } = createFakeFetch(mintRoute(300, clock))
    const credential = await createBrowserCredential({
      issuer: AUTH,
      clientId: CLIENT,
      keyPair,
      credentialFetch: fetch,
      now: clock,
    })

    const token = await credential.getSubjectToken()

    expect(requests).toHaveLength(1)
    const url = new URL(requests[0].url)
    expect(url.origin + url.pathname).toBe(ID_TOKEN_ENDPOINT)
    expect(url.searchParams.get('client_id')).toBe(CLIENT)
    expect(url.searchParams.get('dpop_jkt')).toBe(credential.dpopJkt)
    expect(credential.issuer).toBe(AUTH)
    expect(credential.clientId).toBe(CLIENT)
    expect(credential.dpopKeyPair).toBe(keyPair)
    expect(token).toContain('.')
  })

  test('caches the credential until shortly before it expires', async () => {
    let clock = Date.UTC(2026, 10, 14, 12, 0, 0)
    const { fetch, requests } = createFakeFetch(mintRoute(60, () => clock))
    const credential = await createBrowserCredential({
      issuer: AUTH,
      clientId: CLIENT,
      keyPair,
      credentialFetch: fetch,
      now: () => clock,
    })

    await credential.getSubjectToken()
    await credential.getSubjectToken()
    expect(requests).toHaveLength(1)

    // still inside the 30 s renewal margin → minted again
    clock += 40_000
    await credential.getSubjectToken()
    expect(requests).toHaveLength(2)
  })

  test('rejects a response without a credential, and failed requests', async () => {
    const empty = createFakeFetch(() => json({ expires_in: 300 }))
    await expect(
      createBrowserCredential({
        issuer: AUTH,
        clientId: CLIENT,
        keyPair,
        credentialFetch: empty.fetch,
      }).then((credential) => credential.getSubjectToken())
    ).rejects.toThrow(/carries no id_token/u)

    const denied = createFakeFetch(() => json({ error: 'unauthorized' }, 403))
    await expect(
      createBrowserCredential({
        issuer: AUTH,
        clientId: CLIENT,
        keyPair,
        credentialFetch: denied.fetch,
      }).then((credential) => credential.getSubjectToken())
    ).rejects.toThrow(/403/u)
  })
})

describe('createBrowserLwsFetch', () => {
  test('runs the two-step chain with the browser credential', async () => {
    const clock = Date.UTC(2026, 10, 14, 12, 0, 0)
    const mint = mintRoute(300, () => clock)
    const { fetch } = createFakeFetch((url, request): Response | undefined => {
      const minted = mint(url)
      if (minted) return minted
      const href = url.href
      if (url.pathname === '/.well-known/lws/token' && request.method === 'POST') {
        const body = new URLSearchParams(request.body ?? '')
        return json({
          access_token: `access-${body.get('resource')}`,
          token_type: 'Bearer',
          expires_in: 300,
        })
      }
      if (url.pathname.includes('/.well-known/oauth-protected-resource/')) {
        return json({ resource: href, authorization_servers: [DATA_AS] })
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
      issuer: AUTH,
      clientId: CLIENT,
      keyPair,
      credentialFetch: fetch,
      fetch,
    })

    const response = await lwsFetch(`${DATA_STORAGE}k3pqsb`)
    expect(response.status).toBe(200)
  })
})
