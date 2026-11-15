import { buildLwsFetch, buildSelfIssuedCredential } from '@elfpavlik/sai-components'
import { grantAccess } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  ODRL,
  ODRL_ID_JAG_CONTEXT,
  createLwsTokenDpopProof,
} from '@janeirodigital/interop-utils'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { describe, expect, test } from 'vitest'

/*
 * The LWS authorization chain (docs/plans/lws-auth.md):
 *
 *  C1 — the UAS (`auth`) exchanges an ID token, sender-constrained to a DPoP
 *       key, for an ID-JAG whose `aud` is one specific storage's authorization
 *       server;
 *  C2 — that storage's authorization server (`data`, `registry`) exchanges the
 *       ID-JAG for a bearer access token, and keeps accepting ID tokens.
 */

const AUTH = process.env.CSS_BASE_URL ?? 'https://auth/'
const TOKEN_ENDPOINT = new URL('.well-known/lws/token', AUTH).href
const WEBID = 'https://id/alice'
const CLIENT = 'https://data/test-client/public/id'
// The authorization server identifiers are the server base URLs; the `resource`
// of a token request is the storage (a pod) that holds the resource.
const DATA_AS = 'https://data/'
const DATA_STORAGE = 'https://data/alice-work/'
const REGISTRY_AS = 'https://registry/'
const REGISTRY_STORAGE = 'https://registry/alice/'

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ID_JAG_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

interface IdJagRequest {
  overrides?: Record<string, string>
  proof?: boolean
}

async function requestIdJag({
  overrides = {},
  proof = true,
}: IdJagRequest = {}): Promise<Response> {
  const { oidc, dpopKeyPair } = await buildSelfIssuedCredential(WEBID, CLIENT)
  const subjectToken = await oidc.generateSelfIssuedAccessToken()

  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE,
    requested_token_type: ID_JAG_TYPE,
    audience: DATA_AS,
    subject_token: subjectToken,
    subject_token_type: ID_TOKEN_TYPE,
    ...overrides,
  })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (proof) {
    headers.dpop = await createLwsTokenDpopProof(TOKEN_ENDPOINT, dpopKeyPair)
  }

  return fetch(TOKEN_ENDPOINT, { method: 'POST', headers, body: body.toString() })
}

/** Mints an ID-JAG for `DATA_AS` and returns the grant itself. */
async function mintIdJag(): Promise<string> {
  const response = await requestIdJag()
  expect(response.status).toBe(200)
  const body = (await response.json()) as Record<string, unknown>
  return String(body.access_token)
}

/** RFC 8693 token exchange at a storage's LWS authorization server. */
function exchangeAtRas(asUrl: string, params: Record<string, string>): Promise<Response> {
  return fetch(new URL('.well-known/lws/token', asUrl).href, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, ...params }).toString(),
  })
}

describe('ID-JAG issuance at the UAS', () => {
  test('exchanges a DPoP-bound ID token for an ID-JAG for one storage', async () => {
    const response = await requestIdJag()

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ issued_token_type: ID_JAG_TYPE, token_type: 'N_A' })

    const idJag = String(body.access_token)
    expect(decodeProtectedHeader(idJag)).toMatchObject({ typ: 'oauth-id-jag+jwt', alg: 'ES256' })
    expect(decodeJwt(idJag)).toMatchObject({
      iss: AUTH,
      aud: DATA_AS,
      sub: WEBID,
      client_id: CLIENT,
    })
    expect(Number(body.expires_in)).toBeGreaterThan(0)
  })

  test('refuses to mint an ID-JAG without the proof of the bound key', async () => {
    const response = await requestIdJag({ proof: false })

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
    expect(String(body.error_description)).toContain('sender-constrained')
  })

  test('rejects an audience it does not issue grants for', async () => {
    const response = await requestIdJag({ overrides: { audience: 'https://elsewhere.example/' } })

    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_target')
  })

  test('only serves the token exchange grant', async () => {
    const response = await requestIdJag({ overrides: { grant_type: 'authorization_code' } })

    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe(
      'unsupported_grant_type'
    )
  })
})

