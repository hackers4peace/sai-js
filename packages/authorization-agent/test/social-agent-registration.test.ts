import { randomUUID } from 'node:crypto'

import {
  createSocialAgentRegistration,
  replaceAdminGrantLinks,
} from '@janeirodigital/interop-authorization-agent'
import {
  SocialAgentRegistration,
  type SocialAgentRegistrationData,
  getAdminGrantIris,
  getAccessGrantIris,
} from '@janeirodigital/interop-data-model'
import { INTEROP, type WhatwgFetch, jsonld, loader } from '@janeirodigital/interop-utils'
const loadSocialAgentRegistration = loader(SocialAgentRegistration.fromJsonLd)

import { describe, test, vi } from 'vitest'

import { expect } from './expect'
import { fetch, statelessFetch } from './mock-fetch.ts'

describe('build', () => {
  const deps = { fetch, randomUUID }
  const snippetIri = 'https://auth.alice.example/5dc3c14e-7830-475f-b8e3-4748d6c0bccb'

  test('should return social agent registration, with reciprocal', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    expect(socialAgentRegistration).toHaveProperty('id', snippetIri)
    expect(socialAgentRegistration.reciprocalRegistration).toBe(
      'https://auth.acme.example/2437895a-3a68-4048-8965-889b7e93936c'
    )
  })

  test('should return social agent registration, without reciprocal based on data', async () => {
    const withoutReciprocalIri = 'https://auth.alice.example/76849244-0e74-4d8a-8d07-48eae753faa9'
    const socialAgentRegistration = await loadSocialAgentRegistration(
      withoutReciprocalIri,
      deps.fetch
    )
    expect(socialAgentRegistration).toHaveProperty('id', withoutReciprocalIri)
    expect(socialAgentRegistration.reciprocalRegistration).toBeUndefined()
  })

  test('should have expected fields', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    expect(socialAgentRegistration.registeredAgent).toBe('https://acme.example/#corp')
    expect(socialAgentRegistration.label).toEqual({ '@none': 'ACME' })
    expect(socialAgentRegistration.note).toBe('A company making well known gadgets')
  })

  test('should build reciprocal registration', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    expect(socialAgentRegistration.reciprocalRegistration).toBe(
      'https://auth.acme.example/2437895a-3a68-4048-8965-889b7e93936c'
    )
  })
  test('should have access grant IRIs', async () => {
    const acme2bobRegistrationIri = 'https://auth.acme.example/2437895a-3a68-4048-8965-889b7e93936c'
    const socialAgentRegistration = await loadSocialAgentRegistration(
      acme2bobRegistrationIri,
      deps.fetch
    )
    const iris = getAccessGrantIris(socialAgentRegistration)
    expect(iris.length).toBeGreaterThan(0)
  })
})

describe('admin grant links (R1)', () => {
  const snippetIri = 'https://auth.alice.example/registration-admin'
  const deps = { fetch, randomUUID }
  const grantOne = 'https://auth.alice.example/grant-admin-1'
  const grantTwo = 'https://auth.alice.example/grant-admin-2'

  test('frames hasAdminGrant from the registration resource', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    expect(getAdminGrantIris(socialAgentRegistration)).toEqual([grantOne, grantTwo])
  })

  test('replaceAdminGrantLinks patches remove+insert in a single request', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    const mockedFetch = vi.fn(statelessFetch)
    const statefulDeps = { fetch: mockedFetch, randomUUID }
    const grantThree = 'https://auth.alice.example/grant-admin-3'

    await replaceAdminGrantLinks(socialAgentRegistration, statefulDeps.fetch, [
      grantOne,
      grantThree,
    ])

    expect(mockedFetch).toBeCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('DELETE DATA'),
      })
    )
    expect(mockedFetch).toBeCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('INSERT DATA'),
      })
    )
    expect(socialAgentRegistration.hasAdminGrant).toEqual([grantOne, grantThree])
  })

  test('replaceAdminGrantLinks unlinks with an empty list', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    const mockedFetch = vi.fn(statelessFetch)
    const statefulDeps = { fetch: mockedFetch, randomUUID }

    await replaceAdminGrantLinks(socialAgentRegistration, statefulDeps.fetch, [])

    expect(mockedFetch).toBeCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('DELETE DATA'),
      })
    )
    expect(socialAgentRegistration.hasAdminGrant).toEqual([])
  })

  test('replaceAdminGrantLinks is a no-op when the links already match', async () => {
    const socialAgentRegistration = await loadSocialAgentRegistration(snippetIri, deps.fetch)
    const mockedFetch = vi.fn(statelessFetch)
    const statefulDeps = { fetch: mockedFetch, randomUUID }

    await replaceAdminGrantLinks(socialAgentRegistration, statefulDeps.fetch, [grantOne, grantTwo])

    expect(mockedFetch).not.toHaveBeenCalled()
  })
})

describe('createSocialAgentRegistration', () => {
  test('creates a flat container member and patches the registration document', async () => {
    const registration: SocialAgentRegistrationData = {
      id: 'https://auth.alice.example/6f1e6c1e-0000-4000-8000-000000000000',
      type: [INTEROP.SocialAgentRegistration],
      registeredAgent: 'https://acme.example/#corp',
      hasDataGrant: [],
      hasAdminGrant: [],
      label: { '@none': 'ACME' },
    }

    let patchBody = ''
    let posted = ''
    const recordingFetch = (async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') posted = url
      if (options?.method === 'PATCH') patchBody = options.body as string
      const accept = (options?.headers as Record<string, string> | undefined)?.Accept
      if (accept === 'application/lws+cid') {
        return {
          ok: true,
          headers: { get: () => 'application/lws+cid' },
          json: async () => ({
            id: url,
            type: 'Storage',
            service: [{ type: 'StorageRoot', serviceEndpoint: url }],
          }),
        } as unknown as Response
      }
      return {
        ok: true,
        headers: {
          get: (name: string) => {
            if (name === 'Link') {
              return '<https://auth.alice.example/>; rel="https://www.w3.org/ns/lws#storage", <http://just.en.example/description>; rel="describedby"'
            }
            if (name === 'Location') return registration.id
            return undefined
          },
        },
        text: async () => '',
        status: nameToStatus(posted),
      } as unknown as Response
    }) as WhatwgFetch
    function nameToStatus(value: string): number {
      return value ? 201 : 200
    }

    // POST the flat member to the Social Agent Registry (slug = the pre-minted
    // uuid), then PATCH its description
    await createSocialAgentRegistration(
      { id: 'https://auth.alice.example/social-agent-registry/' },
      registration,
      recordingFetch
    )
    expect(posted).toBe('https://auth.alice.example/social-agent-registry/')

    // the body must be a valid SPARQL data block — parse it back as N-Quads
    expect(patchBody.startsWith('INSERT DATA { ')).toBe(true)
    const inner = patchBody.replace(/^INSERT DATA \{ /, '').replace(/ \}$/, '')
    const nodes = await jsonld.fromRDF(inner, { format: 'application/n-quads' })
    const node = nodes.find((n) => n['@id'] === registration.id)
    expect(node).toBeDefined()
    expect(node!['@type']).toContain(INTEROP.SocialAgentRegistration)
    expect(node!['http://www.w3.org/ns/solid/interop#registeredAgent']).toEqual([
      { '@id': 'https://acme.example/#corp' },
    ])
    expect(node!['http://www.w3.org/2004/02/skos/core#prefLabel']).toEqual([{ '@value': 'ACME' }])
  })
})
