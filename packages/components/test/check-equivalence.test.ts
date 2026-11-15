import {
  type GrantData,
  type GrantTargetInput,
  type OdrlPolicy,
  grantAccess,
} from '@janeirodigital/interop-data-model'
import { INTEROP, LWS } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  delegatedGrantTrees,
  grantFieldsEqual,
  grantTrees,
  pairTrees,
  treesEqual,
} from '../src/temporal/activities/check-equivalence.js'

// ──────────────────────────
// Pure helpers only — no session, no I/O. Callers (step 3) load the bodies.
// ──────────────────────────

const READ = 'http://www.w3.org/ns/odrl/2/read'
const MODIFY = 'http://www.w3.org/ns/odrl/2/modify'
const CREATE = 'https://www.w3.org/ns/lws#create'

const PARENT = 'https://registry/acme/parent'
const CHILD = 'https://registry/acme/child'
const GRANDCHILD = 'https://registry/acme/grandchild'

const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'
const PROJECT_REGISTRATION = 'https://data/acme/registrations/projects/'
const TASK_REGISTRATION = 'https://data/acme/registrations/tasks/'
const STORAGE = 'https://data/acme/'

const ALICE = 'https://id/alice'
const ACME = 'https://id/acme'
const KIM = 'https://id/kim'

interface GrantOverrides extends Partial<GrantData> {
  /** legacy-named fixture fields — derived into the canonical access policy */
  grantee?: string
  accessMode?: string[]
  hasStorage?: string
}

function target(
  scopeOfGrant: string,
  hasDataRegistration: string,
  hasDataInstance: string[] | undefined,
  storage: string
): GrantTargetInput {
  return { scopeOfGrant, owner: ALICE, hasDataRegistration, hasDataInstance, storage }
}

function withAssignee(grant: GrantData, assignee: string): GrantData {
  return {
    ...grant,
    access: grant.access.map((policy) => ({
      ...policy,
      assignee,
      permission: policy.permission.map((permission) => ({ ...permission, assignee })),
    })),
  }
}

function grant(overrides: GrantOverrides = {}): GrantData {
  const { grantee = KIM, accessMode = [READ], hasStorage = STORAGE, ...rest } = overrides
  const storage = rest.storage ?? hasStorage
  const hasDataRegistration = rest.hasDataRegistration ?? PROJECT_REGISTRATION
  const scopeOfGrant = rest.scopeOfGrant ?? INTEROP.AllFromRegistry
  return {
    id: PARENT,
    type: [LWS.AccessGrant],
    storage,
    access:
      rest.access ??
      (grantAccess({
        ...target(scopeOfGrant, hasDataRegistration, rest.hasDataInstance, storage),
        registeredShapeTree: PROJECT_TREE,
        assigner: ACME,
        assignee: grantee,
        actions: accessMode,
      }) as OdrlPolicy[]),
    grantedBy: ACME,
    dataOwner: ALICE,
    registeredShapeTree: PROJECT_TREE,
    hasDataRegistration,
    scopeOfGrant,
    ...rest,
  }
}

/** An Inherited-scope Task child of PARENT. */
function child(overrides: GrantOverrides = {}): GrantData {
  return grant({
    id: CHILD,
    inheritsFromGrant: PARENT,
    registeredShapeTree: TASK_TREE,
    hasDataRegistration: TASK_REGISTRATION,
    scopeOfGrant: INTEROP.Inherited,
    accessMode: [READ, CREATE],
    ...overrides,
  })
}

/** A parent with the flat-shape child links (`hasInheritingGrant` = ids). */
function parentWith(...children: GrantData[]): GrantData {
  return grant({ hasInheritingGrant: children.map((node) => node.id!) })
}

describe('grantFieldsEqual', () => {
  test('matches the semantic fields', () => {
    expect(grantFieldsEqual(grant(), grant())).toBe(true)
  })

  test('compares set-valued fields as sets', () => {
    const a = grant({
      accessMode: [READ, MODIFY],
      hasDataInstance: ['i1', 'i2'],
    })
    const b = grant({
      accessMode: [MODIFY, READ],
      hasDataInstance: ['i2', 'i1'],
    })
    expect(grantFieldsEqual(a, b)).toBe(true)
  })

  test('treats an absent optional set as an empty one', () => {
    expect(grantFieldsEqual(grant({ hasDataInstance: [] }), grant())).toBe(true)
  })

  test('ignores ids, type and the derived tree links', () => {
    const a = grant()
    const b = grant({
      id: 'https://registry/acme/other',
      type: [LWS.AccessGrant],
      inheritsFromGrant: 'https://registry/acme/from',
      hasInheritingGrant: ['https://registry/acme/to'],
    })
    expect(grantFieldsEqual(a, b)).toBe(true)
  })

  const scalarChanges: [keyof GrantData, string][] = [
    ['grantedBy', 'https://id/bob'],
    ['dataOwner', 'https://id/bob'],
    ['registeredShapeTree', 'https://data/shapetrees/trees/Other'],
    ['hasDataRegistration', 'https://data/acme/registrations/other/'],
    ['storage', 'https://data/acme/hr/'],
    ['scopeOfGrant', INTEROP.SelectedFromRegistry],
  ]
  for (const [field, value] of scalarChanges) {
    test(`differs on ${field}`, () => {
      expect(grantFieldsEqual(grant(), grant({ [field]: value } as Partial<GrantData>))).toBe(false)
    })
  }

  test('differs on accessMode', () => {
    expect(grantFieldsEqual(grant(), grant({ accessMode: [READ, MODIFY] }))).toBe(false)
  })

  test('differs on assignee', () => {
    expect(grantFieldsEqual(grant(), withAssignee(grant(), 'https://id/bob'))).toBe(false)
  })

  test('differs on hasDataInstance', () => {
    expect(grantFieldsEqual(grant(), grant({ hasDataInstance: ['i1'] }))).toBe(false)
    expect(
      grantFieldsEqual(grant({ hasDataInstance: ['i1'] }), grant({ hasDataInstance: ['i2'] }))
    ).toBe(false)
  })
})

