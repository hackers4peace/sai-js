import { randomUUID } from 'node:crypto'

import { AgentRegistry } from '@janeirodigital/interop-authorization-agent'
import type { SparqlTransport } from '@janeirodigital/interop-authorization-agent'
import { INTEROP, RDF } from '@janeirodigital/interop-utils'
import type * as InteropUtils from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, test, vi } from 'vitest'

import { expect } from './expect'
import { fetch } from './mock-fetch.ts'

// The write paths discover the peer's authorization agent before setting the
// registration ACR; the fixture profiles carry no `hasAuthorizationAgent`, so
// pin the discovery result (the lookup itself is covered by the utils tests).
vi.mock('@janeirodigital/interop-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof InteropUtils>()
  return {
    ...actual,
    discoverAuthorizationAgent: vi.fn(async () => 'https://auth.acme.example/'),
  }
})

const webId = 'https://alice.example/#id'
const agentId = 'https://jarvis.alice.example/#agent'
const deps = { fetch, randomUUID }
const socialAgentRegistryIri = 'https://auth.alice.example/1cf3e08b-ffe2-465a-ac5b-94ce165cb8f0'
const applicationRegistryIri = 'https://auth.alice.example/a0000001-0000-0000-0000-000000000000'
const invitationRegistryIri = 'https://auth.alice.example/a0000002-0000-0000-0000-000000000000'
const socialAgentRegistry = { id: socialAgentRegistryIri }
const applicationRegistry = { id: applicationRegistryIri }
const invitationRegistry = { id: invitationRegistryIri }

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

/** A plane stub listing one registration in `containerIri` and serving its graph. */
function listingTransport(
  containerIri: string,
  registrationIri: string,
  type: string,
  registeredAgent: string
): SparqlTransport {
  return {
    async fetchBindings(query: string) {
      expect(query).toContain(`GRAPH <meta:${containerIri}>`)
      return [{ child: { termType: 'NamedNode', value: registrationIri } }]
    },
    async fetchTriples(query: string) {
      expect(query).toContain(`GRAPH <${registrationIri}>`)
      return [
        DataFactory.quad(
          DataFactory.namedNode(registrationIri),
          DataFactory.namedNode(RDF_TYPE),
          DataFactory.namedNode(type)
        ),
        DataFactory.quad(
          DataFactory.namedNode(registrationIri),
          DataFactory.namedNode(INTEROP.registeredAgent),
          DataFactory.namedNode(registeredAgent)
        ),
      ]
    },
  }
}

/** A plane stub whose registry container lists nothing (no registration). */
const emptyTransport: SparqlTransport = {
  async fetchBindings(query: string) {
    expect(query).toContain('lws#contains')
    return []
  },
  async fetchTriples() {
    throw new Error('no registration graph expected')
  },
}

describe('addApplicationRegistration', () => {
  const gigaApp = 'https://gigaApp.example'
  const existingApp = 'https://projectron.example/#app'

  test('throws if registration already exists (plane duplicate check)', async () => {
    await expect(
      AgentRegistry.addApplicationRegistration(
        applicationRegistry,
        deps,
        listingTransport(
          applicationRegistryIri,
          'https://auth.alice.example/app-reg',
          INTEROP.ApplicationRegistration,
          existingApp
        ),
        { agent: webId, client: agentId },
        existingApp
      )
    ).rejects.toThrow('already exists')
  })

  test('returns added registration', async () => {
    const registration = await AgentRegistry.addApplicationRegistration(
      applicationRegistry,
      deps,
      emptyTransport,
      { agent: webId, client: agentId },
      gigaApp
    )
    expect(registration.registeredAgent).toBe(gigaApp)
  })
})

describe('addSocialAgentRegistration', () => {
  const acme = 'https://acme.example/#corp'
  const jane = 'https://jane.example'

  test('throws if registration already exists (plane duplicate check)', async () => {
    await expect(
      AgentRegistry.addSocialAgentRegistration(
        socialAgentRegistry,
        deps,
        listingTransport(
          socialAgentRegistryIri,
          'https://auth.alice.example/social-reg',
          INTEROP.SocialAgentRegistration,
          acme
        ),
        { agent: webId, client: agentId },
        acme,
        'Someone'
      )
    ).rejects.toThrow('already exists')
  })

  test('returns added registration', async () => {
    const registration = await AgentRegistry.addSocialAgentRegistration(
      socialAgentRegistry,
      deps,
      emptyTransport,
      { agent: webId, client: agentId },
      jane,
      'Jane'
    )
    expect(registration.registeredAgent).toBe(jane)
  })
})

describe('addSocialAgentInvitation', () => {
  const capabilityUrl = 'https://auth.jane.example/some-secret-url'
  const invitationIri = 'https://auth.alice.example/invitation-1'

  // the registry-plane duplicate check: `lws:contains` listing + one graph
  // read per candidate, exactly like `AuthorizationAgent.findSocialAgentInvitation`
  const existingInvitationTransport: SparqlTransport = {
    async fetchBindings(query: string) {
      expect(query).toContain(`GRAPH <meta:${invitationRegistryIri}>`)
      return [{ child: { termType: 'NamedNode', value: invitationIri } }]
    },
    async fetchTriples(query: string) {
      expect(query).toContain(`GRAPH <${invitationIri}>`)
      return [
        DataFactory.quad(
          DataFactory.namedNode(invitationIri),
          RDF.terms.type,
          INTEROP.terms.SocialAgentInvitation
        ),
        DataFactory.quad(
          DataFactory.namedNode(invitationIri),
          INTEROP.terms.hasCapabilityUrl,
          DataFactory.namedNode(capabilityUrl)
        ),
      ]
    },
  }

  test('throws if invitation already exists', async () => {
    await expect(
      AgentRegistry.addSocialAgentInvitation(
        invitationRegistry,
        deps,
        existingInvitationTransport,
        capabilityUrl,
        'Someone'
      )
    ).rejects.toThrow('already exists')
  })

  test('returns added invitation', async () => {
    const invitation = await AgentRegistry.addSocialAgentInvitation(
      invitationRegistry,
      deps,
      emptyTransport,
      capabilityUrl,
      'Jane'
    )
    expect(invitation.capabilityUrl).toBe(capabilityUrl)
    expect(invitation.label).toEqual({ '@none': 'Jane' })
  })
})