describe('ID-JAG exchange at a storage authorization server', () => {
  test('trades the grant for an access token of that storage', async () => {
    const idJag = await mintIdJag()

    const response = await exchangeAtRas(DATA_AS, {
      subject_token: idJag,
      subject_token_type: ID_JAG_TYPE,
      resource: DATA_STORAGE,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.token_type).toBe('Bearer')

    const accessToken = String(body.access_token)
    expect(decodeProtectedHeader(accessToken)).toMatchObject({ typ: 'at+jwt' })
    expect(decodeJwt(accessToken)).toMatchObject({
      iss: DATA_AS,
      aud: DATA_STORAGE,
      sub: WEBID,
      client_id: CLIENT,
    })
  })

  test("rejects a grant that names another storage's authorization server", async () => {
    // Minted with `aud: https://data/`, offered to the registry's AS.
    const idJag = await mintIdJag()

    const response = await exchangeAtRas(REGISTRY_AS, {
      subject_token: idJag,
      subject_token_type: ID_JAG_TYPE,
      resource: REGISTRY_STORAGE,
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_request')
  })

  test('rejects an ID token presented as a grant', async () => {
    const { oidc } = await buildSelfIssuedCredential(WEBID, CLIENT)
    const idToken = await oidc.generateSelfIssuedAccessToken()

    const response = await exchangeAtRas(DATA_AS, {
      subject_token: idToken,
      subject_token_type: ID_JAG_TYPE,
      resource: DATA_STORAGE,
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_request')
  })

  test('advertises the id-jag subject token type next to id_token', async () => {
    const response = await fetch(new URL('.well-known/lws-configuration', DATA_AS).href, {
      headers: { accept: 'application/json' },
    })

    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    const types = metadata.subject_token_types_supported as string[]
    expect(types).toContain(ID_JAG_TYPE)
    expect(types).toContain(ID_TOKEN_TYPE)
  })
})

describe('ODRL access claim in the ID-JAG (C1)', () => {
  const claim = grantAccess({
    scopeOfGrant: INTEROP.AllFromRegistry,
    owner: WEBID,
    storage: DATA_STORAGE,
    hasDataRegistration: 'https://data/alice-work/sx86hi',
    registeredShapeTree: 'https://data/shapetrees/trees/Project',
    assigner: WEBID,
    assignee: CLIENT,
    actions: [ODRL.read],
  })

  test('self-issues the claim, keeps it in the access token, and evaluates it claim-first', async () => {
    const response = await requestIdJag({ overrides: { access: JSON.stringify(claim) } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    const idJag = String(body.access_token)
    expect(decodeJwt(idJag)).toMatchObject({
      '@context': ODRL_ID_JAG_CONTEXT,
      access: claim,
    })

    const exchange = await exchangeAtRas(DATA_AS, {
      subject_token: idJag,
      subject_token_type: ID_JAG_TYPE,
      resource: DATA_STORAGE,
    })
    expect(exchange.status).toBe(200)
    const tokens = (await exchange.json()) as Record<string, unknown>
    const accessToken = String(tokens.access_token)
    expect(decodeJwt(accessToken)).toMatchObject({
      '@context': ODRL_ID_JAG_CONTEXT,
      access: claim,
    })

    const read = await fetch(`${DATA_STORAGE}k3pqsb`, {
      headers: { accept: 'text/turtle', authorization: `Bearer ${accessToken}` },
    })
    expect(read.status).toBe(200)
  })

  test('rejects a claim spanning two storages', async () => {
    const twoStorages = [
      ...claim,
      ...grantAccess({
        scopeOfGrant: INTEROP.AllFromRegistry,
        owner: WEBID,
        storage: REGISTRY_STORAGE,
        hasDataRegistration: 'https://registry/alice/grant/',
        registeredShapeTree: 'https://data/shapetrees/trees/Project',
        assigner: WEBID,
        assignee: CLIENT,
        actions: [ODRL.read],
      }),
    ]
    const response = await requestIdJag({
      overrides: { access: JSON.stringify(twoStorages) },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_request')
  })
})

describe('two-step chain from the client (@elfpavlik/lws-auth)', () => {
  test('reads a data and a registry resource, one grant per authorization server', async () => {
    const fetch = await buildLwsFetch(WEBID, CLIENT, { idJag: true })

    const data = await fetch(`${DATA_STORAGE}k3pqsb`, { headers: { accept: 'text/turtle' } })
    expect(data.status).toBe(200)
    expect(data.headers.get('content-type')).toEqual(expect.stringContaining('text/turtle'))

    // A storage on the *other* authorization server: a second ID-JAG, a second
    // access token. The structural registry denies this client by policy (403) —
    // what matters here is that it is a 403 and not a 401: an absent or invalid
    // token would have been rejected by the access-token extractor.
    const registry = await fetch(`${REGISTRY_STORAGE}vzp6ky`, {
      headers: { accept: 'text/turtle' },
    })
    expect(registry.status).toBe(403)

    // the access token is cached per storage: no new 401 round trip
    const again = await fetch(`${DATA_STORAGE}k3pqsb`, { headers: { accept: 'text/turtle' } })
    expect(again.status).toBe(200)
  })
})

describe('C2 impersonation through @elfpavlik/lws-auth', () => {
  const bob = 'https://id/bob'
  const yoyo = 'https://id/yoyo'
  const claim = grantAccess({
    scopeOfGrant: INTEROP.SelectedFromRegistry,
    owner: 'https://id/acme',
    storage: 'https://data/acme-rnd/',
    hasDataRegistration: 'https://data/acme-rnd/reb39k',
    hasDataInstance: ['https://data/acme-rnd/pbh2yw'],
    registeredShapeTree: 'https://data/shapetrees/trees/Project',
    assigner: yoyo,
    assignee: bob,
    actions: [ODRL.read],
  })

  test('delegation mode reads the same project with a visible actor chain', async () => {
    const storageFetch = await buildLwsFetch(bob, undefined, {
      idJag: true,
      impersonation: { uas: AUTH, mode: 'delegation' },
      accessClaim: () => claim,
    })

    const response = await storageFetch('https://data/acme-rnd/pbh2yw', {
      headers: { accept: 'text/turtle' },
    })
    expect(response.status).toBe(200)
  })

  test('Bob -> YoYo -> ACME reads a narrowed project', async () => {
    const storageFetch = await buildLwsFetch(bob, undefined, {
      idJag: true,
      impersonation: { uas: AUTH },
      accessClaim: () => claim,
    })

    const response = await storageFetch('https://data/acme-rnd/pbh2yw', {
      headers: { accept: 'text/turtle' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toEqual(expect.stringContaining('text/turtle'))
  })
})

describe('browser credential endpoint (C5)', () => {
  test('serves /.sai/id-token and refuses anonymous callers', async () => {
    const response = await fetch(`${AUTH}.sai/id-token?dpop_jkt=abc`)
    // a registered route with the regular credentials extractor: an anonymous
    // caller is refused by the handler (a missing route would be a 404)
    expect(response.status).toBe(403)
  })
})
