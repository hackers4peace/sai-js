import { ACL, INTEROP, buildOidcSession, issuanceUrl } from '@elfpavlik/sai-components'
import { describe, expect, test } from 'vitest'
import { SOLIDTREES } from './vocabularies'

const bobId = 'https://id/bob'
const acmeId = 'https://id/acme'
const testClient = 'https://data/test-client/public/id'

describe('DelegationIssuanceEndpoint', () => {
  describe('agent delegates to application', (): void => {
    test('happy path', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const grantData = {
        grantedBy: bobId,
        dataOwner: acmeId,
        grantee: testClient,
        registeredShapeTree: SOLIDTREES.Project,
        hasStorage: 'https://data/acme-rnd/',
        hasDataRegistration: 'https://data/acme-rnd/reb39k/',
        accessMode: [ACL.Read, ACL.Update],
        scopeOfGrant: INTEROP.AllFromRegistry,
      }
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        body: JSON.stringify(grantData),
      })
      console.log(await response.text())
      expect(response.status).toBe(201)
      const location = response.headers.get('location')
      expect(location).toBeDefined()
      expect(location).toMatch('https://registry/acme/grant/')
    })
    test('invalid grantedBy', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const grantData = {
        grantedBy: 'https://id/kim',
        dataOwner: acmeId,
        grantee: testClient,
      }
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        body: JSON.stringify(grantData),
      })
      expect(response.status).toBe(400)
    })
  })
})
