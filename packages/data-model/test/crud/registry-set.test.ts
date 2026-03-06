import { randomUUID } from 'node:crypto'
import { fetch } from '@janeirodigital/interop-test-utils'
import { describe, test } from 'vitest'
import { AuthorizationAgentFactory, CRUDDataRegistry, CRUDRegistrySet } from '../../src'
import { expect } from '../expect'

const webId = 'https://alice.example/#id'
const agentId = 'https://jarvis.alice.example/#agent'
const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
const snippetIri = 'https://auth.alice.example/13e60d32-77a6-4239-864d-cfe2c90807c8'

describe.skip('build', () => {
  test('should return instance of RegistrySet', async () => {
    const registrySet = await factory.crud.registrySet(snippetIri)
    expect(registrySet).toBeInstanceOf(CRUDRegistrySet)
  })

  test('should fetch its data', async () => {
    const registrySet = await factory.crud.registrySet(snippetIri)
    expect(registrySet.dataset.size).toBeGreaterThan(0)
  })

  test('should set hasDataRegistry', async () => {
    const registrySet = await factory.crud.registrySet(snippetIri)
    for (const dataRegistry of registrySet.hasDataRegistry) {
      expect(dataRegistry).toBeInstanceOf(CRUDDataRegistry)
    }
    expect(registrySet.hasDataRegistry).toHaveLength(2)
  })

  test('should set hasAgentRegistry', async () => {
    const agentRegistryIri = 'https://auth.alice.example/1cf3e08b-ffe2-465a-ac5b-94ce165cb8f0'
    const registrySet = await factory.crud.registrySet(snippetIri)
    expect(registrySet.hasAgentRegistry.iri).toEqual(agentRegistryIri)
  })

  test('should set hasAuthorizationRegistry', async () => {
    const authorizationRegistryIri =
      'https://auth.alice.example/96feb105-063e-4996-ab74-5e504c6ceae5'
    const registrySet = await factory.crud.registrySet(snippetIri)
    expect(registrySet.hasAuthorizationRegistry.iri).toEqual(authorizationRegistryIri)
  })
})
