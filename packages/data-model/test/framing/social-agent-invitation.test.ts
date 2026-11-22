import { INTEROP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { fromJsonLd as invitationFromJsonLd } from '../../src/social-agent-invitation'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const INVITATION_IRI = 'https://registry/kim/zi1nic'

// Graph <https://registry/kim/zi1nic> in the local framing fixture: a
// SocialAgentInvitation with capabilityUrl, skos:prefLabel and skos:note.
describe('SocialAgentInvitation framing', () => {
  test('frames the invitation graph into SocialAgentInvitationData', async () => {
    const doc = await docFromGraphs([INVITATION_IRI])
    const invitation = await invitationFromJsonLd(doc, INVITATION_IRI)
    expect(invitation).toEqual({
      id: INVITATION_IRI,
      type: [INTEROP.SocialAgentInvitation],
      capabilityUrl:
        'https://auth/.sai/invitations/aHR0cHM6Ly9pZC9raW0.8f19934d-b6a6-4a73-9d27-8cd20ed0657f',
      label: { '@none': 'Bob' },
      note: 'What about Bob?',
      registeredAgent: undefined,
    })
  })
})
