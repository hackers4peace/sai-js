import {
  type GrantData,
  type GrantTargetInput,
  grantAccess,
} from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP, LWS } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ──────────────────────────
// The real comparison: existing bodies are read through the session's OWN
// SPARQL endpoint (`localSparqlTransport(session.sparqlEndpoint)`) — no peer
// dereference. Children are followed via `hasInheritingGrant`; a missing body
// fails closed (the whole tree never matches). Source trees pair with existing
// trees we own; delegated trees pair with local registry grants, scoped by ownGrantIds.
//
// `getAccessGrant` is mocked at the package boundary so these cases stay about
// the tree loader and pairing, not SPARQL framing (covered in the AA package).
// ──────────────────────────

const h = vi.hoisted(() => {
  const bodies = new Map<string, unknown>()
  const transport = { kind: 'local' }
  const fetch = vi.fn(() => {
    throw new Error('peer dereference attempted')
  })
  let session: { sparqlEndpoint: string; fetch: typeof fetch } | undefined
  return {
    bodies,
    transport,
    fetch,
    localSparqlTransport: vi.fn(() => transport),
    getAccessGrant: vi.fn(async (_transport: unknown, iri: string) => {
      const grant = bodies.get(iri)
      if (!grant) throw new Error(`no local graph for ${iri}`)
      return grant
    }),
    setSession: (sparqlEndpoint: string) => {
      session = { sparqlEndpoint, fetch }
    },
    getSession: () => session,
  }
})

vi.mock('../src/builders/sessionManager.js', () => ({
  buildSessionManager: () => ({ getSession: async () => h.getSession() }),
}))

vi.mock('@janeirodigital/interop-authorization-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janeirodigital/interop-authorization-agent')>()),
  localSparqlTransport: h.localSparqlTransport,
  getAccessGrant: h.getAccessGrant,
}))

import { checkEquivalence } from '../src/temporal/activities/grants.js'

const ENDPOINT = 'https://registry/acme/sparql'
const webId = { id: 'https://id/acme', type: [INTEROP.SocialAgent] } as never
const grantee = { id: 'https://id/alice', type: [INTEROP.SocialAgent] } as never

const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'
const PROJECT_REGISTRATION = 'https://data/acme/registrations/projects/'
const TASK_REGISTRATION = 'https://data/acme/registrations/tasks/'
const STORAGE = 'https://data/acme/'

interface GrantOverrides extends Partial<GrantData> {
  /** legacy-named fixture fields — derived into the canonical access policy */
  grantee?: string
  accessMode?: string[]
  hasStorage?: string
}

const DEFAULT_ACTIONS = [ACCESS_ACTIONS.read]

function makeGrant(overrides: GrantOverrides = {}): GrantData {
  const {
    grantee = 'https://id/alice',
    accessMode = DEFAULT_ACTIONS,
    hasStorage = STORAGE,
    ...rest
  } = overrides
  const storage = rest.storage ?? hasStorage
  const hasDataRegistration = rest.hasDataRegistration ?? PROJECT_REGISTRATION
  const scopeOfGrant = rest.scopeOfGrant ?? INTEROP.AllFromRegistry
  const target: GrantTargetInput = {
    scopeOfGrant,
    owner: rest.dataOwner ?? 'https://id/acme',
    storage,
    hasDataRegistration,
    hasDataInstance: rest.hasDataInstance,
  }
  return {
    type: [LWS.AccessGrant],
    storage,
    access:
      rest.access ??
      grantAccess({
        ...target,
        assigner: rest.grantedBy ?? 'https://id/acme',
        assignee: grantee,
        actions: accessMode,
      }),
    grantedBy: 'https://id/acme',
    dataOwner: 'https://id/acme',
    registeredShapeTree: PROJECT_TREE,
    hasDataRegistration,
    scopeOfGrant,
    ...rest,
  } as GrantData
}

const parent = (id: string, children: string[] = [], overrides: GrantOverrides = {}): GrantData =>
  makeGrant({
    ...overrides,
    id,
    ...(children.length ? { hasInheritingGrant: children } : {}),
  })

const child = (id: string, parentId: string, overrides: GrantOverrides = {}): GrantData =>
  makeGrant({
    id,
    inheritsFromGrant: parentId,
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REGISTRATION,
    scopeOfGrant: INTEROP.Inherited,
    accessMode: [ACCESS_ACTIONS.create, ACCESS_ACTIONS.read],
    ...overrides,
  })

