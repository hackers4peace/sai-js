import { INTEROP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { fromJsonLd as roleFromJsonLd } from '../../src/role'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const ROLE_IRI = 'https://registry/alice/ps8hc3'

// Graph <https://registry/alice/ps8hc3> in the local framing fixture: a Role with
// an untagged skos:prefLabel ("Corps") and interop:hasMember. The label
// frames as a language map — the untagged value under `@none`.
describe('Role framing', () => {
  test('frames the role graph into RoleData — untagged label under @none', async () => {
    const doc = await docFromGraphs([ROLE_IRI])
    const role = await roleFromJsonLd(doc, ROLE_IRI)
    expect(role).toEqual({
      id: ROLE_IRI,
      type: [INTEROP.Role],
      label: { '@none': 'Corps' },
      members: ['https://id/acme'],
    })
  })

  test('frames language-tagged labels under their tags', async () => {
    const doc = {
      '@context': {
        interop: 'http://www.w3.org/ns/solid/interop#',
        skos: 'http://www.w3.org/2004/02/skos/core#',
      },
      '@id': ROLE_IRI,
      '@type': 'interop:Role',
      'skos:prefLabel': [
        { '@value': 'Zarządzaj projektami', '@language': 'pl' },
        { '@value': 'Manage Projects', '@language': 'en' },
      ],
    }
    const role = await roleFromJsonLd(doc, ROLE_IRI)
    expect(role.label).toEqual({ pl: 'Zarządzaj projektami', en: 'Manage Projects' })
  })

  test('keeps untagged (@none) and tagged entries distinct in the map', async () => {
    const doc = {
      '@context': {
        interop: 'http://www.w3.org/ns/solid/interop#',
        skos: 'http://www.w3.org/2004/02/skos/core#',
      },
      '@id': ROLE_IRI,
      '@type': 'interop:Role',
      'skos:prefLabel': [{ '@value': 'Corps' }, { '@value': 'Korps', '@language': 'pl' }],
    }
    const role = await roleFromJsonLd(doc, ROLE_IRI)
    expect(role.label).toEqual({ '@none': 'Corps', pl: 'Korps' })
  })
})
