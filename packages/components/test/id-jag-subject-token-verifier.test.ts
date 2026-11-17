import { ODRL_ID_JAG_CONTEXT } from '@janeirodigital/interop-utils'
import type {
  RepresentationConverter,
  SubjectTokenVerifierInput,
  VerifiedSubject,
} from '@solid/community-server'
import {
  BadRequestHttpError,
  NotImplementedHttpError,
  StatusWaterfallHandler,
  SubjectTokenVerifier,
} from '@solid/community-server'
import type { GenerateKeyPairResult, JWTVerifyGetKey } from 'jose'
import { SignJWT, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'

import { ID_JAG_JWT_TYPE, ID_JAG_TOKEN_TYPE } from '../src/IdJagIssuer.js'
import type { IdJagSubjectTokenVerifierArgs } from '../src/IdJagSubjectTokenVerifier.js'
import { IdJagSubjectTokenVerifier } from '../src/IdJagSubjectTokenVerifier.js'
import { CLAIM_OTHER_STORAGE, CLAIM_STORAGE, idJagClaim } from './access-claim-helpers.js'

const UAS = 'https://auth/'
const RESOURCE_AS = 'https://data/'
const OTHER_AS = 'https://registry/'
const WEBID = 'https://id/alice'
const CLIENT = 'https://data/test-client/public/id'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

let keys: GenerateKeyPairResult

interface Claims {
  iss?: string
  aud?: string | string[]
  sub?: string
  client_id?: string
  typ?: string
  exp?: number
  access?: unknown
  '@context'?: string
  act?: unknown
}

async function makeGrant(overrides: Claims = {}): Promise<string> {
  const { typ = ID_JAG_JWT_TYPE, exp, ...rest } = overrides
  const builder = new SignJWT({
    sub: WEBID,
    client_id: CLIENT,
    ...rest,
  })
    .setProtectedHeader({ alg: 'ES256', typ })
    .setIssuer(rest.iss ?? UAS)
    .setAudience(rest.aud ?? RESOURCE_AS)
    .setIssuedAt()
    .setJti('c0ffee00-0000-4000-8000-000000000000')
  builder.setExpirationTime(exp ?? Math.floor(Date.now() / 1000) + 300)
  return builder.sign(keys.privateKey)
}

/** The verifier with the network-facing parts swapped for local stand-ins. */
class TestVerifier extends IdJagSubjectTokenVerifier {
  public documents: string[] = []

  public constructor(args: Partial<IdJagSubjectTokenVerifierArgs> = {}) {
    super({
      converter: {} as RepresentationConverter,
      trustedIssuers: [UAS],
      ...args,
    })
  }

  protected async getKeySet(): Promise<JWTVerifyGetKey> {
    return keys.publicKey as unknown as JWTVerifyGetKey
  }

  protected async verifySubjectDocument(subject: string, issuer: string): Promise<void> {
    this.documents.push(`${subject} ${issuer}`)
  }
}

class StubIdTokenVerifier extends SubjectTokenVerifier {
  public async canHandle({ tokenType }: SubjectTokenVerifierInput): Promise<void> {
    if (tokenType !== ID_TOKEN_TYPE) {
      throw new NotImplementedHttpError(`Unsupported token type ${tokenType}`)
    }
  }

  public async handle(): Promise<VerifiedSubject> {
    return { subject: WEBID, issuer: UAS, client: CLIENT }
  }
}

function input(
  token: string,
  overrides: Partial<SubjectTokenVerifierInput> = {}
): SubjectTokenVerifierInput {
  return { token, tokenType: ID_JAG_TOKEN_TYPE, audience: RESOURCE_AS, ...overrides }
}

beforeAll(async () => {
  keys = await generateKeyPair('ES256', { extractable: true })
})

describe('IdJagSubjectTokenVerifier', () => {
  test('accepts an ID-JAG of this authorization server', async () => {
    const verifier = new TestVerifier()
    await expect(verifier.handleSafe(input(await makeGrant()))).resolves.toEqual({
      subject: WEBID,
      issuer: UAS,
      client: CLIENT,
    })
  })

  test('pins the JWT type, so an ID token cannot be replayed as a grant', async () => {
    const verifier = new TestVerifier()
    // Same claims, same signer — only the type differs: this is what a leaked
    // ID token (or an access token) would look like at this endpoint.
    await expect(verifier.handleSafe(input(await makeGrant({ typ: 'JWT' })))).rejects.toThrow(
      BadRequestHttpError
    )
    await expect(verifier.handleSafe(input(await makeGrant({ typ: 'at+jwt' })))).rejects.toThrow(
      'An ID-JAG needs the oauth-id-jag+jwt type.'
    )
  })

  test('rejects a grant minted for another authorization server', async () => {
    const verifier = new TestVerifier()
    await expect(verifier.handleSafe(input(await makeGrant({ aud: OTHER_AS })))).rejects.toThrow(
      BadRequestHttpError
    )
    // an array-valued `aud` that includes this server is fine
    await expect(
      verifier.handleSafe(input(await makeGrant({ aud: [OTHER_AS, RESOURCE_AS] })))
    ).resolves.toMatchObject({ subject: WEBID })
  })

  test('requires the client and temporal claims', async () => {
    const verifier = new TestVerifier()
    const { client_id: _client, ...withoutClient } = { client_id: CLIENT }
    const noClient = await new SignJWT({ sub: WEBID, ...withoutClient })
      .setProtectedHeader({ alg: 'ES256', typ: ID_JAG_JWT_TYPE })
      .setIssuer(UAS)
      .setAudience(RESOURCE_AS)
      .setIssuedAt()
      .setJti('c0ffee00-0000-4000-8000-000000000000')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(keys.privateKey)
    await expect(verifier.handleSafe(input(noClient))).rejects.toThrow(BadRequestHttpError)

    const expired = await makeGrant({ exp: Math.floor(Date.now() / 1000) - 120 })
    await expect(verifier.handleSafe(input(expired))).rejects.toThrow(BadRequestHttpError)
  })

  test('verifies the ODRL access claim and returns it for the access token', async () => {
    const verifier = new TestVerifier()
    const claim = idJagClaim({ assignee: WEBID })
    const result = await verifier.handleSafe(
      input(await makeGrant({ access: claim, '@context': ODRL_ID_JAG_CONTEXT }), {
        resource: CLAIM_STORAGE,
      })
    )
    expect(result).toMatchObject({
      subject: WEBID,
      access: claim,
      accessContext: ODRL_ID_JAG_CONTEXT,
    })
  })

  test('rejects an access claim assigned to another subject', async () => {
    const verifier = new TestVerifier()
    await expect(
      verifier.handleSafe(
        input(
          await makeGrant({
            access: idJagClaim({ assignee: 'https://id/mallory' }),
            '@context': ODRL_ID_JAG_CONTEXT,
          }),
          { resource: CLAIM_STORAGE }
        )
      )
    ).rejects.toThrow('assigned to')
  })

  test('rejects an access claim without the bundled context', async () => {
    const verifier = new TestVerifier()
    await expect(
      verifier.handleSafe(
        input(
          await makeGrant({
            access: idJagClaim({ assignee: WEBID }),
            '@context': 'https://context.example/unknown',
          }),
          { resource: CLAIM_STORAGE }
        )
      )
    ).rejects.toThrow(ODRL_ID_JAG_CONTEXT)
  })

  test('rejects an access claim spanning more than one storage', async () => {
    const verifier = new TestVerifier()
    const claim = [
      ...idJagClaim({ assignee: WEBID }),
      ...idJagClaim({ assignee: WEBID, storage: CLAIM_OTHER_STORAGE }),
    ]
    await expect(
      verifier.handleSafe(
        input(await makeGrant({ access: claim, '@context': ODRL_ID_JAG_CONTEXT }), {
          resource: CLAIM_STORAGE,
        })
      )
    ).rejects.toThrow('same lws:storage')
  })

  test('binds the access claim to the exchanged resource', async () => {
    const verifier = new TestVerifier()
    await expect(
      verifier.handleSafe(
        input(
          await makeGrant({
            access: idJagClaim({ assignee: WEBID }),
            '@context': ODRL_ID_JAG_CONTEXT,
          }),
          { resource: CLAIM_OTHER_STORAGE }
        )
      )
    ).rejects.toThrow('not the requested storage')
  })

  test('verifies and returns the actor chain', async () => {
    const verifier = new TestVerifier()
    const act = { sub: WEBID, act: { sub: CLIENT } }
    const result = await verifier.handleSafe(input(await makeGrant({ act })))
    expect(result).toMatchObject({ subject: WEBID, act })
  })

  test('rejects a malformed actor chain', async () => {
    const verifier = new TestVerifier()
    await expect(
      verifier.handleSafe(input(await makeGrant({ act: { sub: 'not-a-uri' } })))
    ).rejects.toThrow('Every actor chain entry needs an HTTP(S) sub.')
    await expect(
      verifier.handleSafe(input(await makeGrant({ act: { sub: WEBID, act: 'nested' } })))
    ).rejects.toThrow('The actor chain needs to be an object.')
  })

  test('falls back to the subject document for an untrusted issuer', async () => {
    const verifier = new TestVerifier({ trustedIssuers: [] })
    await expect(verifier.handleSafe(input(await makeGrant()))).resolves.toMatchObject({
      subject: WEBID,
    })
    expect(verifier.documents).toEqual([`${WEBID} ${UAS}`])
  })

  test('only claims the id-jag subject token type', async () => {
    const verifier = new TestVerifier()
    await expect(verifier.canHandle(input(''))).resolves.toBeUndefined()
    await expect(verifier.canHandle(input('', { tokenType: ID_TOKEN_TYPE }))).rejects.toThrow(
      NotImplementedHttpError
    )
  })

  test('leaves the id_token exchange to the OIDC suite (waterfall order)', async () => {
    // Mirrors the configured `StatusWaterfallHandler`: ours is inserted first,
    // must decline `id_token`, and the OIDC verifier answers unchanged.
    const waterfall = new StatusWaterfallHandler<SubjectTokenVerifierInput, VerifiedSubject>([
      new TestVerifier(),
      new StubIdTokenVerifier(),
    ])
    await expect(
      waterfall.handleSafe({
        token: 'an-id-token',
        tokenType: ID_TOKEN_TYPE,
        audience: RESOURCE_AS,
      })
    ).resolves.toEqual({ subject: WEBID, issuer: UAS, client: CLIENT })
    await expect(
      waterfall.handleSafe({
        token: await makeGrant(),
        tokenType: ID_JAG_TOKEN_TYPE,
        audience: RESOURCE_AS,
      })
    ).resolves.toMatchObject({ subject: WEBID })
  })
})
