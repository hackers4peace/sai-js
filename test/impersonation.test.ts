import { createDpopProof } from '@elfpavlik/lws-auth'
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

import { loginAsClient } from './oidc-client.ts'

/*
 * Impersonation (openwiki/architecture/id-jag-access-claims.md):
 *
 *   App --at+jwt-->
 *   Bob's UAS --ID-JAG(aud=YoYo's UAS, claim YoYo -> Bob)-->
 *   YoYo's UAS --ID-JAG(aud=data, sub=YoYo, claim YoYo -> auth)--> ACME's AS
 *
 * Bob and his client must not appear in the second ID-JAG or the access token;
 * ACME only sees YoYo and the narrowed ODRL claim.
 *
 * The happy path acts as a real **app**: it signs in through the OIDC code flow
 * (PKCE + `dpop_jkt`), mints the DPoP-bound LWS credential with itself as
 * `client_id`, and drives both ID-JAG hops. The app only names the storage;
 * Bob's UAS finds the pre-existing YoYo -> Bob grant in Bob's registry-pod
 * dataset and adds it as the access claim. The two rejection tests keep the
 * cheaper self-issued credential — they only exercise the UAS checks.
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
/** The app acting for Bob: the `test-client` metadata document, served by `data`. */
const TEST_CLIENT = 'https://data/test-client/public/id'
const BOB_EMAIL = 'bob@yoyodyne.example'

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ID_JAG_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

/** The delegated grant Bob holds: YoYo -> Bob, narrowed to one ACME project. */
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

describe('C2 impersonation chain', () => {
  test('Bob -> YoYo -> ACME hides Bob and the delegated grant references', async () => {
    // The app signs Bob in through the OP (`auth` is both UAS and OP): code +
    // PKCE bound to the app's key, and the session's access token is the LWS
    // credential — `aud` is `auth` itself and `client_id` names the app, so no
    // in-process signing with the env key is involved.
    const app = await loginAsClient({ webid: BOB, email: BOB_EMAIL, clientId: TEST_CLIENT })
    const subjectToken = app.subjectToken
    const dpop = await createDpopProof({
      method: 'POST',
      url: TOKEN_ENDPOINT,
      keyPair: app.keyPair,
    })
    expect(app.credentialClaims).toMatchObject({
      iss: AUTH,
      aud: AUTH,
      sub: BOB,
      webid: BOB,
      client_id: TEST_CLIENT,
      cnf: { jkt: app.dpopJkt },
    })

    // The app only names the storage. Bob's UAS derives the claim from the
    // pre-existing delegated grant YoYo -> Bob for that storage (the grant is
    // mirrored into Bob's registry-pod dataset).
    const firstResponse = await exchange(
      {
        audience: AUTH,
        resource: DATA_STORAGE,
        subject_token: subjectToken,
        subject_token_type: app.subjectTokenType,
      },
      dpop
    )
    expect(firstResponse.status).toBe(200)
    const first = await mintIdJag((await firstResponse.json()) as Record<string, unknown>)
    const firstPayload = decodeJwt(first)
    expect(firstPayload).toMatchObject({
      iss: AUTH,
      aud: AUTH,
      sub: BOB,
      client_id: TEST_CLIENT,
      '@context': ODRL_ID_JAG_CONTEXT,
    })
    const derived = (firstPayload.access as Array<any>)[0]
    expect(derived).toMatchObject({
      assignee: BOB,
      profile: claim[0].profile,
      scopeOfGrant: claim[0].scopeOfGrant,
      permission: [
        expect.objectContaining({
          assignee: BOB,
          action: claim[0].permission[0].action,
          target: expect.objectContaining({
            owner: claim[0].permission[0].target.owner,
            storage: claim[0].permission[0].target.storage,
            type: claim[0].permission[0].target.type,
            source: claim[0].permission[0].target.source,
          }),
        }),
      ],
    })
    expect(derived).not.toHaveProperty('assigner')
    expect(derived.permission[0]).not.toHaveProperty('assigner')

    // YoYo's UAS verifies the incoming ID-JAG, rewrites the claim to the
    // visible actor, and issues the storage grant. No request `access` claim
    // is allowed on this hop.
    const secondResponse = await exchange({
      audience: DATA_AS,
      resource: DATA_STORAGE,
      subject_token: first,
      subject_token_type: ID_JAG_TYPE,
    })
    expect(secondResponse.status).toBe(200)
    const second = await mintIdJag((await secondResponse.json()) as Record<string, unknown>)
    const secondPayload = decodeJwt(second)
    expect(secondPayload).toMatchObject({
      iss: AUTH,
      aud: DATA_AS,
      sub: YOYO,
      client_id: AUTH,
      '@context': ODRL_ID_JAG_CONTEXT,
    })
    const rewritten = (secondPayload.access as Array<any>)[0]
    const original = claim[0]
    expect(rewritten).toMatchObject({
      assignee: YOYO,
      profile: original.profile,
      scopeOfGrant: original.scopeOfGrant,
      permission: [
        {
          assignee: YOYO,
          action: original.permission[0].action,
          target: expect.objectContaining({
            owner: original.permission[0].target.owner,
            storage: original.permission[0].target.storage,
            type: original.permission[0].target.type,
            source: original.permission[0].target.source,
          }),
        },
      ],
    })
    expect(rewritten).not.toHaveProperty('assigner')
    expect(rewritten.permission[0]).not.toHaveProperty('assigner')
    expect(rewritten.id).toMatch(/^urn:uuid:/u)
    expect(rewritten.permission[0].id).toMatch(/^urn:uuid:/u)
    const serialized = JSON.stringify(secondPayload)
    expect(serialized).not.toContain(BOB)
    expect(serialized).not.toContain(TEST_CLIENT)
    expect(serialized).not.toContain('"act"')

    // ACME's AS exchanges the visible ID-JAG for a storage access token.
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
      client_id: AUTH,
      '@context': ODRL_ID_JAG_CONTEXT,
    })
    expect(JSON.stringify(accessPayload)).not.toContain(BOB)
    expect(JSON.stringify(accessPayload)).not.toContain(TEST_CLIENT)

    // The claim-first policy engine grants the narrowed project.
    const read = await fetch(DATA_RESOURCE, {
      headers: { accept: 'text/turtle', authorization: `Bearer ${accessToken}` },
    })
    expect(read.status).toBe(200)
  })

  test('issues an identity-only ID-JAG when the user has no grant for the storage', async () => {
    const bob = await buildSelfIssuedCredential(BOB)
    const subjectToken = await bob.oidc.generateSelfIssuedAccessToken()

    // `kim-red` is a storage on the same data server, but the seed holds no grant
    // for Bob there: the derivation finds nothing and the UAS mints an
    // identity-only ID-JAG instead of inventing a claim.
    const firstResponse = await exchange(
      {
        audience: AUTH,
        resource: 'https://data/kim-red/',
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
      },
      await createLwsTokenDpopProof(TOKEN_ENDPOINT, bob.dpopKeyPair)
    )
    expect(firstResponse.status).toBe(200)
    const first = await mintIdJag((await firstResponse.json()) as Record<string, unknown>)
    expect(decodeJwt(first).access).toBeUndefined()

    // The next UAS needs the claim the client never got.
    const secondResponse = await exchange({
      audience: DATA_AS,
      resource: 'https://data/kim-red/',
      subject_token: first,
      subject_token_type: ID_JAG_TYPE,
    })
    expect(secondResponse.status).toBe(400)
    expect((await secondResponse.json()) as Record<string, unknown>).toMatchObject({
      error: 'invalid_request',
    })
  })
})
