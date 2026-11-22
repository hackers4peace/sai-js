import { buildLwsFetch } from '@elfpavlik/sai-components'
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
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(bobId, clientId)
    })

    test('can not Create', async () => {
      const response = await storageFetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(401)
    })
    test('can Read', async () => {
      const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
    })
    test('can not Update', async () => {
      const response = await storageFetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(401)
    })
    test('can not Delete', async () => {
      const response = await storageFetch(id, {
        method: 'DELETE',
      })
      expect(response.status).toBe(401)
    })
  })

  describe('authenticated request (some agent using UAS)', () => {
    const bobId = 'https://id/bob'
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(bobId)
    })

    test('can not Create', async () => {
      const response = await storageFetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(401)
    })
    test('can Read', async () => {
      const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
    })
    test('can not Update', async () => {
      const response = await storageFetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
      })
      expect(response.status).toBe(401)
    })
    test('can not Delete', async () => {
      const response = await storageFetch(id, {
        method: 'DELETE',
      })
      expect(response.status).toBe(401)
    })
  })
})

describe('protected resources (scope all, modes all)', () => {
  const id = 'https://data/alice-work/k3pqsb'
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
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(bobId, clientId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await storageFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (some agent using UAS)', () => {
      const bobId = 'https://id/bob'
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(bobId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await storageFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (authorized agent / unauthorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://id/mallory'
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(aliceId, clientId)
      })
      test('can not Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (authorized agent / authorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://data/test-client/public/id'
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(aliceId, clientId)
      })
      test('can Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
      })
      test('can Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(204)
      })
      test('can Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(204)
      })
    })
  })
})

describe('protected resources (scope inherited, modes all)', () => {
  const id = 'https://data/alice-work/y48odn'
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
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(bobId, clientId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await storageFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (some agent using UAS)', () => {
      const bobId = 'https://id/bob'
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(bobId)
      })
      test('can not Create', async () => {
        const containerId = getRegistration(id)
        const response = await storageFetch(containerId, {
          method: 'POST',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (authorized agent / unauthorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://id/mallory'
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(aliceId, clientId)
      })
      test('can not Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(401)
      })
      test('can not Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(401)
      })
      test('can not Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(401)
      })
    })

    describe('authenticated request (authorized agent / authorized client)', () => {
      const aliceId = 'https://id/alice'
      const clientId = 'https://data/test-client/public/id'
      let storageFetch: typeof fetch
      beforeAll(async () => {
        storageFetch = await buildLwsFetch(aliceId, clientId)
      })
      test('can Create', async () => {
        const body = `
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          <urn:task:new>
            skos:prefLabel "New task" .
        `
        // flat LWS: a resource outside every registration has no type and no
        // containment, so the engine has nothing to authorize — deny
        const uncontainedId = 'https://data/alice-work/h5wpnt'
        const prematurePutResponse = await storageFetch(uncontainedId, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: body.replace('urn:task:new', uncontainedId),
        })
        expect(prematurePutResponse.status).toBe(403)

        // creation goes through the registration container (the Task
        // registration of the inherited-scope chain, `btze4a`): the flat
        // POST-then-PUT the Application's identifier strategy emits, which
        // allocates the member IRI from the storage root via the UUID Slug
        const registrationId = 'https://data/alice-work/btze4a'
        const createResponse = await storageFetch(registrationId, {
          method: 'POST',
          // flat store: the Slug has to be a UUID (`HonorUuidSlugDataAccessorBasedStore`)
          headers: { 'Content-type': 'application/ld+json', slug: crypto.randomUUID() },
          body: '{}',
        })
        expect(createResponse.status).toBe(201)
        const createdId = createResponse.headers.get('location')!
        expect(createdId).toMatch('https://data/alice-work/')

        // Inherited scope: the new member is writable only once the parent
        // instance references it (`findParentResource` walks
        // `<parent> pm:hasTask <child>`)
        const writeBody = body.replace('urn:task:new', createdId)
        const unlinkedPut = await storageFetch(createdId, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: writeBody,
        })
        expect(unlinkedPut.status).toBe(403)

        const parentId = 'https://data/alice-work/k3pqsb'
        const patchResponse = await storageFetch(parentId, {
          method: 'PATCH',
          headers: { 'Content-type': 'application/sparql-update' },
          body: `
          PREFIX pm: <https://vocab.example/project-management/>
          INSERT DATA { <${parentId}> pm:hasTask <${createdId}> . }
          `,
        })
        expect(patchResponse.status).toBe(204)

        const putResponse = await storageFetch(createdId, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: writeBody,
        })
        expect(putResponse.status).toBe(204)
      })
      test('can Read', async () => {
        const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
      })
      test('can Update', async () => {
        const response = await storageFetch(id, {
          method: 'PUT',
          headers: { 'Content-type': 'text/turtle' },
          body: '<urn:foo:bar> <urn:foo:baz> "Beep Boop".',
        })
        expect(response.status).toBe(204)
      })
      test('can Delete', async () => {
        const response = await storageFetch(id, {
          method: 'DELETE',
        })
        expect(response.status).toBe(204)
      })
    })
  })
})

