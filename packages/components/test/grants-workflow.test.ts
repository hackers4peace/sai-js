import { INTEROP } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// `reconcileGrantsForGrantee` (the `createGrantsForAgent` body) is a Temporal
// workflow function: `proxyActivities` hands back the scripted activity set.
// This test pins the **projection + GC** contract (D13): value-based reuse,
// `existing − reused` removed before creation, removal grouped by `dataOwner`
// (own registry → C1 closure delete; peer-owned → boundary request + replica
// drop), the orphan scan joined with the projection, and the deny case as the
// empty desired set.
// ──────────────────────────

const h = vi.hoisted(() => {
  const activities = {
    getAuthorizations: vi.fn(async () => [] as { id: string; type: string[] }[]),
    getExistingGrants: vi.fn(async () => [] as { id: string; type: string[] }[]),
    getRegistryGrantsForGrantee: vi.fn(async () => [] as { id: string; type: string[] }[]),
    getExistingGrantBodies: vi.fn(async () => [] as Record<string, unknown>[]),
    generateGrants: vi.fn(async () => ({ sourceGrants: [], delegatedGrants: [] })),
    checkEquivalence: vi.fn(async () => ({
      reusedSourceIds: [],
      reusedDelegatedIndexes: [],
      reusedExisting: [],
    })),
    storeDataGrant: vi.fn(async () => {}),
    createAcr: vi.fn(async () => {}),
    requestDelegations: vi.fn(async () => [] as { id: string; type: string[] }[]),
    requestRevocations: vi.fn(async () => [] as string[]),
    revokeGrantClosure: vi.fn(async () => [] as string[]),
    deleteDataGrants: vi.fn(async () => {}),
    removeGrantsFromRegistrations: vi.fn(async () => {}),
    dropGrantReplicas: vi.fn(async () => {}),
    replaceDataGrantsOnRegistration: vi.fn(async () => {}),
  }
  return { activities }
})

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  condition: async () => true,
  defineSignal: (name: string) => name,
  executeChild: vi.fn(async () => undefined),
  proxyActivities: () => h.activities,
  setHandler: () => {},
  startChild: vi.fn(async () => undefined),
  workflowInfo: () => ({ workflowId: 'create-grants-for-agent-test' }),
}))

import { createGrantsForAgent, revokeGrants } from '../src/temporal/workflows/grants.js'

const SOCIAL_AGENT_TYPE = 'http://www.w3.org/ns/solid/interop#SocialAgent'
const DATA_GRANT = 'http://www.w3.org/ns/solid/interop#DataGrant'
const DATA_AUTHORIZATION = 'http://www.w3.org/ns/solid/interop#DataAuthorization'

const ALICE = 'https://id/alice'
const ACME = 'https://id/acme'
const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'

const webId = { id: ACME, type: [SOCIAL_AGENT_TYPE] }
const grantee = { id: ALICE, type: [SOCIAL_AGENT_TYPE] }

const grantIri = (suffix: string) => `https://registry/acme/grant/${suffix}`
const grantId = (suffix: string) => ({ id: grantIri(suffix), type: [DATA_GRANT] })

/** A source grant (we are dataOwner) — `FinalGrantData` shape. */
const sourceGrant = (suffix: string, overrides: Record<string, unknown> = {}) => ({
  id: grantIri(suffix),
  type: [DATA_GRANT],
  grantee: ALICE,
  grantedBy: ACME,
  dataOwner: ACME,
  registeredShapeTree: PROJECT_TREE,
  hasDataRegistration: 'https://data/acme/registrations/projects/',
  hasStorage: 'https://data/acme/',
  scopeOfGrant: INTEROP.AllFromRegistry,
  accessMode: [INTEROP.Read],
  ...overrides,
})

