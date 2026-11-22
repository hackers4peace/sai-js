import { randomUUID } from 'node:crypto'

import { AgentRegistry } from '@janeirodigital/interop-authorization-agent'
import { describe, test } from 'vitest'

import { expect } from './expect'
import { fetch } from './mock-fetch.ts'

const webId = 'https://alice.example/#id'
const agentId = 'https://jarvis.alice.example/#agent'
const deps = { fetch, randomUUID }
const socialAgentRegistryIri = 'https://auth.alice.example/1cf3e08b-ffe2-465a-ac5b-94ce165cb8f0'
const applicationRegistryIri = 'https://auth.alice.example/a0000001-0000-0000-0000-000000000000'
const invitationRegistryIri = 'https://auth.alice.example/a0000002-0000-0000-0000-000000000000'
const socialAgentRegistry = { id: socialAgentRegistryIri }
const applicationRegistry = { id: applicationRegistryIri }
const invitationRegistry = { id: invitationRegistryIri }

test('should provide applicationRegistrations from the application registry ldp:contains listing', async () => {
  let count = 0
  for await (const authorization of AgentRegistry.applicationRegistrations(
    applicationRegistry,
    deps.fetch
  )) {
    count += 1
    expect(authorization).toHaveProperty('id')
    expect(authorization).toHaveProperty('registeredAgent')
  }
  expect(count).toBe(2)
})

test('should provide socialAgentRegistrations from the social-agent registry ldp:contains listing', async () => {
  let count = 0
  for await (const authorization of AgentRegistry.socialAgentRegistrations(
    socialAgentRegistry,
    deps.fetch
  )) {
    count += 1
    expect(authorization).toHaveProperty('id')
    expect(authorization).toHaveProperty('registeredAgent')
  }
  expect(count).toBe(2)
})

// TODO: update snippets with some invitations
test('should provide socialAgentInvitations from the invitation registry ldp:contains listing', async () => {
  let count = 0
  for await (const invitation of AgentRegistry.socialAgentInvitations(
    invitationRegistry,
    deps.fetch
  )) {
    count += 1
    expect(invitation).toHaveProperty('capabilityUrl')
  }
  expect(count).toBe(0)
})

describe('findApplicationRegistration', () => {
  test('finds application registration', async () => {
    const applicationIri = 'https://projectron.example/#app'
    expect(
      await AgentRegistry.findApplicationRegistration(
        applicationRegistry,
        deps.fetch,
        applicationIri
      )
    ).toHaveProperty('registeredAgent', applicationIri)
  })
})

describe('findSocialAgentRegistration', () => {
  test('finds social agent registration', async () => {
    const socialAgentIri = 'https://acme.example/#corp'
    expect(
      await AgentRegistry.findSocialAgentRegistration(
        socialAgentRegistry,
        deps.fetch,
        socialAgentIri
      )
    ).toHaveProperty('registeredAgent', socialAgentIri)
  })
})

// TODO: update snippets with some invitations
describe.skip('findSocialAgentInvitation', () => {
  test('finds social agent invitation', async () => {
    const socialAgentInvitationIri = 'TODO'
    expect(
      await AgentRegistry.findSocialAgentInvitation(
        invitationRegistry,
        deps.fetch,
        socialAgentInvitationIri
      )
    ).toHaveProperty('capabilityUrl')
  })
})

describe('findRegistration', () => {
  test('finds application registration', async () => {
    const applicationIri = 'https://projectron.example/#app'
    expect(
      await AgentRegistry.findRegistration(
        socialAgentRegistry,
        applicationRegistry,
        deps.fetch,
        applicationIri
      )
    ).toHaveProperty('registeredAgent', applicationIri)
  })

  test('finds social agent registration', async () => {
    const socialAgentIri = 'https://acme.example/#corp'
    expect(
      await AgentRegistry.findRegistration(
        socialAgentRegistry,
        applicationRegistry,
        deps.fetch,
        socialAgentIri
      )
    ).toHaveProperty('registeredAgent', socialAgentIri)
  })
})

describe('addSocialAgentRegistration', () => {
  const jane = 'https://jane.example'

  test('throws if registration already exists', async () => {
    const socialAgentIri = 'https://acme.example/#corp'
    await expect(
      AgentRegistry.addSocialAgentRegistration(
        socialAgentRegistry,
        deps,
        { agent: webId, client: agentId },
        socialAgentIri,
        'Someone'
      )
    ).rejects.toThrow('already exists')
  })

  test.skip('returns added registration', async () => {
    const registration = await AgentRegistry.addSocialAgentRegistration(
      socialAgentRegistry,
      factory,
      { agent: webId, client: agentId },
      jane,
      'Jane'
    )
    expect(registration.registeredAgent).toBe(jane)
  })
})

describe('addSocialAgentInvitation', () => {
  const capabilityUrl = 'https://auth.jane.example/some-secret-url'

  test.skip('throws if invitation already exists', async () => {
    expect(
      AgentRegistry.addSocialAgentInvitation(invitationRegistry, deps, capabilityUrl, 'Someone')
    ).rejects.toThrow('already exists')
  })

  test('returns added invitation', async () => {
    const invitation = await AgentRegistry.addSocialAgentInvitation(
      invitationRegistry,
      deps,
      capabilityUrl,
      'Jane'
    )
    expect(invitation.capabilityUrl).toBe(capabilityUrl)
    expect(invitation.label).toEqual({ '@none': 'Jane' })
  })
})

describe('addApplicationRegistration', () => {
  const gigaApp = 'https://gigaApp.example'

  test('throws if registration already exists', async () => {
    const applicationIri = 'https://projectron.example/#app'
    await expect(
      AgentRegistry.addApplicationRegistration(
        applicationRegistry,
        deps,
        { agent: webId, client: agentId },
        applicationIri
      )
    ).rejects.toThrow('already exists')
  })

  test('returns added registration', async () => {
    const registration = await AgentRegistry.addApplicationRegistration(
      applicationRegistry,
      deps,
      { agent: webId, client: agentId },
      gigaApp
    )
    expect(registration.registeredAgent).toBe(gigaApp)
  })
})
