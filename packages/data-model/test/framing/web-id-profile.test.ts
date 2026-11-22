import { describe, test } from 'vitest'

import { WebIdProfile } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const WEBID_IRI = 'https://id/acme'

// Graph <https://id/acme> in the local framing fixture: WebID profile with
// skos:prefLabel and solid:oidcIssuer (no rdf:type).
describe('WebIdProfile framing', () => {
  test('frames the webid graph into WebIdProfileData', async () => {
    const doc = await docFromGraphs([WEBID_IRI])
    const profile = await WebIdProfile.fromJsonLd(doc, WEBID_IRI)
    expect(profile).toEqual({
      id: WEBID_IRI,
      type: [],
      label: { '@none': 'ACME' },
      oidcIssuer: 'https://auth/',
    })
  })
})