/** A delegated grant (we are grantedBy, the peer is dataOwner) — no id yet. */
const delegatedGrant = (overrides: Record<string, unknown> = {}) => ({
  type: [DATA_GRANT],
  grantee: ALICE,
  grantedBy: ACME,
  dataOwner: ALICE,
  registeredShapeTree: PROJECT_TREE,
  hasDataRegistration: 'https://data/alice/registrations/projects/',
  hasStorage: 'https://data/alice/',
  scopeOfGrant: INTEROP.AllFromRegistry,
  accessMode: [INTEROP.Read],
  ...overrides,
})

/** One authorization makes the workflow take the generate path. */
const authorization = { id: 'https://registry/acme/authorization/da1', type: [DATA_AUTHORIZATION] }

/** The body `getExistingGrantBodies` returns for an existing grant. */
const body = (id: { id: string; type: string[] }, dataOwner: string) => ({
  id: id.id,
  type: id.type,
  dataOwner,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.activities.getAuthorizations.mockResolvedValue([authorization])
  h.activities.getExistingGrants.mockResolvedValue([])
  h.activities.getRegistryGrantsForGrantee.mockResolvedValue([])
  h.activities.getExistingGrantBodies.mockResolvedValue([])
  h.activities.generateGrants.mockResolvedValue({ sourceGrants: [], delegatedGrants: [] })
  h.activities.checkEquivalence.mockResolvedValue({
    reusedSourceIds: [],
    reusedDelegatedIndexes: [],
    reusedExisting: [],
  })
  h.activities.requestDelegations.mockResolvedValue([])
})