/** An existing delegated grant body (the peer is the dataOwner). */
const delegatedParent = (
  id: string,
  children: string[] = [],
  overrides: GrantOverrides = {}
): GrantData =>
  makeGrant({
    dataOwner: 'https://id/alice',
    ...overrides,
    id,
    ...(children.length ? { hasInheritingGrant: children } : {}),
  })

/** An existing delegated child body (Inherited scope). */
const delegatedChild = (id: string, parentId: string, overrides: GrantOverrides = {}): GrantData =>
  makeGrant({
    dataOwner: 'https://id/alice',
    id,
    inheritsFromGrant: parentId,
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REGISTRATION,
    scopeOfGrant: INTEROP.Inherited,
    accessMode: [ACCESS_ACTIONS.create, ACCESS_ACTIONS.read],
    ...overrides,
  })

/** A generated delegated grant: children ride as embedded objects. */
const generatedDelegated = (overrides: GrantOverrides = {}, withChild = true): GrantData =>
  makeGrant({
    dataOwner: 'https://id/alice',
    ...overrides,
    ...(withChild
      ? {
          hasInheritingGrant: [
            makeGrant({
              dataOwner: 'https://id/alice',
              registeredShapeTree: TASK_TREE,
              hasDataRegistration: TASK_REGISTRATION,
              scopeOfGrant: INTEROP.Inherited,
              accessMode: [ACCESS_ACTIONS.read, ACCESS_ACTIONS.create],
            }),
          ] as unknown as string[],
        }
      : {}),
  })

const ref = (grant: GrantData) => ({ id: grant.id!, type: grant.type })

beforeEach(() => {
  vi.clearAllMocks()
  h.bodies.clear()
  h.setSession(ENDPOINT)
})

