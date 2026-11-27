import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { INTEROP, LDP, SPACE, loader } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { RegistrySet } from '../../src'
const loadRegistrySet = loader(RegistrySet.fromJsonLd)

import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const REGISTRY_SET_IRI = 'https://registry/alice/'

// Graph <meta:https://registry/alice/> in the local framing fixture: the RegistrySet with
// its nine registries (hasDataRegistry is multi-valued; the agent-side split
// into social-agent, application, invitation and access-request registries).
describe('RegistrySet framing', () => {
  test('frames the registry set graph into RegistrySetData', async () => {
    const doc = await docFromGraphs([`meta:${REGISTRY_SET_IRI}`])
    const fetch = (async () => ({
      ok: true,
      url: REGISTRY_SET_IRI,
      json: async () => doc,
    })) as unknown as WhatwgFetch
    const registrySet = await loadRegistrySet(REGISTRY_SET_IRI, fetch)
    expect(registrySet).toEqual({
      id: REGISTRY_SET_IRI,
      type: [INTEROP.RegistrySet, LDP.Resource, SPACE.Storage],
      hasAuthorizationRegistry: { id: 'https://registry/alice/authorization/' },
      hasGrantRegistry: { id: 'https://registry/alice/grant/' },
      hasSocialAgentRegistry: { id: 'https://registry/alice/social-agent/' },
      hasApplicationRegistry: { id: 'https://registry/alice/application/' },
      hasInvitationRegistry: { id: 'https://registry/alice/invitation/' },
      hasRoleRegistry: { id: 'https://registry/alice/role/' },
      hasActivityRegistry: { id: 'https://registry/alice/activity/' },
      hasAccessRequestRegistry: { id: 'https://registry/alice/access-request/' },
      hasDataRegistry: [{ id: 'https://data/alice-home/' }, { id: 'https://data/alice-work/' }],
    })
  })
})
