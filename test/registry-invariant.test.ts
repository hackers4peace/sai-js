import { readFileSync } from 'node:fs'

import { INTEROP, LWS, ODRL } from '@janeirodigital/interop-utils'
import { Parser, Store } from 'n3'
import { describe, expect, test } from 'vitest'

// The seed must satisfy the C5 grant/link invariant: a registration only links
// grants stored in the same registry set, and the linked grant's assigner is
// that registry owner. This keeps source and delegated grants on the same
// grantor/registration side.
const registryTrig = readFileSync(
  new URL('../environments/data/registry.trig', import.meta.url),
  'utf-8'
)

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

describe('registry seed grant/link invariant', () => {
  test('every hasDataGrant target belongs to the registration registry and the same assigner', () => {
    const store = new Store(new Parser({ format: 'application/trig' }).parse(registryTrig))
    const registrations = [
      ...new Set(
        [INTEROP.SocialAgentRegistration, INTEROP.ApplicationRegistration].flatMap((type) =>
          store.getSubjects(RDF_TYPE, type, null).map((subject) => subject.value)
        )
      ),
    ]
    expect(registrations.length).toBeGreaterThan(0)

    let links = 0
    for (const registration of registrations) {
      const owner = new URL(registration).pathname.split('/')[1]
      const grants = store.getObjects(registration, INTEROP.hasDataGrant, null)
      for (const grant of grants) {
        links++
        expect(grant.value).toMatch(new RegExp(`^https://registry/${owner}/`, 'u'))

        const access = store.getObjects(grant, LWS.access, null)[0]
        expect(access, `no access policy for ${grant.value}`).toBeDefined()
        const permission = store.getObjects(access, ODRL.permission, null)[0]
        expect(permission, `no permission for ${grant.value}`).toBeDefined()
        const assigner = store.getObjects(permission, ODRL.assigner, null)[0]
        expect(assigner?.value).toBe(`https://id/${owner}`)
      }
    }
    expect(links).toBeGreaterThan(0)
  })
})
