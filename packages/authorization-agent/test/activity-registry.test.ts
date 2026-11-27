import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import type { SparqlTransport } from '@janeirodigital/interop-authorization-agent'
import { dataModelContext } from '@janeirodigital/interop-data-model'
import { AS, INTEROP, LDP, RDF } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, test } from 'vitest'

import { expect } from './expect'

// The wire contract (see the OpenWiki `services/activity-lifecycle.md`):
// JSON-LD `@type` is an unordered set — the
// SPARQL-backed store may frame it back in ANY order (the dagger runs showed
// `["AuthorizationGranted", "Activity"]`). loadActivity must discriminate by
// set membership and canonicalize the tuple, or every consumer (handler
// decode, pending filters, the events bus) breaks.

function mockFetch(doc: Record<string, unknown>): (url: string) => Promise<Response> {
  return async (url: string) =>
    ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'application/ld+json' },
      json: async () => doc,
    }) as unknown as Response
}

describe('ActivityRegistry.loadActivity — unordered type set', () => {
  test('canonicalizes a reversed class tuple', async () => {
    // the store returned the types in reverse of the write order
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/alice/abc',
      '@type': ['AuthorizationGranted', 'Activity'],
      actor: 'https://id/alice',
      target: 'https://registry/alice/authorization/',
      // embedded single-DA form (the legacy live-link string[] form was
      // dropped — refinement §5.1)
      object: [
        {
          '@id': 'https://registry/alice/o1',
          '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
          grantee: 'https://id/bob',
          grantedBy: 'https://id/alice',
          registeredShapeTree: 'https://data/shapetrees/trees/Project',
          scopeOfAuthorization: 'http://www.w3.org/ns/solid/interop#SelectedFromRegistry',
          dataOwner: 'https://id/alice',
          hasDataRegistration: 'https://data/alice-home/',
          accessMode: ['http://www.w3.org/ns/odrl/2/read'],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/alice/abc',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'AuthorizationGranted'])
    expect(activity.actor).toBe('https://id/alice')
    expect(activity.object).toEqual([expect.objectContaining({ id: 'https://registry/alice/o1' })])
  })

  test('reorders an ASV-bearing reversed tuple (class first, not position-bound)', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/kim/xyz',
      '@type': ['as:Accept', 'InvitationAccepted', 'Activity'],
      actor: 'https://id/kim',
      target: 'https://registry/kim/',
      object: {
        '@id': 'urn:uuid:00000000-0000-0000-0000-000000000000',
        '@type': ['SocialAgentInvitation'],
        capabilityUrl: 'https://auth/.sai/invitations/abc',
        label: 'Dan',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity('https://registry/kim/xyz', mockFetch(doc))
    expect(activity.type).toEqual(['Activity', 'InvitationAccepted', 'as:Accept'])
    expect((activity as { object: { label: unknown } }).object.label).toEqual({ '@none': 'Dan' })
  })

  test('recognizes the completion class in any order', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/alice/done',
      '@type': ['ActivityCompleted', 'Activity'],
      target: 'https://registry/alice/abc',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/alice/done',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'ActivityCompleted'])
    expect(activity.target).toBe('https://registry/alice/abc')
  })

  test('embeds a revoked-admin snapshot object (RPC deleted the resource)', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/yoyo/rev',
      '@type': ['Activity', 'AdminAuthorizationRevoked'],
      actor: 'https://id/yoyo',
      target: 'https://registry/yoyo/authorization/',
      object: {
        '@id': 'urn:uuid:11111111-2222-3333-4444-555555555555',
        '@type': ['http://www.w3.org/ns/solid/interop#AdminAuthorization'],
        grantee: 'https://id/bob',
        grantedBy: 'https://id/yoyo',
        scopeOfAuthorization: 'http://www.w3.org/ns/solid/interop#All',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/yoyo/rev',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'AdminAuthorizationRevoked'])
    expect((activity as { object: { grantee: string } }).object.grantee).toBe('https://id/bob')
  })

  test('normalizes the revoked-authorization refs + grantee (C2 carrier)', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/acme/revoke',
      '@type': ['Activity', 'AuthorizationRevoked'],
      actor: 'https://id/acme',
      object: [
        {
          '@id': 'https://registry/acme/parent',
          '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
        },
        {
          '@id': 'https://registry/acme/child',
          '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
        },
      ],
      grantee: 'https://data/test-client/public/id',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/acme/revoke',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'AuthorizationRevoked'])
    expect(activity).toMatchObject({
      grantee: 'https://data/test-client/public/id',
      object: [
        {
          id: 'https://registry/acme/parent',
          type: ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
        },
        {
          id: 'https://registry/acme/child',
          type: ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
        },
      ],
    })
    expect(activity).not.toHaveProperty('target')
  })

  test('embeds the denied-authorization structure snapshot (AuthorizationDenied — Step 4)', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/bob/deny',
      '@type': ['Activity', 'AuthorizationDenied'],
      actor: 'https://id/bob',
      object: {
        '@id': 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        '@type': ['http://www.w3.org/ns/solid/interop#AuthorizationStructure'],
        grantee: 'https://data/test-client/public/id',
        hasAccessNeedGroup: 'https://data/test-client/public/access-needs#need-group-pm',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/bob/deny',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'AuthorizationDenied'])
    // a single rdf:type frames as a scalar — normalized back to string[]
    expect((activity as { object: { type: Array<string> } }).object.type).toEqual([
      'http://www.w3.org/ns/solid/interop#AuthorizationStructure',
    ])
    expect((activity as { object: { grantee: string } }).object.grantee).toBe(
      'https://data/test-client/public/id'
    )
  })

  test('embeds the granted DataAuthorization POJOs-to-be (activity-first step 2)', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/alice/grant',
      '@type': ['Activity', 'AuthorizationGranted'],
      actor: 'https://id/alice',
      target: 'https://registry/alice/authorization/',
      object: [
        {
          '@id': 'https://registry/alice/da-1',
          '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
          grantee: 'https://id/bob',
          grantedBy: 'https://id/alice',
          registeredShapeTree: 'https://data/shapetrees/pm#Project',
          scopeOfAuthorization: 'http://www.w3.org/ns/solid/interop#AllFromRegistry',
          dataOwner: 'https://id/alice',
          hasDataRegistration: 'https://data/alice/project/',
          satisfiesAccessNeed: 'https://data/shapetrees/pm#need-project',
          accessMode: ['http://www.w3.org/ns/odrl/2/read'],
          hasInheritingAuthorization: ['https://registry/alice/da-1-child'],
        },
        {
          '@id': 'https://registry/alice/da-1-child',
          '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
          grantee: 'https://id/bob',
          grantedBy: 'https://id/alice',
          registeredShapeTree: 'https://data/shapetrees/task#Task',
          scopeOfAuthorization: 'http://www.w3.org/ns/solid/interop#Inherited',
          dataOwner: 'https://id/alice',
          inheritsFromAuthorization: 'https://registry/alice/da-1',
          accessMode: [
            'http://www.w3.org/ns/odrl/2/modify',
            'https://www.w3.org/ns/lws#create',
            'http://www.w3.org/ns/odrl/2/delete',
          ],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = (await ActivityRegistry.loadActivity(
      'https://registry/alice/grant',
      mockFetch(doc)
    )) as unknown as {
      type: Array<string>
      object: Array<{
        id: string
        grantee: string
        scopeOfAuthorization: string
        satisfiesAccessNeed?: string
        hasInheritingAuthorization?: Array<string>
        inheritsFromAuthorization?: string
      }>
    }
    expect(activity.type).toEqual(['Activity', 'AuthorizationGranted'])
    expect(activity.object).toHaveLength(2)
    // each embedded node decodes to a DataAuthorizationData POJO at its real id
    expect(activity.object[0].id).toBe('https://registry/alice/da-1')
    expect(activity.object[0].grantee).toBe('https://id/bob')
    expect(activity.object[0].scopeOfAuthorization).toBe(
      'http://www.w3.org/ns/solid/interop#AllFromRegistry'
    )
    // two-phase framing (docs/jsonld.md TODO 2): each object re-frames the
    // SAME doc by its own id — @reverse RESOLVES at the top-level matched
    // node, so the parent's children (written as @reverse terms on the wire)
    // come back as plain-IRI strings, and the child's forward
    // `inheritsFromAuthorization` re-links it in the store
    expect(activity.object[0].hasInheritingAuthorization).toEqual([
      'https://registry/alice/da-1-child',
    ])
    expect(activity.object[1].id).toBe('https://registry/alice/da-1-child')
    expect(activity.object[1].inheritsFromAuthorization).toBe('https://registry/alice/da-1')
  })

  test('embeds a SINGLE granted DataAuthorization POJO-to-be (share — one DA per activity)', async () => {
    // a single embedded node frames as an OBJECT, not an array — the decoder
    // must detect the DA rdf:type and wrap it (share writes one DA per
    // grantee; regression: the share flow timed out because the snapshot
    // branch swallowed the DA and the workflow never materialized)
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/alice/share-single',
      '@type': ['Activity', 'AuthorizationGranted'],
      actor: 'https://id/alice',
      target: 'https://registry/alice/authorization/',
      object: {
        '@id': 'https://registry/alice/da-share-1',
        '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
        grantee: 'https://id/kim',
        grantedBy: 'https://id/alice',
        registeredShapeTree: 'https://data/shapetrees/trees/Project',
        scopeOfAuthorization: 'http://www.w3.org/ns/solid/interop#SelectedFromRegistry',
        dataOwner: 'https://id/alice',
        hasDataRegistration: 'https://data/alice-home/',
        accessMode: ['http://www.w3.org/ns/odrl/2/read'],
        hasDataInstance: 'https://data/alice-home/n8k3wp',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = (await ActivityRegistry.loadActivity(
      'https://registry/alice/share-single',
      mockFetch(doc)
    )) as unknown as {
      type: Array<string>
      object: Array<{
        grantee: string
        scopeOfAuthorization: string
        hasDataInstance?: Array<string>
      }>
    }
    expect(activity.type).toEqual(['Activity', 'AuthorizationGranted'])
    expect(activity.object).toHaveLength(1)
    expect(activity.object[0].grantee).toBe('https://id/kim')
    expect(activity.object[0].scopeOfAuthorization).toBe(
      'http://www.w3.org/ns/solid/interop#SelectedFromRegistry'
    )
    expect(activity.object[0].hasDataInstance).toEqual(['https://data/alice-home/n8k3wp'])
  })

  test('embeds the InvitationCreated object — the invitation-to-be POJO with type normalized', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/dan/create',
      '@type': ['Activity', 'InvitationCreated', 'as:Create'],
      actor: 'https://id/dan',
      // no target — the invitation id rides the embedded object
      // (a single rdf:type frames as a scalar — normalized back to string[])
      object: {
        '@id': 'https://registry/dan/abc',
        '@type': 'http://www.w3.org/ns/solid/interop#SocialAgentInvitation',
        label: 'Kim',
        note: 'Some note',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/dan/create',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'InvitationCreated', 'as:Create'])
    expect(activity.object).toEqual({
      id: 'https://registry/dan/abc',
      type: ['http://www.w3.org/ns/solid/interop#SocialAgentInvitation'],
      label: { '@none': 'Kim' },
      note: 'Some note',
    })
    // no flat activity-level label/note leaked from the old shape
    expect((activity as Record<string, unknown>).label).toBeUndefined()
    expect((activity as Record<string, unknown>).note).toBeUndefined()
    // no target — dropped with the embedded object form
    expect((activity as Record<string, unknown>).target).toBeUndefined()
  })

  test('canonicalizes the AccessRequestGranted resolution (light snapshot ref)', async () => {
    // requester-side close — the object is the light `{ id, type }` ref of
    // the Sent activity's SNAPSHOT id (see the OpenWiki
    // `services/activity-lifecycle.md`);
    // reversed tuple exercises set-membership discrimination again
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/bob/granted',
      '@type': ['AccessRequestGranted', 'Activity'],
      actor: 'https://id/bob',
      object: {
        '@id': 'urn:uuid:5c9e3a72-4d1f-4a8b-9c2e-0f1a2b3c4d5e',
        '@type': ['http://www.w3.org/ns/solid/interop#NeedBasedAccessRequest'],
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/bob/granted',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'AccessRequestGranted'])
    expect(activity.actor).toBe('https://id/bob')
    // no target — dropped with the light ref form
    expect((activity as Record<string, unknown>).target).toBeUndefined()
    expect((activity as { object: { id: string; type: Array<string> } }).object).toEqual({
      id: 'urn:uuid:5c9e3a72-4d1f-4a8b-9c2e-0f1a2b3c4d5e',
      // the class term has a context def — frames to the BARE term (same
      // normalization the Sent snapshot's type goes through)
      type: ['NeedBasedAccessRequest'],
    })
  })

  test('reads an AccessRequestArchived resolution (light snapshot ref)', async () => {
    const doc = {
      '@context': dataModelContext,
      '@id': 'https://registry/bob/archived',
      '@type': ['Activity', 'AccessRequestArchived'],
      actor: 'https://id/bob',
      // a single rdf:type frames as a scalar — the case normalizes to array
      object: {
        '@id': 'urn:uuid:5c9e3a72-4d1f-4a8b-9c2e-0f1a2b3c4d5e',
        '@type': 'http://www.w3.org/ns/solid/interop#NeedBasedAccessRequest',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const activity = await ActivityRegistry.loadActivity(
      'https://registry/bob/archived',
      mockFetch(doc)
    )
    expect(activity.type).toEqual(['Activity', 'AccessRequestArchived'])
    expect((activity as { object: { type: Array<string> } }).object.type).toEqual([
      'NeedBasedAccessRequest',
    ])
  })

  test('carries the satisfiesAccessRequest back-link on granted + denied (owner-span close)', async () => {
    // the flat activity-level back-link (see the OpenWiki
    // `services/activity-lifecycle.md`);
    // absent on direct approvals (without a request)
    const grantedDoc = {
      '@context': dataModelContext,
      '@id': 'https://registry/alice/grant-req',
      '@type': ['Activity', 'AuthorizationGranted'],
      actor: 'https://id/alice',
      target: 'https://registry/alice/authorization/',
      satisfiesAccessRequest: 'https://registry/alice/3d7a5c9e-1f2b-4c6d-8e9a-0b1c2d3e4f5a',
      object: [
        {
          '@id': 'https://registry/alice/da-1',
          '@type': ['http://www.w3.org/ns/solid/interop#DataAuthorization'],
          grantee: 'https://id/bob',
          grantedBy: 'https://id/alice',
          registeredShapeTree: 'https://data/shapetrees/trees/Project',
          scopeOfAuthorization: 'http://www.w3.org/ns/solid/interop#AllFromAgent',
          dataOwner: 'https://id/alice',
          accessMode: ['http://www.w3.org/ns/odrl/2/read'],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const granted = (await ActivityRegistry.loadActivity(
      'https://registry/alice/grant-req',
      mockFetch(grantedDoc)
    )) as unknown as { satisfiesAccessRequest?: string }
    expect(granted.satisfiesAccessRequest).toBe(
      'https://registry/alice/3d7a5c9e-1f2b-4c6d-8e9a-0b1c2d3e4f5a'
    )

    const deniedDoc = {
      '@context': dataModelContext,
      '@id': 'https://registry/alice/deny-req',
      '@type': ['Activity', 'AuthorizationDenied'],
      actor: 'https://id/alice',
      satisfiesAccessRequest: 'https://registry/alice/3d7a5c9e-1f2b-4c6d-8e9a-0b1c2d3e4f5a',
      object: {
        '@id': 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        '@type': ['http://www.w3.org/ns/solid/interop#AuthorizationStructure'],
        grantee: 'https://id/bob',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const denied = (await ActivityRegistry.loadActivity(
      'https://registry/alice/deny-req',
      mockFetch(deniedDoc)
    )) as unknown as { satisfiesAccessRequest?: string }
    expect(denied.satisfiesAccessRequest).toBe(
      'https://registry/alice/3d7a5c9e-1f2b-4c6d-8e9a-0b1c2d3e4f5a'
    )
  })
})

// ──────────────────────────
// Registry-plane activity reads (listContained + typed completion SELECT)
// ──────────────────────────

describe('ActivityRegistry — registry plane', () => {
  const registry = { id: 'https://registry.example/alice/activity/' }
  const PENDING = `${registry.id}pending`
  const DONE = `${registry.id}done`
  const COMPLETION = `${registry.id}completion`

  const quad = (subject: string, predicate: string, object: string) =>
    DataFactory.quad(
      DataFactory.namedNode(subject),
      DataFactory.namedNode(predicate),
      DataFactory.namedNode(object)
    )

  const transport = (): SparqlTransport => ({
    async fetchBindings(query: string) {
      if (query.includes('lws#contains')) {
        return [PENDING, DONE, COMPLETION].map((iri) => ({
          child: { termType: 'NamedNode', value: iri },
        }))
      }
      // the typed completion SELECT: rows carry the completion + its target
      expect(query).toContain(INTEROP.ActivityCompleted)
      expect(query).toContain(AS.target)
      return [
        {
          activity: { termType: 'NamedNode', value: COMPLETION },
          target: { termType: 'NamedNode', value: DONE },
        },
      ]
    },
    async fetchTriples(query: string) {
      if (query.includes(`GRAPH <${PENDING}>`)) {
        return [
          // the meta-graph twin types the resource `ldp:Resource` — the plane
          // read must not mistake it for the activity class
          quad(PENDING, RDF.type, LDP.Resource),
          quad(PENDING, RDF.type, INTEROP.Activity),
          quad(PENDING, RDF.type, INTEROP.InvitationCreated),
          quad(PENDING, RDF.type, AS.Create),
        ]
      }
      throw new Error(`unexpected CONSTRUCT: ${query}`)
    },
  })

  test('lists the registry members and the completion rows', async () => {
    await expect(ActivityRegistry.getActivityIris(registry, transport())).resolves.toEqual([
      PENDING,
      DONE,
      COMPLETION,
    ])
    await expect(ActivityRegistry.getActivityCompletions(registry, transport())).resolves.toEqual([
      { completion: COMPLETION, target: DONE },
    ])
    await expect(ActivityRegistry.getCompletedActivityIris(registry, transport())).resolves.toEqual(
      [DONE]
    )
  })

  test('frames an activity body from its graph', async () => {
    const activity = (await ActivityRegistry.getActivity(transport(), PENDING)) as unknown as {
      id: string
      type: Array<string>
    }
    expect(activity.id).toBe(PENDING)
    expect(activity.type).toEqual(['Activity', 'InvitationCreated', 'as:Create'])
  })
})
