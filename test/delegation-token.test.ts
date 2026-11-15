import { buildSelfIssuedCredential } from '@elfpavlik/sai-components'
import { grantAccess } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  ODRL,
  ODRL_ID_JAG_CONTEXT,
  createLwsTokenDpopProof,
} from '@janeirodigital/interop-utils'
import { decodeJwt } from 'jose'
import { describe, expect, test } from 'vitest'

/*
 * C3 delegation mode (docs/plans/id-jag.md): the same Bob -> YoYo -> ACME
 * chain as C2, but the actor chain stays visible.
 *
 *   final sub      = YoYo (top-level requester / claim assigner)
 *   final client   = Bob's UAS/client (most nested act)
 *   final act      = { sub: Bob, act: { sub: Bob's client } }
 *   final claim    = YoYo -> Bob's client
 */

const AUTH = process.env.CSS_BASE_URL ?? 'https://auth/'
const TOKEN_ENDPOINT = new URL('.well-known/lws/token', AUTH).href
const DATA_AS = 'https://data/'
const DATA_STORAGE = 'https://data/acme-rnd/'
const DATA_RESOURCE = 'https://data/acme-rnd/pbh2yw'
const DATA_REGISTRATION = 'https://data/acme-rnd/reb39k'
const SHAPE_TREE = 'https://data/shapetrees/trees/Project'
const BOB = 'https://id/bob'
const YOYO = 'https://id/yoyo'
const ACME = 'https://id/acme'

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ID_JAG_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

const claim = grantAccess({
  scopeOfGrant: INTEROP.SelectedFromRegistry,
  owner: ACME,
  storage: DATA_STORAGE,
  hasDataRegistration: DATA_REGISTRATION,
  hasDataInstance: [DATA_RESOURCE],
  registeredShapeTree: SHAPE_TREE,
  assigner: YOYO,
  assignee: BOB,
  actions: [ODRL.read],
})

async function exchange(params: Record<string, string>, dpop?: string): Promise<Response> {
  return fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(dpop ? { dpop } : {}),
    },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      requested_token_type: ID_JAG_TYPE,
      ...params,
    }).toString(),
  })
}

async function mintIdJag(body: Record<string, unknown>): Promise<string> {
  expect(body.issued_token_type).toBe(ID_JAG_TYPE)
  return String(body.access_token)
}

describe('C3 delegation token chain', () => {
  test('keeps the actor chain and re-issues the claim to the final client', async () => {
    const bob = await buildSelfIssuedCredential(BOB)
    const subjectToken = await bob.oidc.generateSelfIssuedAccessToken()

    const firstResponse = await exchange(
      {
        audience: AUTH,
        subject_token: subjectToken,
        subject_token_type: ID_TOKEN_TYPE,
        access: JSON.stringify(claim),
      },
      await createLwsTokenDpopProof(TOKEN_ENDPOINT, bob.dpopKeyPair)
    )
    expect(firstResponse.status).toBe(200)
    const first = await mintIdJag((await firstResponse.json()) as Record<string, unknown>)

    const secondResponse = await exchange({
      audience: DATA_AS,
      resource: DATA_STORAGE,
      subject_token: first,
      subject_token_type: ID_JAG_TYPE,
      mode: 'delegation',
    })
    expect(secondResponse.status).toBe(200)
    const second = await mintIdJag((await secondResponse.json()) as Record<string, unknown>)
    const secondPayload = decodeJwt(second)
    expect(secondPayload).toMatchObject({
      iss: AUTH,
      aud: DATA_AS,
      sub: YOYO,
      client_id: bob.clientId,
      '@context': ODRL_ID_JAG_CONTEXT,
      act: { sub: BOB, act: { sub: bob.clientId } },
    })
    const permission = (secondPayload.access as any[])[0].permission[0]
    expect(permission).toMatchObject({
      assigner: YOYO,
      assignee: bob.clientId,
      action: claim[0].permission[0].action,
    })

    const tokenResponse = await fetch(new URL('.well-known/lws/token', DATA_AS).href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: second,
        subject_token_type: ID_JAG_TYPE,
        resource: DATA_STORAGE,
      }).toString(),
    })
    expect(tokenResponse.status).toBe(200)
    const tokens = (await tokenResponse.json()) as Record<string, unknown>
    const accessToken = String(tokens.access_token)
    const accessPayload = decodeJwt(accessToken)
    expect(accessPayload).toMatchObject({
      iss: DATA_AS,
      aud: DATA_STORAGE,
      sub: YOYO,
      client_id: bob.clientId,
      '@context': ODRL_ID_JAG_CONTEXT,
      act: secondPayload.act,
    })

    const read = await fetch(DATA_RESOURCE, {
      headers: { accept: 'text/turtle', authorization: `Bearer ${accessToken}` },
    })
    expect(read.status).toBe(200)
  })

  test('rejects an unknown mode', async () => {
    const bob = await buildSelfIssuedCredential(BOB)
    const subjectToken = await bob.oidc.generateSelfIssuedAccessToken()
    const firstResponse = await exchange(
      {
        audience: AUTH,
        subject_token: subjectToken,
        subject_token_type: ID_TOKEN_TYPE,
        access: JSON.stringify(claim),
      },
      await createLwsTokenDpopProof(TOKEN_ENDPOINT, bob.dpopKeyPair)
    )
    const first = await mintIdJag((await firstResponse.json()) as Record<string, unknown>)

    const response = await exchange({
      audience: DATA_AS,
      resource: DATA_STORAGE,
      subject_token: first,
      subject_token_type: ID_JAG_TYPE,
      mode: 'sideways',
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_request')
  })
})
