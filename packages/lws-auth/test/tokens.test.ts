import { beforeAll, describe, expect, test } from 'vitest'

import {
  ACCESS_TOKEN_TYPE,
  ID_JAG_TOKEN_TYPE,
  requestAccessToken,
  requestIdJag,
} from '../src/tokens.ts'
import { createFakeFetch, formBody, json, makeJwt } from './helpers.ts'

const UAS = 'https://auth/'
const UAS_TOKEN_ENDPOINT = 'https://auth/.well-known/lws/token'
const RAS = 'https://data/'
const RAS_TOKEN_ENDPOINT = 'https://data/.well-known/lws/token'
const CLIENT = 'https://data/test-client/public/id'
const STORAGE = 'https://data/alice-work/'
const SUBJECT_TOKEN = makeJwt({ iss: UAS, aud: 'solid', sub: 'https://id/alice' })
const ID_JAG = makeJwt({ iss: UAS, aud: RAS, sub: 'https://id/alice', client_id: CLIENT })
const ACCESS_CLAIM = [{ id: 'urn:policy', permission: [] }]

let keyPair: CryptoKeyPair

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
})

describe('requestIdJag', () => {
  test('asks the UAS for a grant restricted to one resource authorization server', async () => {
    const { fetch, requests } = createFakeFetch((url, request) => {
      if (url.href === UAS_TOKEN_ENDPOINT && request.method === 'POST') {
        return json({ access_token: ID_JAG, token_type: 'N_A', expires_in: 300 })
      }
    })

    await expect(
      requestIdJag({
        uas: UAS,
        audience: RAS,
        resource: STORAGE,
        subjectToken: SUBJECT_TOKEN,
        clientId: CLIENT,
        dpopKeyPair: keyPair,
        fetch,
      })
    ).resolves.toBe(ID_JAG)

    expect(requests).toHaveLength(1)
    const body = formBody(requests[0])
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(body.get('requested_token_type')).toBe(ID_JAG_TOKEN_TYPE)
    expect(body.get('audience')).toBe(RAS)
    expect(body.get('resource')).toBe(STORAGE)
    expect(body.get('subject_token')).toBe(SUBJECT_TOKEN)
    expect(body.get('subject_token_type')).toBe(ACCESS_TOKEN_TYPE)
    // the credential is sender-constrained: the proof is what makes it exchangeable
    expect(requests[0].headers.get('dpop')).toEqual(expect.any(String))
  })

  test('sends an ODRL access claim when the UAS is asked for one', async () => {
    const { fetch, requests } = createFakeFetch((url, request) => {
      if (url.href === UAS_TOKEN_ENDPOINT && request.method === 'POST') {
        return json({ access_token: ID_JAG, token_type: 'N_A', expires_in: 300 })
      }
    })

    await requestIdJag({
      uas: UAS,
      audience: RAS,
      subjectToken: SUBJECT_TOKEN,
      clientId: CLIENT,
      dpopKeyPair: keyPair,
      accessClaim: ACCESS_CLAIM,
      fetch,
    })

    expect(formBody(requests[0]).get('access')).toBe(JSON.stringify(ACCESS_CLAIM))
  })

  test('surfaces the OAuth error of a rejected exchange', async () => {
    const { fetch } = createFakeFetch(() =>
      json({ error: 'invalid_target', error_description: 'not a storage' }, 400)
    )

    await expect(
      requestIdJag({
        uas: UAS,
        audience: 'https://elsewhere.example/',
        subjectToken: SUBJECT_TOKEN,
        clientId: CLIENT,
        dpopKeyPair: keyPair,
        fetch,
      })
    ).rejects.toMatchObject({ error: 'invalid_target', error_description: 'not a storage' })
  })
})

describe('requestAccessToken', () => {
  test('trades the grant at the storage authorization server, without DPoP', async () => {
    const { fetch, requests } = createFakeFetch((url, request) => {
      if (url.href === RAS_TOKEN_ENDPOINT && request.method === 'POST') {
        return json({ access_token: 'access-token', token_type: 'Bearer', expires_in: 300 })
      }
    })

    await expect(
      requestAccessToken({
        ras: { issuer: RAS, tokenEndpoint: RAS_TOKEN_ENDPOINT },
        idJag: ID_JAG,
        resource: 'https://data/alice-work/',
        clientId: CLIENT,
        fetch,
      })
    ).resolves.toEqual({ accessToken: 'access-token', expiresIn: 300 })

    const body = formBody(requests[0])
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(body.get('subject_token')).toBe(ID_JAG)
    expect(body.get('subject_token_type')).toBe(ID_JAG_TOKEN_TYPE)
    expect(body.get('resource')).toBe('https://data/alice-work/')
    // the second leg is audience-constrained, not sender-constrained
    expect(requests[0].headers.get('dpop')).toBeNull()
  })
})
