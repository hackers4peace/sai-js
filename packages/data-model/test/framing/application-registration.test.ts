import { INTEROP, LDP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { ApplicationRegistration } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const REGISTRATION_IRI = 'https://registry/alice/cvmsa4'

// Graph <meta:https://registry/alice/cvmsa4> in the local framing fixture:
// ApplicationRegistration node (type, registeredAgent, hasDataGrant) and the
// embedded client-id-document node — the latter must not disturb framing.
describe('ApplicationRegistration framing', () => {
  test('frames the application registration graph into ApplicationRegistrationData', async () => {
    const doc = await docFromGraphs([`meta:${REGISTRATION_IRI}`])
    const data = await ApplicationRegistration.fromJsonLd(doc, REGISTRATION_IRI)
    expect(data).toEqual({
      id: REGISTRATION_IRI,
      type: [INTEROP.ApplicationRegistration, LDP.Container, LDP.BasicContainer, LDP.Resource],
      registeredAgent: 'https://data/test-client/public/id',
      hasDataGrant: [
        'https://registry/alice/afiooi',
        'https://registry/alice/azgyc5',
        'https://registry/alice/wwp4j6',
        'https://registry/alice/qwvbcu',
      ],
      granted: true,
    })
  })
})