describe('protected resources (scope inherited, parent selected from registry)', () => {
  // Alice's SelectedFromRegistry delegated grant to the test client
  // (`registry/alice/wwp4j6`, data owner ACME) selects only Project X
  // (`pbh2yw`, read-only); the inherited Task grant (`qwvbcu`) hangs off it. The parent grant's target is
  // an `odrl:Asset`: `odrl:source` is the selected instance while
  // `interop:hasDataRegistration` is the containing registration (`reb39k`).
  // The engine must derive the registration from the target, otherwise reading
  // a Task of the selected Project trips the parent-registration check.
  const selectedProject = 'https://data/acme-rnd/pbh2yw'
  const selectedTask = 'https://data/acme-rnd/n7k3zm' // Project X "Z1"
  const unselectedProject = 'https://data/acme-rnd/z8w2pl' // "Matrix"
  const unselectedTask = 'https://data/acme-rnd/m5t7jy' // "Matrix" "M1"
  const aliceId = 'https://id/alice'

  describe('authenticated request (authorized agent / authorized client)', () => {
    const clientId = 'https://data/test-client/public/id'
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(aliceId, clientId)
    })

    test('can Read the selected project', async () => {
      const response = await storageFetch(selectedProject, {
        headers: { Accept: 'text/turtle' },
      })
      expect(response.status).toBe(200)
    })
    test('can Read a task of the selected project', async () => {
      const response = await storageFetch(selectedTask, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toEqual(expect.stringContaining('text/turtle'))
    })
    test('can not Read an unselected project', async () => {
      const response = await storageFetch(unselectedProject, {
        headers: { Accept: 'text/turtle' },
      })
      expect(response.status).toBe(403)
    })
    test('can not Read a task of an unselected project', async () => {
      const response = await storageFetch(unselectedTask, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(403)
    })
  })

  describe('authenticated request (authorized agent using UAS)', () => {
    // `registry/acme/g4yhtm` is the same target shape, granted to Alice as the
    // assignee, so it is matched in UAS mode (as is the inherited `wpqyds`).
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(aliceId)
    })

    test('can Read a task of the selected project', async () => {
      const response = await storageFetch(selectedTask, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
    })
    test('can not Read a task of an unselected project', async () => {
      const response = await storageFetch(unselectedTask, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(403)
    })
  })
})

describe('protected resources (admin grant, scope DataRegistry, mode Read)', () => {
  // YoYo's data registry — Dan holds the Read-only DataRegistry-scoped
  // AdminGrants (ds0emv → yoyo-eu, f76tbp → yoyo-na; step 2.8 of
  // org-admin-feature.md). Structural registries stay on ACP; via the engine,
  // an admin can read the org's data registries/registrations/instances with
  // their own credentials, but never write.
  const registry = 'https://data/yoyo-eu/'
  const registrationId = 'https://data/yoyo-eu/w4n9kx'
  const id = 'https://data/yoyo-eu/x8v2lm'
  const danId = 'https://id/dan'
  const bobId = 'https://id/bob'
  const turtleBody = '<urn:foo:bar> <urn:foo:baz> "Beep Boop".'

  describe('unauthenticated request', () => {
    test('can not Create', async () => {
      const response = await fetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: turtleBody,
      })
      expect(response.status).toBe(401)
    })
    test('can not Read', async () => {
      const response = await fetch(registry, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(401)
    })
    test('can not Update', async () => {
      const response = await fetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: turtleBody,
      })
      expect(response.status).toBe(401)
    })
    test('can not Delete', async () => {
      const response = await fetch(id, { method: 'DELETE' })
      expect(response.status).toBe(401)
    })
  })

  describe('authenticated request (admin, some agent/client)', () => {
    const clientId = 'https://data/test-client/public/id'
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(danId, clientId)
    })

    test('can Read registry', async () => {
      const response = await storageFetch(registry, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(401)
    })
    test('can Read registration', async () => {
      const response = await storageFetch(registrationId, {
        headers: { Accept: 'text/turtle' },
      })
      expect(response.status).toBe(401)
    })
    test('can Read instance', async () => {
      const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(401)
    })
    test('can not Create', async () => {
      const response = await storageFetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: turtleBody,
      })
      expect(response.status).toBe(401)
    })
    test('can not Update', async () => {
      const response = await storageFetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: turtleBody,
      })
      expect(response.status).toBe(401)
    })
    test('can not Delete', async () => {
      const response = await storageFetch(id, { method: 'DELETE' })
      expect(response.status).toBe(401)
    })
  })

  describe('authenticated request (admin using UAS)', () => {
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(danId)
    })

    test('can Read registry', async () => {
      const response = await storageFetch(registry, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
    })
    test('can Read registration', async () => {
      const response = await storageFetch(registrationId, {
        headers: { Accept: 'text/turtle' },
      })
      expect(response.status).toBe(200)
    })
    test('can Read instance', async () => {
      const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
    })
    test('can not Create', async () => {
      const response = await storageFetch(getRegistration(id), {
        method: 'POST',
        headers: { 'Content-type': 'text/turtle' },
        body: turtleBody,
      })
      expect(response.status).toBe(403)
    })
    test('can not Update', async () => {
      const response = await storageFetch(id, {
        method: 'PUT',
        headers: { 'Content-type': 'text/turtle' },
        body: turtleBody,
      })
      expect(response.status).toBe(403)
    })
    test('can not Delete', async () => {
      const response = await storageFetch(id, { method: 'DELETE' })
      expect(response.status).toBe(403)
    })
  })

  describe('authenticated request (non-admin using UAS)', () => {
    let storageFetch: typeof fetch
    beforeAll(async () => {
      storageFetch = await buildLwsFetch(bobId)
    })

    test('can not Read registry (listing is admin/owner-only)', async () => {
      const response = await storageFetch(registry, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(403)
    })
    test('can Read instance (bob already holds access grants from YoYo)', async () => {
      const response = await storageFetch(id, { headers: { Accept: 'text/turtle' } })
      expect(response.status).toBe(200)
    })
  })
})
