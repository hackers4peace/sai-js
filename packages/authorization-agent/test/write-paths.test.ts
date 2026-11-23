import {
  createDataRegistration,
  putRole,
  putSocialAgentInvitation,
} from '@janeirodigital/interop-authorization-agent'
import { Role, SocialAgentInvitation, dataModelContext } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  LDP,
  RDF,
  SKOS,
  fetchJsonLd,
  jsonld,
  toStore,
  withContext,
} from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, test } from 'vitest'

import { expect } from './expect'
import { createStatefulFetch } from './mock-fetch.ts'

// ──────────────────────────
// Write-path round-trips for the models whose serialization was previously
// covered only implicitly (crud tests via the mock factory). Each one asserts
// the quads the shared dataModelContext produces for the model's RDF-backed
// fields (the toJsonLd → toStore pattern), and — for the raw-JSON-PUT models —
// a real PUT → read-back round-trip through the stateful fetch.
// ──────────────────────────

describe('role write path', () => {
  const iri = 'https://registry/alice/r1'
  const roleData = {
    id: iri,
    type: [INTEROP.Role],
    label: { '@none': 'Test Role' },
    members: ['https://id/bob'],
  }

  test('shared context serializes role fields to the expected quads', async () => {
    const store = await toStore(withContext(dataModelContext, roleData), iri)
    expect(store).toBeRdfDatasetContaining(
      DataFactory.quad(DataFactory.namedNode(iri), RDF.terms.type, INTEROP.terms.Role),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        SKOS.terms.prefLabel,
        DataFactory.literal('Test Role')
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        INTEROP.terms.hasMember,
        DataFactory.namedNode('https://id/bob')
      )
    )
  })

  test('putRole round-trips through a stateful fetch', async () => {
    const fetch = createStatefulFetch()
    await putRole(roleData, fetch)
    const raw = await fetchJsonLd(iri, fetch)
    // the wire body is the expanded form: top-level array, no @context,
    // full-IRI property keys
    expect(Array.isArray(raw)).toBe(true)
    expect(JSON.stringify(raw)).not.toContain('@context')
    expect(JSON.stringify(raw)).toContain('http://www.w3.org/ns/solid/interop#hasMember')
    expect(await Role.fromJsonLd(raw, iri)).toEqual(roleData)
  })
})

describe('social-agent-invitation write path', () => {
  const iri = 'https://registry/kim/inv1'
  const invitationData = {
    id: iri,
    type: [INTEROP.SocialAgentInvitation],
    capabilityUrl: 'https://auth/.sai/invitations/some-secret',
    label: { '@none': 'Bob' },
    note: 'What about Bob?',
  }

  test('shared context serializes invitation fields to the expected quads', async () => {
    const store = await toStore(withContext(dataModelContext, invitationData), iri)
    expect(store).toBeRdfDatasetContaining(
      DataFactory.quad(
        DataFactory.namedNode(iri),
        RDF.terms.type,
        INTEROP.terms.SocialAgentInvitation
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        INTEROP.terms.hasCapabilityUrl,
        DataFactory.namedNode('https://auth/.sai/invitations/some-secret')
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        SKOS.terms.prefLabel,
        DataFactory.literal('Bob')
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        SKOS.terms.note,
        DataFactory.literal('What about Bob?')
      )
    )
  })

  test('putSocialAgentInvitation round-trips through a stateful fetch', async () => {
    const fetch = createStatefulFetch()
    await putSocialAgentInvitation(invitationData, fetch)
    expect(await SocialAgentInvitation.fromJsonLd(await fetchJsonLd(iri, fetch), iri)).toEqual(
      invitationData
    )
  })
})

describe('data-registration write path', () => {
  test('shared context serializes the registration fields to the expected quads', async () => {
    const iri = 'https://data/alice/reg/'
    const data = {
      id: iri,
      type: [INTEROP.DataRegistration, LDP.Resource],
      registeredShapeTree: 'https://trees/Project',
      contains: [],
    }
    const store = await toStore(withContext(dataModelContext, data), iri)
    expect(store).toBeRdfDatasetContaining(
      DataFactory.quad(DataFactory.namedNode(iri), RDF.terms.type, INTEROP.terms.DataRegistration),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        INTEROP.terms.registeredShapeTree,
        DataFactory.namedNode('https://trees/Project')
      )
    )
  })

  test('createDataRegistration posts a flat container member with its UUID Slug', async () => {
    const iri = 'https://data/alice/6f1e6c1e-0000-4000-8000-000000000000'
    const data = {
      id: iri,
      type: [INTEROP.DataRegistration, LDP.Resource],
      registeredShapeTree: 'https://trees/Project',
      contains: [],
      partOf: 'https://data/alice/',
    }

    let posted = ''
    let patchBody = ''
    const recordingFetch = (async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        posted = url
      }
      if (options?.method === 'PATCH') {
        patchBody = options.body as string
      }
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
            if (name === 'Location') {
              return iri
            }
            if (name === 'Link') {
              return '<https://data/alice/>; rel="https://www.w3.org/ns/lws#storage", <https://data/alice/reg.meta>; rel="describedby"'
            }
            return null
          },
        },
      } as unknown as Response
    }) as WhatwgFetch

    await createDataRegistration(data, recordingFetch)
    expect(posted).toBe('https://data/alice/')
    expect(patchBody.startsWith('INSERT DATA { ')).toBe(true)

    const inner = patchBody.replace(/^INSERT DATA \{ /, '').replace(/ \}$/, '')
    const nodes = await jsonld.fromRDF(inner, { format: 'application/n-quads' })
    const node = nodes.find((entry) => entry['@id'] === iri)
    expect(node?.['@type']).toContain(INTEROP.DataRegistration)
  })
})

describe('application-registration write path', () => {
  test('shared context serializes the registration fields to the expected quads', async () => {
    const iri = 'https://registry/alice/app1'
    const data = {
      id: iri,
      type: [INTEROP.ApplicationRegistration, LDP.Resource],
      registeredAgent: 'https://id/test-client',
      hasDataGrant: ['https://registry/alice/g1', 'https://registry/alice/g2'],
    }
    const store = await toStore(withContext(dataModelContext, data), iri)
    expect(store).toBeRdfDatasetContaining(
      DataFactory.quad(
        DataFactory.namedNode(iri),
        RDF.terms.type,
        INTEROP.terms.ApplicationRegistration
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        INTEROP.terms.registeredAgent,
        DataFactory.namedNode('https://id/test-client')
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        INTEROP.terms.hasDataGrant,
        DataFactory.namedNode('https://registry/alice/g1')
      ),
      DataFactory.quad(
        DataFactory.namedNode(iri),
        INTEROP.terms.hasDataGrant,
        DataFactory.namedNode('https://registry/alice/g2')
      )
    )
  })
})