describe('grantTrees', () => {
  test('builds a parent/child tree from a flat list in any order', () => {
    const roots = grantTrees([child(), parentWith(child())])
    expect(roots).toHaveLength(1)
    expect(roots[0].grant.id).toBe(PARENT)
    expect(roots[0].children.map((node) => node.grant.id)).toEqual([CHILD])
  })

  test('nests deeper descendants (n-depth ready)', () => {
    const grandchild = child({
      id: GRANDCHILD,
      inheritsFromGrant: CHILD,
      registeredShapeTree: PROJECT_TREE,
      hasDataRegistration: PROJECT_REGISTRATION,
    })
    const middle = child({ hasInheritingGrant: [GRANDCHILD] })
    const [root] = grantTrees([grandchild, middle, parentWith(middle)])
    expect(root.grant.id).toBe(PARENT)
    expect(root.children[0].grant.id).toBe(CHILD)
    expect(root.children[0].children[0].grant.id).toBe(GRANDCHILD)
  })

  test('keeps a childless parent', () => {
    const roots = grantTrees([grant()])
    expect(roots).toHaveLength(1)
    expect(roots[0].children).toEqual([])
  })

  test('drops a parent whose declared child body is missing (fail closed)', () => {
    expect(grantTrees([grant({ hasInheritingGrant: [CHILD] })])).toEqual([])
  })

  test('drops an orphaned child instead of promoting it to a root', () => {
    expect(grantTrees([child()])).toEqual([])
  })

  test('drops a parent when a declared child points at another parent', () => {
    const declared = grant({ hasInheritingGrant: [CHILD] })
    const repointed = child({ inheritsFromGrant: 'https://registry/acme/elsewhere' })
    expect(grantTrees([declared, repointed])).toEqual([])
  })
})

describe('delegatedGrantTrees', () => {
  test('builds a tree from embedded child objects', () => {
    const embeddedParent = grant({
      hasInheritingGrant: [child({ id: undefined })] as unknown as string[],
    })
    const [root] = delegatedGrantTrees([embeddedParent])
    expect(root.children).toHaveLength(1)
    expect(root.children[0].grant.registeredShapeTree).toBe(TASK_TREE)
  })

  test('nests embedded descendants (n-depth ready)', () => {
    const grandchild = child({
      id: undefined,
      inheritsFromGrant: undefined,
      registeredShapeTree: PROJECT_TREE,
      hasDataRegistration: PROJECT_REGISTRATION,
    })
    const middle = child({
      id: undefined,
      inheritsFromGrant: undefined,
      hasInheritingGrant: [grandchild] as unknown as string[],
    })
    const [root] = delegatedGrantTrees([
      grant({ hasInheritingGrant: [middle] as unknown as string[] }),
    ])
    expect(root.children[0].children[0].grant.registeredShapeTree).toBe(PROJECT_TREE)
  })

  test('ignores non-object children (the flat/id shape)', () => {
    const [root] = delegatedGrantTrees([grant({ hasInheritingGrant: [CHILD] })])
    expect(root.children).toEqual([])
  })
})

