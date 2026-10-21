import type { GrantData } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  accessModesCover,
  grantChainValidity,
  grantCovers,
  instancesCover,
  invalidGrantsAfterRemoval,
  isGrantValid,
  scopeCovers,
} from '../src/grant-chain.js'

// ──────────────────────────
// Fixtures: acme owns the data; alice (A) is the grantor; bob (B) and kim (C)
// are downstream grantees. The grant registry contains source grants (D→A) and
// delegated grants (A→B, B→C, …).
// ──────────────────────────

const OWNER = 'https://id/acme'
const A = 'https://id/alice'
const B = 'https://id/bob'
const C = 'https://id/kim'
const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'
const PROJECT_REG = 'https://data/acme/registrations/projects'
const TASK_REG = 'https://data/acme/registrations/tasks'
const STORAGE = 'https://data/acme/'
const READ = 'http://www.w3.org/ns/auth/acl#Read'
const UPDATE = 'http://www.w3.org/ns/auth/acl#Update'
const CREATE = 'http://www.w3.org/ns/auth/acl#Create'

function grant(id: string, overrides: Partial<GrantData> = {}): GrantData {
  return {
    id,
    type: [INTEROP.DataGrant],
    grantee: B,
    grantedBy: A,
    dataOwner: OWNER,
    registeredShapeTree: PROJECT_TREE,
    hasDataRegistration: PROJECT_REG,
    hasStorage: STORAGE,
    scopeOfGrant: INTEROP.AllFromRegistry,
    accessMode: [READ, UPDATE],
    ...overrides,
  }
}

/** A source grant D→A (the root of a delegated chain). */
function source(id: string, overrides: Partial<GrantData> = {}): GrantData {
  return grant(id, { grantedBy: OWNER, grantee: A, ...overrides })
}

/** A→B delegated grant. */
function aliceToBob(id: string, overrides: Partial<GrantData> = {}): GrantData {
  return grant(id, { grantedBy: A, grantee: B, ...overrides })
}

/** B→C delegated grant. */
function bobToKim(id: string, overrides: Partial<GrantData> = {}): GrantData {
  return grant(id, { grantedBy: B, grantee: C, accessMode: [READ], ...overrides })
}

describe('scope coverage lattice', () => {
  test('All ⊃ agent/role ⊃ registry ⊃ selected; Inherited is a same-registration child', () => {
    expect(scopeCovers(INTEROP.All, INTEROP.SelectedFromRegistry)).toBe(true)
    expect(scopeCovers(INTEROP.AllFromAgent, INTEROP.AllFromRegistry)).toBe(true)
    expect(scopeCovers(INTEROP.AllFromRole, INTEROP.SelectedFromRegistry)).toBe(true)
    expect(scopeCovers(INTEROP.AllFromRegistry, INTEROP.SelectedFromRegistry)).toBe(true)
    expect(scopeCovers(INTEROP.AllFromRegistry, INTEROP.Inherited)).toBe(true)
    expect(scopeCovers(INTEROP.Inherited, INTEROP.Inherited)).toBe(true)

    expect(scopeCovers(INTEROP.SelectedFromRegistry, INTEROP.AllFromRegistry)).toBe(false)
    expect(scopeCovers(INTEROP.SelectedFromRegistry, INTEROP.Inherited)).toBe(false)
    expect(scopeCovers(INTEROP.Inherited, INTEROP.AllFromRegistry)).toBe(false)
    expect(scopeCovers(INTEROP.AllFromRegistry, INTEROP.AllFromAgent)).toBe(false)
  })
})

describe('access-mode and instance coverage', () => {
  test('access modes are a subset, never a single overlapping mode', () => {
    expect(accessModesCover([READ, UPDATE], [READ])).toBe(true)
    expect(accessModesCover([READ, UPDATE], [READ, UPDATE])).toBe(true)
    expect(accessModesCover([READ], [READ, UPDATE])).toBe(false)
    expect(accessModesCover([READ, UPDATE], [READ, CREATE])).toBe(false)
    expect(accessModesCover([READ], [])).toBe(false)
    expect(accessModesCover(undefined, [])).toBe(false)
  })

  test('selected instances must be a subset; broader scopes cover them', () => {
    const all = aliceToBob('all', { scopeOfGrant: INTEROP.AllFromRegistry })
    const selected12 = aliceToBob('sel-12', {
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['i1', 'i2'],
    })
    const selected1 = aliceToBob('sel-1', {
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['i1'],
    })
    const selected3 = aliceToBob('sel-3', {
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['i3'],
    })

    expect(instancesCover(all, selected1)).toBe(true)
    expect(instancesCover(selected12, selected1)).toBe(true)
    expect(instancesCover(selected1, selected12)).toBe(false)
    expect(instancesCover(selected12, selected3)).toBe(false)
  })
})