describe('reconcileGrantsForGrantee — projection + GC', () => {
  test('stores and delegates everything when nothing is reused, removing the old own grants', async () => {
    const parent = sourceGrant('s-parent', { hasInheritingGrant: [grantIri('s-child')] })
    const child = sourceGrant('s-child', {
      inheritsFromGrant: grantIri('s-parent'),
      registeredShapeTree: TASK_TREE,
      scopeOfGrant: INTEROP.Inherited,
    })
    const delegated = delegatedGrant()
    const existing = [grantId('e-parent'), grantId('e-child')]
    h.activities.getExistingGrants.mockResolvedValue(existing)
    h.activities.getExistingGrantBodies.mockResolvedValue(
      existing.map((grant) => body(grant, ACME))
    )
    h.activities.generateGrants.mockResolvedValue({
      sourceGrants: [parent, child],
      delegatedGrants: [delegated],
    })
    h.activities.requestDelegations.mockResolvedValue([grantId('new-delegated')])

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.checkEquivalence).toHaveBeenCalledWith({
      webId,
      grantee,
      generated: { sourceGrants: [parent, child], delegatedGrants: [delegated] },
      existing,
    })
    // the GC happens before the creates (delete-before-create)
    expect(h.activities.revokeGrantClosure).toHaveBeenCalledWith({ webId, grants: existing })
    expect(h.activities.storeDataGrant).toHaveBeenCalledTimes(2)
    expect(h.activities.createAcr).toHaveBeenCalledTimes(2)
    expect(h.activities.requestDelegations).toHaveBeenCalledWith({
      webId,
      grants: [delegated],
    })
    expect(h.activities.replaceDataGrantsOnRegistration).toHaveBeenCalledWith({
      webId,
      grantee,
      grants: [grantId('s-parent'), grantId('s-child'), grantId('new-delegated')],
    })
  })

  test('skips every reused source grant and delegation, re-linking all existing IRIs', async () => {
    const parent = sourceGrant('s-parent', { hasInheritingGrant: [grantIri('s-child')] })
    const child = sourceGrant('s-child', {
      inheritsFromGrant: grantIri('s-parent'),
      registeredShapeTree: TASK_TREE,
      scopeOfGrant: INTEROP.Inherited,
    })
    const delegated = delegatedGrant()
    const existing = [
      grantId('e-parent'),
      grantId('e-child'),
      grantId('e-delegated'),
      grantId('e-delegated-child'),
    ]
    h.activities.getExistingGrants.mockResolvedValue(existing)
    h.activities.generateGrants.mockResolvedValue({
      sourceGrants: [parent, child],
      delegatedGrants: [delegated],
    })
    h.activities.checkEquivalence.mockResolvedValue({
      reusedSourceIds: [parent.id, child.id],
      reusedDelegatedIndexes: [0],
      reusedExisting: existing,
    })

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.revokeGrantClosure).not.toHaveBeenCalled()
    expect(h.activities.requestRevocations).not.toHaveBeenCalled()
    expect(h.activities.storeDataGrant).not.toHaveBeenCalled()
    expect(h.activities.createAcr).not.toHaveBeenCalled()
    expect(h.activities.requestDelegations).not.toHaveBeenCalled()
    // the full-set PATCH must keep parents AND children; an empty diff
    expect(h.activities.replaceDataGrantsOnRegistration).toHaveBeenCalledWith({
      webId,
      grantee,
      grants: existing,
    })
  })

  test('replaces only the non-reused grants and keeps the reused subtree linked', async () => {
    const reusedSource = sourceGrant('s-reused')
    const newSource = sourceGrant('s-new')
    const requestedDelegated = delegatedGrant()
    const reusedDelegated = delegatedGrant()
    const existing = [grantId('e-reused'), grantId('e-old')]
    h.activities.getExistingGrants.mockResolvedValue(existing)
    h.activities.getExistingGrantBodies.mockResolvedValue([body(grantId('e-old'), ACME)])
    // index 1 (the second delegated grant) is the reused one
    h.activities.generateGrants.mockResolvedValue({
      sourceGrants: [reusedSource, newSource],
      delegatedGrants: [requestedDelegated, reusedDelegated],
    })
    h.activities.checkEquivalence.mockResolvedValue({
      reusedSourceIds: [reusedSource.id],
      reusedDelegatedIndexes: [1],
      reusedExisting: [grantId('e-reused')],
    })
    h.activities.requestDelegations.mockResolvedValue([grantId('new-delegated')])

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.revokeGrantClosure).toHaveBeenCalledWith({
      webId,
      grants: [grantId('e-old')],
    })
    expect(h.activities.storeDataGrant).toHaveBeenCalledTimes(1)
    expect(h.activities.storeDataGrant).toHaveBeenCalledWith(newSource)
    expect(h.activities.createAcr).toHaveBeenCalledTimes(1)
    expect(h.activities.createAcr).toHaveBeenCalledWith(newSource)
    expect(h.activities.requestDelegations).toHaveBeenCalledTimes(1)
    expect(h.activities.requestDelegations).toHaveBeenCalledWith({
      webId,
      grants: [requestedDelegated],
    })
    expect(h.activities.replaceDataGrantsOnRegistration).toHaveBeenCalledWith({
      webId,
      grantee,
      grants: [grantId('s-new'), grantId('new-delegated'), grantId('e-reused')],
    })
  })

  test('deny case is the empty desired set: removes all existing and clears the registration', async () => {
    h.activities.getAuthorizations.mockResolvedValue([])
    h.activities.getExistingGrants.mockResolvedValue([grantId('e-parent')])
    h.activities.getExistingGrantBodies.mockResolvedValue([body(grantId('e-parent'), ACME)])

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.generateGrants).not.toHaveBeenCalled()
    expect(h.activities.checkEquivalence).toHaveBeenCalledWith({
      webId,
      grantee,
      generated: { sourceGrants: [], delegatedGrants: [] },
      existing: [grantId('e-parent')],
    })
    expect(h.activities.revokeGrantClosure).toHaveBeenCalledWith({
      webId,
      grants: [grantId('e-parent')],
    })
    expect(h.activities.replaceDataGrantsOnRegistration).toHaveBeenCalledWith({
      webId,
      grantee,
      grants: [],
    })
  })

  test('peer-owned non-reused grants go through the boundary and drop their replica', async () => {
    const delegated = delegatedGrant()
    const existing = [grantId('e-delegated')]
    h.activities.getExistingGrants.mockResolvedValue(existing)
    h.activities.getExistingGrantBodies.mockResolvedValue([body(grantId('e-delegated'), ALICE)])
    h.activities.generateGrants.mockResolvedValue({
      sourceGrants: [],
      delegatedGrants: [delegated],
    })

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.revokeGrantClosure).not.toHaveBeenCalled()
    expect(h.activities.requestRevocations).toHaveBeenCalledWith({
      webId,
      dataOwner: ALICE,
      grants: [grantId('e-delegated')],
    })
    expect(h.activities.dropGrantReplicas).toHaveBeenCalledWith({
      webId,
      grants: [grantIri('e-delegated')],
    })
  })

  test('the own-registry orphan scan joins the projection before equivalence', async () => {
    const orphan = grantId('e-orphan')
    h.activities.getExistingGrants.mockResolvedValue([])
    h.activities.getRegistryGrantsForGrantee.mockResolvedValue([orphan])
    h.activities.getExistingGrantBodies.mockResolvedValue([body(orphan, ACME)])

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.checkEquivalence).toHaveBeenCalledWith({
      webId,
      grantee,
      generated: { sourceGrants: [], delegatedGrants: [] },
      existing: [orphan],
    })
    expect(h.activities.revokeGrantClosure).toHaveBeenCalledWith({
      webId,
      grants: [orphan],
    })
  })

  test('a peer-owned grant with a missing body is left to the owner sweep', async () => {
    h.activities.getExistingGrants.mockResolvedValue([grantId('e-parent')])
    h.activities.getExistingGrantBodies.mockResolvedValue([])

    await createGrantsForAgent({ webId, grantee })

    // no body → cannot owner-group it; nothing is deleted here (the owner's
    // sweep/closure cleans the orphan)
    expect(h.activities.revokeGrantClosure).not.toHaveBeenCalled()
    expect(h.activities.requestRevocations).not.toHaveBeenCalled()
    expect(h.activities.replaceDataGrantsOnRegistration).toHaveBeenCalledWith({
      webId,
      grantee,
      grants: [],
    })
  })

  test('an own-registry grant with a missing body is still removed by IRI', async () => {
    h.activities.getExistingGrants.mockResolvedValue([grantId('e-parent')])
    h.activities.getRegistryGrantsForGrantee.mockResolvedValue([grantId('e-parent')])
    h.activities.getExistingGrantBodies.mockResolvedValue([])

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.revokeGrantClosure).toHaveBeenCalledWith({
      webId,
      grants: [grantId('e-parent')],
    })
  })
})