describe('treesEqual', () => {
  const generated = grantTrees([
    grant({ id: 'g-parent', hasInheritingGrant: ['g-project', 'g-task'] }),
    child({ id: 'g-project', inheritsFromGrant: 'g-parent' }),
    child({
      id: 'g-task',
      inheritsFromGrant: 'g-parent',
      registeredShapeTree: TASK_TREE,
      hasDataRegistration: TASK_REGISTRATION,
      accessMode: [READ],
    }),
  ])[0]

  test('matches a whole subtree', () => {
    const existing = grantTrees([
      grant({ id: 'e-parent', hasInheritingGrant: ['e-project', 'e-task'] }),
      child({ id: 'e-project', inheritsFromGrant: 'e-parent' }),
      child({
        id: 'e-task',
        inheritsFromGrant: 'e-parent',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REGISTRATION,
        accessMode: [READ],
      }),
    ])[0]
    expect(generated).toBeDefined()
    expect(treesEqual(generated, existing)).toBe(true)
  })

  test('ignores child order', () => {
    const existing = grantTrees([
      grant({ id: 'e-parent', hasInheritingGrant: ['e-task', 'e-project'] }),
      child({ id: 'e-project', inheritsFromGrant: 'e-parent' }),
      child({
        id: 'e-task',
        inheritsFromGrant: 'e-parent',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REGISTRATION,
        accessMode: [READ],
      }),
    ])[0]
    expect(treesEqual(generated, existing)).toBe(true)
  })

  test('differs when a child field changes', () => {
    const existing = grantTrees([
      grant({ id: 'e-parent', hasInheritingGrant: ['e-project', 'e-task'] }),
      child({ id: 'e-project', inheritsFromGrant: 'e-parent', accessMode: [READ, MODIFY] }),
      child({
        id: 'e-task',
        inheritsFromGrant: 'e-parent',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REGISTRATION,
        accessMode: [READ],
      }),
    ])[0]
    expect(treesEqual(generated, existing)).toBe(false)
  })

  test('differs when a child is missing', () => {
    const existing = grantTrees([
      grant({ id: 'e-parent', hasInheritingGrant: ['e-project'] }),
      child({ id: 'e-project', inheritsFromGrant: 'e-parent' }),
    ])[0]
    expect(treesEqual(generated, existing)).toBe(false)
  })

  test('differs when the parent changes', () => {
    const existing = grantTrees([
      grant({
        id: 'e-parent',
        accessMode: [READ, MODIFY],
        hasInheritingGrant: ['e-project', 'e-task'],
      }),
      child({ id: 'e-project', inheritsFromGrant: 'e-parent' }),
      child({
        id: 'e-task',
        inheritsFromGrant: 'e-parent',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REGISTRATION,
        accessMode: [READ],
      }),
    ])[0]
    expect(treesEqual(generated, existing)).toBe(false)
  })
})

describe('pairTrees', () => {
  test('pairs every generated tree with a distinct equivalent existing tree', () => {
    const generated = grantTrees([grant({ id: 'g1' }), grant({ id: 'g2' })])
    const existing = grantTrees([grant({ id: 'e1' }), grant({ id: 'e2' })])
    const pairs = pairTrees(generated, existing)
    expect(pairs).toHaveLength(2)
    expect(new Set(pairs.map((pair) => pair.existing.grant.id)).size).toBe(2)
    expect(pairs.map((pair) => pair.nodes.map((node) => node.existing.id))).toEqual([
      ['e1'],
      ['e2'],
    ])
  })

  test('skips non-equivalent existing trees', () => {
    const generated = grantTrees([grant({ id: 'g1' })])
    const existing = grantTrees([grant({ id: 'e1', accessMode: [MODIFY] }), grant({ id: 'e2' })])
    const [pair] = pairTrees(generated, existing)
    expect(pair.existing.grant.id).toBe('e2')
  })

  test('never reuses an existing tree twice', () => {
    const generated = grantTrees([grant({ id: 'g1' }), grant({ id: 'g2' })])
    const existing = grantTrees([grant({ id: 'e1' })])
    const pairs = pairTrees(generated, existing)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].generated.grant.id).toBe('g1')
  })

  test('returns the child correspondence, not just the parent', () => {
    const generated = grantTrees([
      grant({ id: 'g-parent', hasInheritingGrant: ['g-project', 'g-task'] }),
      child({ id: 'g-project', inheritsFromGrant: 'g-parent' }),
      child({
        id: 'g-task',
        inheritsFromGrant: 'g-parent',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REGISTRATION,
        accessMode: [READ],
      }),
    ])
    // the existing children are in the opposite order
    const existing = grantTrees([
      grant({ id: 'e-parent', hasInheritingGrant: ['e-task', 'e-project'] }),
      child({ id: 'e-project', inheritsFromGrant: 'e-parent' }),
      child({
        id: 'e-task',
        inheritsFromGrant: 'e-parent',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REGISTRATION,
        accessMode: [READ],
      }),
    ])
    const [pair] = pairTrees(generated, existing)
    expect(pair.nodes).toHaveLength(3)
    expect(pair.nodes.map((node) => node.existing.id)).toContain('e-parent')
    const project = pair.nodes.find((node) => node.generated.id === 'g-project')
    expect(project?.existing.id).toBe('e-project')
    const task = pair.nodes.find((node) => node.generated.id === 'g-task')
    expect(task?.existing.id).toBe('e-task')
  })

  test('pairs an embedded delegated tree against a flat existing tree', () => {
    const embedded = grant({
      id: undefined,
      hasInheritingGrant: [child({ id: undefined })] as unknown as string[],
    })
    const existing = grantTrees([parentWith(child()), child()])
    const pairs = pairTrees(delegatedGrantTrees([embedded]), existing)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].nodes).toHaveLength(2)
  })
})