describe('checkEquivalence — source-grant reuse', () => {
  test('reuses an equivalent source subtree and re-links parents and children', async () => {
    const eParent = parent('https://registry/acme/e-parent', ['https://registry/acme/e-child'])
    const eChild = child('https://registry/acme/e-child', eParent.id!)
    const gParent = parent('https://registry/acme/g-parent', ['https://registry/acme/g-child'])
    const gChild = child('https://registry/acme/g-child', gParent.id!)
    h.bodies.set(eParent.id!, eParent)
    h.bodies.set(eChild.id!, eChild)

    // the registration projection only links the parent — the body's
    // `hasInheritingGrant` must pull the child in
    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [gParent, gChild], delegatedGrants: [] },
      existing: [ref(eParent)],
    })

    expect(result.reusedSourceIds).toEqual([gParent.id, gChild.id])
    expect(result.reusedExisting).toEqual([ref(eParent), ref(eChild)])
    expect(result.reusedDelegatedIndexes).toEqual([])
    // local plane only: the session's own endpoint, never `session.fetch`
    expect(h.localSparqlTransport).toHaveBeenCalledWith(ENDPOINT)
    expect(h.getAccessGrant).toHaveBeenCalledWith(h.transport, eParent.id)
    expect(h.getAccessGrant).toHaveBeenCalledWith(h.transport, eChild.id)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  test('fails closed when a declared child body is missing', async () => {
    const eParent = parent('https://registry/acme/e-parent', ['https://registry/acme/e-child'])
    const gParent = parent('https://registry/acme/g-parent', ['https://registry/acme/g-child'])
    h.bodies.set(eParent.id!, eParent) // child body absent

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: {
        sourceGrants: [gParent, child('https://registry/acme/g-child', gParent.id!)],
        delegatedGrants: [],
      },
      existing: [ref(eParent)],
    })

    expect(result).toEqual({
      reusedSourceIds: [],
      reusedDelegatedIndexes: [],
      reusedExisting: [],
    })
  })

  test('replaces the whole subtree when a child field differs', async () => {
    const eParent = parent('https://registry/acme/e-parent', ['https://registry/acme/e-child'])
    const eChild = child('https://registry/acme/e-child', eParent.id!, {
      accessMode: [ACCESS_ACTIONS.read], // generated child additionally has Create
    })
    const gParent = parent('https://registry/acme/g-parent', ['https://registry/acme/g-child'])
    const gChild = child('https://registry/acme/g-child', gParent.id!)
    h.bodies.set(eParent.id!, eParent)
    h.bodies.set(eChild.id!, eChild)

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [gParent, gChild], delegatedGrants: [] },
      existing: [ref(eParent)],
    })

    expect(result.reusedSourceIds).toEqual([])
    expect(result.reusedExisting).toEqual([])
  })

  test('partially reuses: only the equivalent tree, stale IRIs are skipped', async () => {
    const e1 = parent('https://registry/acme/e1')
    const g1 = parent('https://registry/acme/g1')
    const g2 = parent('https://registry/acme/g2')
    h.bodies.set(e1.id!, e1)

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [g1, g2], delegatedGrants: [] },
      existing: [ref(e1), { id: 'https://registry/acme/stale', type: [LWS.AccessGrant] }],
    })

    expect(result.reusedSourceIds).toEqual([g1.id])
    expect(result.reusedExisting).toEqual([ref(e1)])
  })

  test('reuses an equivalent delegated subtree from the local registry', async () => {
    const eParent = delegatedParent('https://registry/acme/e-dparent', [
      'https://registry/acme/e-dchild',
    ])
    const eChild = delegatedChild('https://registry/acme/e-dchild', eParent.id!)
    h.bodies.set(eParent.id!, eParent)
    h.bodies.set(eChild.id!, eChild)

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [], delegatedGrants: [generatedDelegated()] },
      existing: [ref(eParent)],
    })

    expect(result.reusedSourceIds).toEqual([])
    expect(result.reusedDelegatedIndexes).toEqual([0])
    expect(result.reusedExisting).toEqual([ref(eParent), ref(eChild)])
  })

  test('does not reuse a delegated copy outside the actor registry', async () => {
    const eParent = delegatedParent('https://registry/acme/e-dparent')
    h.bodies.set(eParent.id!, eParent)

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [], delegatedGrants: [generatedDelegated({}, false)] },
      existing: [ref(eParent)],
      // the body is visible locally but is not a grant in the actor's own
      // registry, so it cannot be reused
      ownGrantIds: [],
    })

    expect(result.reusedDelegatedIndexes).toEqual([])
    expect(result.reusedExisting).toEqual([])
  })

  test('fails closed when a delegated child body is missing from the local registry', async () => {
    const eParent = delegatedParent('https://registry/acme/e-dparent', [
      'https://registry/acme/e-dchild',
    ])
    h.bodies.set(eParent.id!, eParent) // child body absent

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [], delegatedGrants: [generatedDelegated()] },
      existing: [ref(eParent)],
    })

    expect(result).toEqual({
      reusedSourceIds: [],
      reusedDelegatedIndexes: [],
      reusedExisting: [],
    })
  })

  test('pairs source and delegated trees independently', async () => {
    const eSource = parent('https://registry/acme/e-src')
    const gSource = parent('https://registry/acme/g-src')
    const eParent = delegatedParent('https://registry/acme/e-dparent', [
      'https://registry/acme/e-dchild',
    ])
    const eChild = delegatedChild('https://registry/acme/e-dchild', eParent.id!)
    h.bodies.set(eSource.id!, eSource)
    h.bodies.set(eParent.id!, eParent)
    h.bodies.set(eChild.id!, eChild)

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: {
        sourceGrants: [gSource],
        delegatedGrants: [generatedDelegated()],
      },
      existing: [ref(eSource), ref(eParent), ref(eChild)],
    })

    expect(result.reusedSourceIds).toEqual([gSource.id])
    expect(result.reusedDelegatedIndexes).toEqual([0])
    expect(result.reusedExisting).toEqual([ref(eSource), ref(eParent), ref(eChild)])
  })

  test('addresses a reused delegated tree by its position in the array', async () => {
    const gProject = generatedDelegated({}, false)
    const gTask = generatedDelegated(
      { registeredShapeTree: TASK_TREE, hasDataRegistration: TASK_REGISTRATION },
      false
    )
    const eTask = delegatedParent('https://registry/acme/e-task', [], {
      registeredShapeTree: TASK_TREE,
      hasDataRegistration: TASK_REGISTRATION,
    })
    h.bodies.set(eTask.id!, eTask)

    const result = await checkEquivalence({
      webId,
      grantee,
      generated: { sourceGrants: [], delegatedGrants: [gProject, gTask] },
      existing: [ref(eTask)],
    })

    expect(result.reusedDelegatedIndexes).toEqual([1])
    expect(result.reusedExisting).toEqual([ref(eTask)])
  })
})