describe('grantCovers — match-based upstream', () => {
  test('requires the same owner, grantee/grantedBy orientation, shape, registration and storage', () => {
    const upstream = source('root', { grantee: A })
    const downstream = aliceToBob('ab')
    expect(grantCovers(upstream, downstream)).toBe(true)
    expect(grantCovers({ ...upstream, dataOwner: 'https://id/other' }, downstream)).toBe(false)
    expect(grantCovers({ ...upstream, grantee: C }, downstream)).toBe(false)
    expect(grantCovers({ ...upstream, registeredShapeTree: TASK_TREE }, downstream)).toBe(false)
    expect(grantCovers({ ...upstream, hasDataRegistration: TASK_REG }, downstream)).toBe(false)
    expect(grantCovers({ ...upstream, hasStorage: 'https://data/other/' }, downstream)).toBe(false)
  })

  test('requires scope, mode and instance coverage', () => {
    const downstream = aliceToBob('ab', { accessMode: [READ] })
    expect(grantCovers(source('root', { accessMode: [READ, UPDATE] }), downstream)).toBe(true)
    expect(grantCovers(source('root', { accessMode: [READ] }), downstream)).toBe(true)
    expect(grantCovers(source('root', { accessMode: [UPDATE] }), downstream)).toBe(false)
    expect(
      grantCovers(
        source('root', { scopeOfGrant: INTEROP.SelectedFromRegistry, hasDataInstance: ['i1'] }),
        aliceToBob('ab', { scopeOfGrant: INTEROP.AllFromRegistry })
      )
    ).toBe(false)
  })
})

describe('grantChainValidity — rooted reachability', () => {
  test('validates a multi-hop chain from a source grant', () => {
    const grants = [source('root'), aliceToBob('ab'), bobToKim('bc')]

    const validity = grantChainValidity(grants)

    expect(validity.get('root')).toBe(true)
    expect(validity.get('ab')).toBe(true)
    expect(validity.get('bc')).toBe(true)
  })

  test('a chain without a source grant never becomes valid (mutual delegation)', () => {
    const ab = aliceToBob('ab', { grantee: B })
    const ba = aliceToBob('ba', { grantedBy: B, grantee: A })
    const grants = [ab, ba]

    const validity = grantChainValidity(grants)

    expect(validity.get('ab')).toBe(false)
    expect(validity.get('ba')).toBe(false)
  })

  test('a cycle with a source-rooted path is valid', () => {
    const grants = [
      source('root'),
      aliceToBob('ab'),
      aliceToBob('ba', { grantedBy: B, grantee: A, accessMode: [READ] }),
    ]

    const validity = grantChainValidity(grants)

    expect(validity.get('ab')).toBe(true)
    expect(validity.get('ba')).toBe(true)
  })

  test('mode expansion invalidates the downstream grant', () => {
    const grants = [
      source('root', { accessMode: [READ] }),
      aliceToBob('ab', { accessMode: [READ, UPDATE] }),
      bobToKim('bc', { accessMode: [READ] }),
    ]

    expect(isGrantValid(grants[1], grants)).toBe(false)
    expect(isGrantValid(grants[2], grants)).toBe(false)
  })

  test('a selected downstream grant needs its instances in the upstream', () => {
    const upstream = aliceToBob('ab', {
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['i1'],
    })
    const grants = [
      source('root'),
      upstream,
      bobToKim('bc', {
        scopeOfGrant: INTEROP.SelectedFromRegistry,
        hasDataInstance: ['i1'],
      }),
      bobToKim('bd', {
        scopeOfGrant: INTEROP.SelectedFromRegistry,
        hasDataInstance: ['i2'],
      }),
    ]

    const validity = grantChainValidity(grants)

    expect(validity.get('bc')).toBe(true)
    expect(validity.get('bd')).toBe(false)
  })

  test('a replacement source grant re-anchors the unchanged downstream grant', () => {
    const oldRoot = source('old-root')
    const newRoot = source('new-root')
    const ab = aliceToBob('ab')
    const grants = [oldRoot, newRoot, ab]

    // the old root is replaced by a new IRI with the same semantics: the
    // downstream grant re-anchors via the match predicate
    const invalid = invalidGrantsAfterRemoval(grants, ['old-root'])

    expect(invalid.map((g) => g.id)).toEqual(['old-root'])
    expect(isGrantValid(ab, grants, ['old-root'])).toBe(true)
  })
})

