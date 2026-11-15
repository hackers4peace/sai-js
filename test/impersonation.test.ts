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
 * C2 impersonation (docs/plans/id-jag.md):
 *
 *   Bob's UAS --ID-JAG(aud=auth, claim YoYo -> Bob)--> YoYo's UAS
 *            --ID-JAG(aud=data, sub=YoYo, claim YoYo -> auth)--> ACME's AS
 *
 * Bob and his client must not appear in the second ID-JAG or the access token;
 * ACME only sees YoYo and the narrowed ODRL claim.
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
    const bob = await buildSelfIssuedCredential(BOB)
    const subjectToken = await bob.oidc.generateSelfIssuedAccessToken()
    const dpop = await createLwsTokenDpopProof(TOKEN_ENDPOINT, bob.dpopKeyPair)

    // Bob's UAS self-issues the first hop for YoYo's UAS. The claim is the
    // delegated grant YoYo -> Bob (assigner != subject is allowed for this hop).
    const firstResponse = await exchange(
      {
        audience: AUTH,
        subject_token: subjectToken,
        subject_token_type: ID_TOKEN_TYPE,
        access: JSON.stringify(claim),
      },
      dpop
    )
    expect(firstResponse.status).toBe(200)
    const first = await mintIdJag((await firstResponse.json()) as Record<string, unknown>)
    expect(decodeJwt(first)).toMatchObject({
      iss: AUTH,
      aud: AUTH,
      sub: BOB,
      client_id: bob.clientId,
      access: claim,
    })

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
    const rewritten = (secondPayload.access as any[])[0]
    const original = claim[0]
    expect(rewritten).toMatchObject({
      assigner: YOYO,
      assignee: AUTH,
      profile: original.profile,
      scopeOfGrant: original.scopeOfGrant,
      permission: [
        {
          assigner: YOYO,
          assignee: AUTH,
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
    expect(rewritten.id).toMatch(/^urn:uuid:/u)
    expect(rewritten.permission[0].id).toMatch(/^urn:uuid:/u)
    const serialized = JSON.stringify(secondPayload)
    expect(serialized).not.toContain(BOB)
    expect(serialized).not.toContain(bob.clientId)
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
    expect(JSON.stringify(accessPayload)).not.toContain(bob.clientId)

    // The claim-first policy engine grants the narrowed project.
    const read = await fetch(DATA_RESOURCE, {
      headers: { accept: 'text/turtle', authorization: `Bearer ${accessToken}` },
    })
    expect(read.status).toBe(200)
  })

  test('rejects an incoming ID-JAG whose claim was issued to another delegatee', async () => {
    const bob = await buildSelfIssuedCredential(BOB)
    const subjectToken = await bob.oidc.generateSelfIssuedAccessToken()
    const wrongClaim = grantAccess({
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      owner: ACME,
      storage: DATA_STORAGE,
      hasDataRegistration: DATA_REGISTRATION,
      hasDataInstance: [DATA_RESOURCE],
      registeredShapeTree: SHAPE_TREE,
      assigner: YOYO,
      assignee: 'https://id/mallory',
      actions: [ODRL.read],
    })

    // Bob's UAS may self-issue a grant assigned to *him*; a claim for another
    // delegatee is rejected before the first ID-JAG exists.
    const response = await exchange(
      {
        audience: AUTH,
        subject_token: subjectToken,
        subject_token_type: ID_TOKEN_TYPE,
        access: JSON.stringify(wrongClaim),
      },
      await createLwsTokenDpopProof(TOKEN_ENDPOINT, bob.dpopKeyPair)
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_request')
  })
})