describe('revokeGrants — owner-side delete + projection patch (C4)', () => {
  const parent = grantId('p-parent')
  const child = grantId('p-child')
  const groups = [
    { grantee: ALICE, grants: [parent.id, child.id] },
    { grantee: 'https://id/bob', grants: ['https://registry/acme/grant/b-parent'] },
  ]

  test('deletes the closure first, then clears the registration links per grantee', async () => {
    await revokeGrants({ webId, grants: [parent, child], projection: groups })

    expect(h.activities.deleteDataGrants).toHaveBeenCalledWith({
      webId,
      grants: [parent, child],
      projection: groups,
    })
    expect(h.activities.removeGrantsFromRegistrations).toHaveBeenCalledWith({
      webId,
      groups,
    })
    const deleteOrder = h.activities.deleteDataGrants.mock.invocationCallOrder[0]
    const patchOrder = h.activities.removeGrantsFromRegistrations.mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(patchOrder)
  })

  test('a payload without a projection only deletes (older/internal callers)', async () => {
    await revokeGrants({ webId, grants: [parent] })

    expect(h.activities.deleteDataGrants).toHaveBeenCalledWith({ webId, grants: [parent] })
    expect(h.activities.removeGrantsFromRegistrations).not.toHaveBeenCalled()
  })
})
