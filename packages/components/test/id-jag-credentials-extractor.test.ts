import { NotImplementedHttpError } from '@solid/community-server'
import type {
  HttpRequest,
  SubjectTokenVerifierInput,
  VerifiedSubject,
} from '@solid/community-server'
import { describe, expect, test, vi } from 'vitest'

import { IdJagCredentialsExtractor } from '../src/IdJagCredentialsExtractor.js'
import { ID_JAG_TOKEN_TYPE } from '../src/IdJagIssuer.js'

const BASE_URL = 'https://auth/'

function request(headers: Record<string, string> = {}): HttpRequest {
  return { headers } as HttpRequest
}

function stubVerifier(result: VerifiedSubject) {
  return {
    handleSafe: vi.fn(async (_input: SubjectTokenVerifierInput) => result),
  }
}

describe('IdJagCredentialsExtractor', () => {
  test('extracts the verified ID-JAG subject as the agent', async () => {
    const verifier = stubVerifier({
      subject: 'https://id/alice',
      issuer: 'https://auth/',
      client: 'https://data/test-client/public/id',
      access: [{ id: 'urn:claim' }],
      accessContext: 'https://example/context',
    })
    const extractor = new IdJagCredentialsExtractor(verifier, BASE_URL)

    await expect(
      extractor.canHandle(request({ authorization: 'Bearer id-jag' }))
    ).resolves.toBeUndefined()
    await expect(extractor.handle(request({ authorization: 'Bearer id-jag' }))).resolves.toEqual({
      agent: { webId: 'https://id/alice' },
      client: { clientId: 'https://data/test-client/public/id' },
      issuer: { url: 'https://auth/' },
      access: [{ id: 'urn:claim' }],
      accessContext: 'https://example/context',
    })
    expect(verifier.handleSafe).toHaveBeenCalledWith({
      token: 'id-jag',
      tokenType: ID_JAG_TOKEN_TYPE,
      audience: BASE_URL,
    })
  })

  test('omits the access claim when the ID-JAG has none', async () => {
    const verifier = stubVerifier({
      subject: 'https://id/alice',
      issuer: 'https://auth/',
      client: 'https://data/test-client/public/id',
    })
    const extractor = new IdJagCredentialsExtractor(verifier, BASE_URL)

    const credentials = await extractor.handle(request({ authorization: 'bearer id-jag' }))
    expect(credentials).not.toHaveProperty('access')
    expect(credentials).not.toHaveProperty('accessContext')
  })

  test('does not claim requests without a Bearer token (public fallback)', async () => {
    const extractor = new IdJagCredentialsExtractor(stubVerifier({} as VerifiedSubject), BASE_URL)
    await expect(extractor.canHandle(request())).rejects.toThrow(NotImplementedHttpError)
    await expect(
      extractor.canHandle(request({ authorization: 'Basic dXNlcjpwYXNz' }))
    ).rejects.toThrow(NotImplementedHttpError)
  })
})
