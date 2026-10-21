import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// `processAuthorizationRevoked` (C2) is a Temporal workflow function:
// `proxyActivities` hands back the scripted activity set and `executeChild`
// records the child starts, so the ORDER is observable: delete the DAs →
// resolve the grantee kind → expand roles → reconcile each affected grantee →
// complete. The chain closure itself runs inside `reconcileGrantsForGrantee`
// (owner side) / the boundary request (peer side).
// ──────────────────────────

const h = vi.hoisted(() => {
  const calls: string[] = []
  const children: { workflow: unknown; options?: { args?: unknown[] } }[] = []
  const activities = {
    deleteAuthorizations: vi.fn(async () => {
      calls.push('delete-authorizations')
    }),
    resolveGranteeKind: vi.fn(async () => ({
      id: 'https://registry/acme/role/admin',
      type: ['http://www.w3.org/ns/solid/interop#Role'],
    })),
    getGrantees: vi.fn(async () => [
      { id: 'https://id/bob', type: ['http://www.w3.org/ns/solid/interop#SocialAgent'] },
    ]),
    markActivitiesDone: vi.fn(async () => {
      calls.push('complete')
    }),
  }
  return { calls, children, activities }
})

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  condition: async () => true,
  defineSignal: (name: string) => name,
  executeChild: vi.fn(async (workflow: unknown, options?: { args?: unknown[] }) => {
    h.children.push({ workflow, options })
    h.calls.push('reconcile')
    return undefined
  }),
  proxyActivities: () => h.activities,
  setHandler: () => {},
  startChild: vi.fn(async () => undefined),
  workflowInfo: () => ({ workflowId: 'authorization-revocation-test' }),
}))

import { processAuthorizationRevoked } from '../src/temporal/workflows/grants.js'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const DATA_AUTHORIZATION = 'http://www.w3.org/ns/solid/interop#DataAuthorization'

const webId = { id: 'https://id/acme', type: [SOCIAL_AGENT_TYPE] }
const refs = [
  {
    id: 'https://registry/acme/authorization/parent',
    type: [DATA_AUTHORIZATION],
  },
  {
    id: 'https://registry/acme/authorization/child',
    type: [DATA_AUTHORIZATION],
  },
]
const activity = {
  id: 'https://registry/acme/activity/revoke',
  type: ['Activity', 'AuthorizationRevoked'],
}

beforeEach(() => {
  h.calls.length = 0
  h.children.length = 0
  h.activities.resolveGranteeKind.mockResolvedValue({
    id: 'https://registry/acme/role/admin',
    type: ['http://www.w3.org/ns/solid/interop#Role'],
  })
  h.activities.getGrantees.mockResolvedValue([{ id: 'https://id/bob', type: [SOCIAL_AGENT_TYPE] }])
})

describe('processAuthorizationRevoked', () => {
  test('deletes the DAs, reconciles every expanded grantee, then completes', async () => {
    await processAuthorizationRevoked(webId, refs, 'https://registry/acme/role/admin', activity)

    expect(h.activities.deleteAuthorizations).toHaveBeenCalledWith({
      webId,
      authorizations: refs,
    })
    expect(h.activities.resolveGranteeKind).toHaveBeenCalledWith({
      webId,
      grantee: 'https://registry/acme/role/admin',
    })
    expect(h.activities.getGrantees).toHaveBeenCalledWith({
      webId,
      grantee: {
        id: 'https://registry/acme/role/admin',
        type: ['http://www.w3.org/ns/solid/interop#Role'],
      },
    })
    expect(h.children).toHaveLength(1)
    expect(h.children[0].options?.args).toEqual([
      {
        webId,
        grantee: { id: 'https://id/bob', type: [SOCIAL_AGENT_TYPE] },
      },
    ])
    expect(h.activities.markActivitiesDone).toHaveBeenCalledWith({
      webId,
      activities: [activity],
    })
    // delete → reconcile → complete
    expect(h.calls).toEqual(['delete-authorizations', 'reconcile', 'complete'])
  })

  test('fan-out reconciles each role member', async () => {
    h.activities.getGrantees.mockResolvedValue([
      { id: 'https://id/bob', type: [SOCIAL_AGENT_TYPE] },
      { id: 'https://id/kim', type: [SOCIAL_AGENT_TYPE] },
    ])

    await processAuthorizationRevoked(webId, refs, 'https://registry/acme/role/admin', activity)

    expect(h.children).toHaveLength(2)
    expect(h.children.map((child) => child.options?.args?.[0])).toEqual([
      { webId, grantee: { id: 'https://id/bob', type: [SOCIAL_AGENT_TYPE] } },
      { webId, grantee: { id: 'https://id/kim', type: [SOCIAL_AGENT_TYPE] } },
    ])
  })
})
