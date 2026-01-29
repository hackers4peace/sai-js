import { buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import { beforeAll, describe, expect, test } from 'vitest'

/*
 * Possible dimensions
 * grant: public agent/client, AllFromRegistry, SelectedFromRegistry, Inherited
 * request: unauthenticated, some agent/client, some agent using UAP, authorized agent using unauthorized client, authorized agent using UAP, unauthorized agent using unauthorized cilent, unauthorized agent using authorized (for someone else) client, unauthorized agent using UAP
 * acccess modes: Create allows POST on registry to create new resources (not available for selecdted scope), Read - allows GET on resources and possibly registry depending on scope, Update - allows PUT on all or selected resources depending on scope, Delete - allows DELETE on all or selected resources depending on scope
 */

function getRegistration(id: string) {
  return id.substring(0, id.lastIndexOf('/') + 1)
}

describe('public resources', () => {
  const id = 'https://data/shapetrees/trees/Project'
  describe('unauthenticated request', () => {
    test('can not Create', async () => {
      const response = await fetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(401)
    })
    test('can Read', async () => {
      const response = await fetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
    })
    test('can not Update', async () => {
      const response = await fetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(401)
    })
    test('can not Delete', async () => {
      const response = await fetch(id, {
        method: 'DELETE',
      })
      expect(response.status).toBe(401)
    })
  })

  describe('authenticated request (some agent/client)', () => {
    const bobId = 'https://id/bob'
    const clientId = 'https://data/test-client/public/id'
    let session
    beforeAll(async () => {
      session = await buildOidcSession(bobId, clientId)
    })

    test('can not Create', async () => {
      const response = await session.authFetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(403)
    })
    test('can Read', async () => {
      const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
    })
    test('can not Update', async () => {
      const response = await session.authFetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(403)
    })
    test('can not Delete', async () => {
      const response = await session.authFetch(id, {
        method: 'DELETE',
      })
      expect(response.status).toBe(403)
    })
  })

  describe('authenticated request (some agent using UAS)', () => {
    const bobId = 'https://id/bob'
    let session
    beforeAll(async () => {
      session = await buildOidcSession(bobId)
    })

    test('can not Create', async () => {
      const response = await session.authFetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(403)
    })
    test('can Read', async () => {
      const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
    })
    test('can not Update', async () => {
      const response = await session.authFetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(403)
    })
    test('can not Delete', async () => {
      const response = await session.authFetch(id, {
        method: 'DELETE',
      })
      expect(response.status).toBe(403)
    })
  })
})

describe('protected resources (scope all, modes all)', () => {
  const id = 'https://data/alice-work/sx86hi/k3pqsb'
  describe('protected resource', () => {
    describe('unauthenticated request', () => {
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await fetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Read', async () => {
        const response = await fetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await fetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await fetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (some agent/client)', () => {
      const bobId = 'https://id/bob'
      const clientId = 'https://data/test-client/public/id'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(bobId, clientId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await session.authFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(403)
      })
      test('can not Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(403)
      })
    })

    describe('authenticated request (some agent using UAS)', () => {
      const bobId = 'https://id/bob'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(bobId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await session.authFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(403)
      })
      test('can not Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(403)
      })
    })

    describe('authenticated request (authorized agent / unauthorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://id/mallory'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(aliceId, clientId)
      })
      test('can not Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(403)
      })
      test('can not Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(403)
      })
    })

    describe('authenticated request (authorized agent / authorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://data/test-client/public/id'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(aliceId, clientId)
      })
      test('can Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
      })
      test('can Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(205)
      })
      test('can Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(205)
      })
    })
  })
})

describe('protected resources (scope inherited, modes all)', () => {
  const id = 'https://data/alice-work/btze4a/y48odn'
  describe('protected resource', () => {
    describe('unauthenticated request', () => {
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await fetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Read', async () => {
        const response = await fetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await fetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await fetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (some agent/client)', () => {
      const bobId = 'https://id/bob'
      const clientId = 'https://data/test-client/public/id'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(bobId, clientId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await session.authFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(403)
      })
      test('can not Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(403)
      })
    })

    describe('authenticated request (some agent using UAS)', () => {
      const bobId = 'https://id/bob'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(bobId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await session.authFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(403)
      })
      test('can not Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(403)
      })
    })

    describe('authenticated request (authorized agent / unauthorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://id/mallory'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(aliceId, clientId)
      })
      test('can not Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(403)
      })
      test('can not Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(403)
      })
      test('can not Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(403)
      })
    })

    describe('authenticated request (authorized agent / authorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://data/test-client/public/id'
      let session
      beforeAll(async () => {
        session = await buildOidcSession(aliceId, clientId)
      })
      test('can Create', async () => {
        const containerId = getRegistration(id)
        const newId = `${containerId}h5wpnt`
        const body = `
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          <${newId}>
            rdfs:label "New task" .
        `
        const prematurePutResponse = await session.authFetch(newId, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body,
        })
        expect(prematurePutResponse.status).toBe(403)
        const parentId = 'https://data/alice-work/sx86hi/k3pqsb'
        const patchResponse = await session.authFetch(parentId, {
          method: 'PATCH',
          headers: { 'Content-type': 'application/sparql-update' },
          body: `
          PREFIX pm: <https://vocab.example/project-management/>
          INSERT DATA { <${parentId}> pm:hasTask <${newId}> . }
          `,
        })
        expect(patchResponse.status).toBe(205)
        const putResponse = await session.authFetch(newId, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body,
        })
        expect(putResponse.status).toBe(201)
      })
      test('can Read', async () => {
        const response = await session.authFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
      })
      test('can Update', async () => {
        const response = await session.authFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(205)
      })
      test('can Delete', async () => {
        const response = await session.authFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(205)
      })
    })
  })
})
