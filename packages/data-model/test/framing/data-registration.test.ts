import { INTEROP, LDP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { DataRegistration } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const REGISTRATION_IRI = 'https://data/acme-rnd/reb39k'

// DataRegistration in the local framing fixture is split like CSS stores containers:
// the meta graph carries type + registeredShapeTree + lws:contains. The data
// model frames the LDP view, so the helper normalizes lws:contains to
// ldp:contains — pbh2yw and z8w2pl are both contained.
describe('DataRegistration framing', () => {
  test('frames the registration graphs into DataRegistrationData', async () => {
    // Flat storage: containment lives only in the meta graph as lws:contains
    const doc = await docFromGraphs([`meta:${REGISTRATION_IRI}`])
    const data = await DataRegistration.fromJsonLd(doc, REGISTRATION_IRI)
    expect(data).toEqual({
      id: REGISTRATION_IRI,
      type: [INTEROP.DataRegistration, LDP.Resource, LDP.Container],
      registeredShapeTree: 'https://data/shapetrees/trees/Project',
      contains: ['https://data/acme-rnd/pbh2yw', 'https://data/acme-rnd/z8w2pl'],
      partOf: 'https://data/acme-rnd/',
    })
  })

  test('frames a single containment as an array (@container: @set)', async () => {
    // sx86hi contains exactly one instance: @container: @set must still frame
    // it as an array, so `contains` is never a bare string
    const singleRegistrationIri = 'https://data/alice-work/sx86hi'
    const doc = await docFromGraphs([`meta:${singleRegistrationIri}`, singleRegistrationIri])
    const data = await DataRegistration.fromJsonLd(doc, singleRegistrationIri)
    expect(data.contains).toEqual(['https://data/alice-work/k3pqsb'])
  })

  test('exposes an empty contains array when the registration has no instances', async () => {
    // an empty registration has no resource graph, only the meta graph
    const emptyRegistrationIri = 'https://data/bob/oapdnp'
    const doc = await docFromGraphs([`meta:${emptyRegistrationIri}`])
    const data = await DataRegistration.fromJsonLd(doc, emptyRegistrationIri)
    expect(data).toEqual({
      id: emptyRegistrationIri,
      type: [INTEROP.DataRegistration, LDP.Resource, LDP.Container],
      registeredShapeTree: 'https://data/shapetrees/trees/File',
      contains: [],
      partOf: 'https://data/bob/',
    })
  })
})
