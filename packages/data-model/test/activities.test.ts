import { AS, INTEROP } from '@janeirodigital/interop-utils'
import { frameDoc } from '@janeirodigital/interop-utils'
import { describe, expect, expectTypeOf, test } from 'vitest'

import {
  type ActivityCompleted,
  type ActivityData,
  type AdminAuthorizationGranted,
  type AgentRegistrationAdded,
  type AuthorizationRecorded,
  type InvitationAccepted,
  type InvitationCreated,
  type RoleMembershipChanged,
  dataModelContext,
} from '../src'

// The wire contract (see the OpenWiki `services/activity-lifecycle.md`): the typed activity union
// is the wire shape — as:object forms, flat plain-IRI fields, `as:*` types.

describe('ActivityData typed union', () => {
  test('each activity class is a discriminated union member on type', () => {
    expectTypeOf<InvitationAccepted>().toMatchTypeOf<ActivityData>()
    expectTypeOf<InvitationCreated>().toMatchTypeOf<ActivityData>()
    expectTypeOf<AgentRegistrationAdded>().toMatchTypeOf<ActivityData>()
    expectTypeOf<AdminAuthorizationGranted>().toMatchTypeOf<ActivityData>()
    expectTypeOf<AuthorizationRecorded>().toMatchTypeOf<ActivityData>()
    expectTypeOf<RoleMembershipChanged>().toMatchTypeOf<ActivityData>()
    expectTypeOf<ActivityCompleted>().toMatchTypeOf<ActivityData>()
  })

  test('live-link and snapshot as:object forms', () => {
    // snapshot (InvitationAccepted) — the object embeds the invitation POJO
    expectTypeOf<InvitationAccepted>().toMatchTypeOf<{
      id: string
      target: string
      createdAt: string
      type: ['Activity', 'InvitationAccepted', 'as:Accept']
      actor: string
      object: { id: string; type: string[]; capabilityUrl: string; label: string; note?: string }
    }>()
    // live link (InvitationCreated) — the object is the pre-minted invitation IRI
    expectTypeOf<InvitationCreated>().toMatchTypeOf<{
      type: ['Activity', 'InvitationCreated', 'as:Create']
      actor: string
      label: string
      note?: string
      object: string
    }>()
    // sets (AuthorizationGranted / role classes) — plain-IRI object arrays
    expectTypeOf<AuthorizationGranted>().toMatchTypeOf<{
      type: ['Activity', 'AuthorizationGranted']
      actor: string
      target: string
      object: string[]
    }>()
    expectTypeOf<RoleMembershipChanged>().toMatchTypeOf<{
      type: ['Activity', 'RoleMembershipChanged']
      actor: string
      target: string
      object: string[]
    }>()
  })

  test('no { activityType, payload } legacy shape is exported', () => {
    expectTypeOf<ActivityData>().not.toMatchTypeOf<{ activityType: string; payload: unknown }>()
  })
})

describe('dataModelContext activity terms', () => {
  test('activity class types frame to bare terms + the as:* compact IRI', async () => {
    const doc = {
      '@id': 'https://alice.example/activities/abc',
      '@type': [INTEROP.Activity, INTEROP.InvitationAccepted, AS.Accept],
      [AS.actor]: { '@id': 'https://alice.example/#me' },
      [AS.target]: { '@id': 'https://alice.example/registry' },
      [AS.object]: {
        '@id': 'urn:uuid:00000000-0000-0000-0000-000000000000',
        '@type': [INTEROP.SocialAgentInvitation],
        [INTEROP.hasCapabilityUrl]: { '@id': 'https://alice.example/invitations/abc' },
        'http://www.w3.org/2004/02/skos/core#prefLabel': { '@value': 'Dan' },
      },
      [INTEROP.createdAt]: { '@value': '2024-01-01T00:00:00.000Z' },
    }
    const node = await frameDoc(doc, dataModelContext, 'https://alice.example/activities/abc', {
      object: { '@embed': '@always' },
    })
    expect(node.type).toEqual(['Activity', 'InvitationAccepted', 'as:Accept'])
    expect(node.actor).toBe('https://alice.example/#me')
    expect(node.target).toBe('https://alice.example/registry')
    expect(node.object).toMatchObject({
      id: 'urn:uuid:00000000-0000-0000-0000-000000000000',
      capabilityUrl: 'https://alice.example/invitations/abc',
      label: { '@none': 'Dan' },
    })
  })

  test('a live-link object frames to a plain IRI string (no embed)', async () => {
    const doc = {
      '@id': 'https://alice.example/activities/def',
      '@type': [INTEROP.Activity, INTEROP.InvitationCreated, AS.Create],
      [AS.actor]: { '@id': 'https://alice.example/#me' },
      [AS.target]: { '@id': 'https://alice.example/invitation-registry' },
      [AS.object]: { '@id': 'https://alice.example/invitations/xyz' },
      [INTEROP.createdAt]: { '@value': '2024-01-01T00:00:00.000Z' },
    }
    const node = await frameDoc(doc, dataModelContext, 'https://alice.example/activities/def', {
      object: { '@embed': '@always' },
    })
    expect(node.type).toEqual(['Activity', 'InvitationCreated', 'as:Create'])
    expect(node.object).toBe('https://alice.example/invitations/xyz')
  })
})
