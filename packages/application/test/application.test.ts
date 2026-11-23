import { randomUUID } from 'node:crypto'

import { FlatIdentifierStrategy } from '@janeirodigital/interop-utils'
import { describe, expect, test, vi } from 'vitest'

import { Application } from '../src'
import { statelessFetch } from './mock-fetch.ts'

const webId = 'https://alice.example/#id'
const applicationId = 'https://projectron.example/'

const linkString = `
  <https://projectron.example/#app>;
  anchor="https://auth.alice.example/bcf22534-0187-4ae4-b88f-fe0f9fa96659";
  rel="http://www.w3.org/ns/solid/interop#registeredAgent"
`

describe('applicatrion registration exists', () => {
  const mocked = vi.fn(statelessFetch)
  const responseMock = {
    ok: true,
    headers: { get: (name: string): string | null => (name === 'Link' ? linkString : null) },
  } as unknown as Response
  responseMock.clone = () => Object.assign({}, responseMock)

  test('should build application registration if discovered', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    expect(app.applicationRegistration?.id).toBe(
      'https://auth.alice.example/bcf22534-0187-4ae4-b88f-fe0f9fa96659'
    )
    expect(app.applicationRegistration?.registeredAgent).toBe('https://projectron.example/#app')
  })

  test('should have dataOwners getter', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    const owners = await app.getDataOwnersAsync()
    expect(owners).toHaveLength(3)
    for (const owner of owners) {
      expect(owner.id).toBeTypeOf('string')
      expect(Array.isArray(owner.issuedGrants)).toBe(true)
      for (const grant of owner.issuedGrants) {
        expect(grant.dataOwner).toBe(owner.id)
      }
    }
  })
})
describe('discovery helpers', () => {
  const expectedRedirectUriBase = 'https://auth.example/authorize'
  const mocked = vi.fn(statelessFetch)
  const responseMock = { ok: true, headers: { get: (): null => null } } as unknown as Response
  responseMock.clone = () => Object.assign({}, responseMock)

  test('should not build appliction registration if not discovered', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    expect(app.applicationRegistration).toBeUndefined()
  })

  test('should have authorizationRedirectEndpoint discovered', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    expect(app.authorizationRedirectEndpoint).toBe(expectedRedirectUriBase)
  })

  test('should have correct authorizationRedirectUri', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    expect(app.authorizationRedirectUri).toBe(
      `${expectedRedirectUriBase}?client_id=${encodeURIComponent(applicationId)}`
    )
  })

  test('should have dataOwners getter returning an empty array', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    expect(app.dataOwners).toHaveLength(0)
  })

  // TODO: refactor to be independent from order of query parameters
  test('should provide shareUri', async () => {
    mocked.mockResolvedValueOnce(await statelessFetch(webId)).mockResolvedValueOnce(responseMock)
    const app = await Application.build(webId, applicationId, { fetch: mocked, randomUUID })
    const resourceUri = 'some-resource-uri'
    const shareUri = app.getShareUri(resourceUri)
    expect(shareUri).toBe(
      `${expectedRedirectUriBase}?resource=${encodeURIComponent(resourceUri)}&client_id=${encodeURIComponent(
        applicationId
      )}`
    )
  })
})

describe('iriForNew', () => {
  const uuid = '6f1e6c1e-0000-4000-8000-000000000000'
  const scope = 'https://trees.example/Project'
  const storage = 'https://data.alice.example/'
  const registration = 'https://data.alice.example/reg'

  const stubGrant = (app: Application, dataRegistration: string): void => {
    vi.spyOn(app, 'getDataOwnersAsync').mockResolvedValue([
      {
        id: webId,
        issuedGrants: [
          {
            storage,
            hasDataRegistration: dataRegistration,
            registeredShapeTree: scope,
          },
        ],
      },
    ] as never)
  }

  test('mints a flat IRI at the storage root and POSTs its UUID as the Slug', async () => {
    const flatIri = `${storage}${uuid}`
    const mocked = vi.fn(
      async () =>
        ({
          ok: true,
          headers: { get: (name: string) => (name === 'Location' ? flatIri : null) },
        }) as unknown as Response
    )
    const app = new Application(webId, applicationId, { fetch: mocked, randomUUID: () => uuid })
    stubGrant(app, registration)
    const resolve = vi.spyOn(app.identifierStrategies, 'resolve').mockResolvedValue({
      storageUrl: storage,
      storageRoot: storage,
      strategy: new FlatIdentifierStrategy(storage, () => uuid),
    })

    await expect(app.iriForNew(storage, scope)).resolves.toBe(flatIri)
    expect(resolve).toHaveBeenCalledWith(storage)
    expect(mocked).toHaveBeenCalledWith(
      registration,
      expect.objectContaining({
        method: 'POST',
        body: '[]',
        headers: expect.objectContaining({ slug: uuid }),
      })
    )
  })
})