describe('inheriting children', () => {
  test('a source child is structurally tied to its parent; its modes are its own', () => {
    const root = source('root', { accessMode: [READ] })
    const child = source('child', {
      registeredShapeTree: TASK_TREE,
      hasDataRegistration: TASK_REG,
      scopeOfGrant: INTEROP.Inherited,
      inheritsFromGrant: 'root',
      // the child shape tree may have a different mode set than the parent
      accessMode: [READ, CREATE],
    })
    const orphan = { ...child, id: 'child-orphan', inheritsFromGrant: 'missing' }

    const validity = grantChainValidity([root, child, orphan])

    expect(validity.get('child')).toBe(true)
    expect(validity.get('child-orphan')).toBe(false)
  })

  test('a delegated child needs its parent and its own valid upstream', () => {
    const grants = [
      source('root'),
      aliceToBob('ab'),
      source('child-source', {
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REG,
        scopeOfGrant: INTEROP.Inherited,
        inheritsFromGrant: 'root',
        accessMode: [READ],
      }),
      aliceToBob('delegated-child', {
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REG,
        scopeOfGrant: INTEROP.Inherited,
        inheritsFromGrant: 'ab',
        accessMode: [READ],
      }),
      aliceToBob('delegated-child-over', {
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REG,
        scopeOfGrant: INTEROP.Inherited,
        inheritsFromGrant: 'ab',
        accessMode: [READ, CREATE],
      }),
    ]

    expect(isGrantValid(grants[3], grants)).toBe(true)
    expect(isGrantValid(grants[4], grants)).toBe(false)
    expect(invalidGrantsAfterRemoval(grants, ['ab']).map((g) => g.id)).toEqual([
      'ab',
      'delegated-child',
      'delegated-child-over',
    ])
    expect(invalidGrantsAfterRemoval(grants, ['child-source']).map((g) => g.id)).toEqual([
      'child-source',
      'delegated-child',
    ])
    expect(invalidGrantsAfterRemoval(grants, ['root']).map((g) => g.id)).toEqual([
      'root',
      'ab',
      'child-source',
      'delegated-child',
      'delegated-child-over',
    ])
  })
})

describe('invalidGrantsAfterRemoval — dependent closure', () => {
  test('removes the entry point and its downstream chain, leaving unrelated chains intact', () => {
    const grants = [
      source('root'),
      aliceToBob('ab'),
      bobToKim('bc'),
      // an independent source-rooted chain (same shape tree/registration)
      source('other-root', {
        grantee: C,
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REG,
        accessMode: [READ],
      }),
      grant('cd', {
        grantedBy: C,
        grantee: 'https://id/dan',
        registeredShapeTree: TASK_TREE,
        hasDataRegistration: TASK_REG,
        accessMode: [READ],
      }),
    ]

    const invalid = invalidGrantsAfterRemoval(grants, ['ab'])

    expect(invalid.map((g) => g.id).toSorted()).toEqual(['ab', 'bc'])
    expect(invalid.some((g) => g.id === 'cd')).toBe(false)
  })

  test('removing the source root invalidates every dependent delegated grant', () => {
    const grants = [source('root'), aliceToBob('ab'), bobToKim('bc')]

    expect(
      invalidGrantsAfterRemoval(grants, ['root'])
        .map((g) => g.id)
        .toSorted()
    ).toEqual(['ab', 'bc', 'root'])
  })

  test('does not sweep pre-existing invalid grants unrelated to the removal', () => {
    // a public-client style grant with no chain upstream is already invalid
    const publicGrant = grant('public', {
      grantedBy: 'https://id/public',
      grantee: 'https://id/everyone',
    })
    const grants = [source('root'), aliceToBob('ab'), publicGrant]

    expect(grantChainValidity(grants).get('public')).toBe(false)
    expect(invalidGrantsAfterRemoval(grants, ['ab']).map((g) => g.id)).toEqual(['ab'])
  })
})
