import { INTEROP, LDP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { fromJsonLd as registrationFromJsonLd } from '../../src/social-agent-registration'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const REGISTRATION_IRI = 'https://registry/acme/je0s7n'

// Graph <meta:https://registry/acme/je0s7n> in registry.trig: a
// SocialAgentRegistration with registeredAgent, reciprocalRegistration,
// hasDataGrant, skos:prefLabel and skos:note.
describe('SocialAgentRegistration framing', () => {
  test('frames the social agent registration graph into SocialAgentRegistrationData', async () => {
    const doc = await docFromGraphs([`meta:${REGISTRATION_IRI}`])
    const registration = await registrationFromJsonLd(doc, REGISTRATION_IRI)
    expect(registration).toEqual({
      id: REGISTRATION_IRI,
      type: [INTEROP.SocialAgentRegistration, LDP.Container, LDP.BasicContainer, LDP.Resource],
      registeredAgent: 'https://id/alice',
      hasDataGrant: ['https://registry/acme/g4yhtm', 'https://registry/acme/wpqyds'],
      label: { '@none': 'Alice' },
      note: 'Chasing white rabits.',
      reciprocalRegistration: 'https://registry/alice/cp9g7p',
    })
  })
})
