import { INTEROP } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// `createGrantsForAgent` is a Temporal workflow function: `proxyActivities`
// hands back the scripted activity set. This test pins the VALUE-BASED reuse
// contract — activity results cross Temporal's data converter, so a result
// keyed on object identity would silently skip nothing (the bug the old
// `Set<GrantData>` had). It also pins that a reused subtree re-links every
// existing child IRI: `replaceDataGrantsOnRegistration` writes the FULL set.
// ──────────────────────────

const h = vi.hoisted(() => {
  const activities = {
    getAuthorizations: vi.fn(async () => [] as { id: string; type: string[] }[]),
    getExistingGrants: vi.fn(async () => [] as { id: string; type: string[] }[]),
    generateGrants: vi.fn(async () => ({ sourceGrants: [], delegatedGrants: [] })),
    checkEquivalence: vi.fn(async () => ({
      reusedSourceIds: [],
      reusedDelegatedIndexes: [],
      reusedExisting: [],
    })),
    storeDataGrant: vi.fn(async () => {}),
    createAcr: vi.fn(async () => {}),
    requestDelegations: vi.fn(async () => [] as { id: string; type: string[] }[]),
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

import { createGrantsForAgent } from '../src/temporal/workflows/grants.js'

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

beforeEach(() => {
  vi.clearAllMocks()
  h.activities.getAuthorizations.mockResolvedValue([authorization])
  h.activities.getExistingGrants.mockResolvedValue([])
  h.activities.generateGrants.mockResolvedValue({ sourceGrants: [], delegatedGrants: [] })
  h.activities.checkEquivalence.mockResolvedValue({
    reusedSourceIds: [],
    reusedDelegatedIndexes: [],
    reusedExisting: [],
  })
  h.activities.requestDelegations.mockResolvedValue([])
})

describe('createGrantsForAgent — value-based reuse', () => {
  test('stores and delegates everything when nothing is reused', async () => {
    const parent = sourceGrant('s-parent', { hasInheritingGrant: [grantIri('s-child')] })
    const child = sourceGrant('s-child', {
      inheritsFromGrant: grantIri('s-parent'),
      registeredShapeTree: TASK_TREE,
      scopeOfGrant: INTEROP.Inherited,
    })
    const delegated = delegatedGrant()
    const existing = [grantId('e-parent'), grantId('e-child')]
    h.activities.getExistingGrants.mockResolvedValue(existing)
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

  test('deny case clears the registration without generating or comparing', async () => {
    h.activities.getAuthorizations.mockResolvedValue([])
    h.activities.getExistingGrants.mockResolvedValue([grantId('e-parent')])

    await createGrantsForAgent({ webId, grantee })

    expect(h.activities.generateGrants).not.toHaveBeenCalled()
    expect(h.activities.checkEquivalence).not.toHaveBeenCalled()
    expect(h.activities.replaceDataGrantsOnRegistration).toHaveBeenCalledWith({
      webId,
      grantee,
      grants: [],
    })
  })
})
