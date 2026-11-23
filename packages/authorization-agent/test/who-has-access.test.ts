import type {
  DataAuthorizationData,
  DataInstanceData,
  RoleData,
} from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { accessForResource, matchesScope, scopeFacts } from '../src/authorization.js'

// ──────────────────────────
// Fixtures: bob owns the data (the context owner); the "project" shape tree is
// registered under `data/bob/avn9hv`. Kim is a directly granted peer; the
// Whiz role (dan) is granted the same shape tree; the Biz role (yoyo) is the
// data owner of the role-scoped authorization.
// ──────────────────────────

const BOB = 'https://id/bob'
const KIM = 'https://id/kim'
const DAN = 'https://id/dan'
const YOYO = 'https://id/yoyo'

const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'

const WHIZ = 'https://registry/bob/whiz'
const BIZ = 'https://registry/bob/biz'

const REGISTRATION = 'https://data/bob/avn9hv'
const RESOURCE = 'https://data/bob/n3onkx'

const ROLE_DATA: Array<RoleData> = [
  { id: WHIZ, type: [INTEROP.Role], label: { '@none': 'Whiz' }, members: [DAN] },
  { id: BIZ, type: [INTEROP.Role], label: { '@none': 'Biz' }, members: [YOYO] },
]

const resource: DataInstanceData = {
  id: RESOURCE,
  shapeTreeIri: PROJECT_TREE,
  dataRegistration: { id: REGISTRATION, registeredShapeTree: PROJECT_TREE },
} as unknown as DataInstanceData

function authorization(
  overrides: Partial<DataAuthorizationData> & { id: string }
): DataAuthorizationData {
  return {
    type: [INTEROP.DataAuthorization],
    grantee: KIM,
    grantedBy: BOB,
    registeredShapeTree: PROJECT_TREE,
    scopeOfAuthorization: INTEROP.AllFromRegistry,
    dataOwner: BOB,
    hasDataRegistration: REGISTRATION,
    accessMode: [ACCESS_ACTIONS.read],
    ...overrides,
  } as DataAuthorizationData
}

function factsFor(authorizations: Array<DataAuthorizationData>) {
  return scopeFacts(ROLE_DATA, authorizations)
}

describe('matchesScope', () => {
  test('All covers any instance', () => {
    const all = authorization({ id: 'all', scopeOfAuthorization: INTEROP.All })
    expect(matchesScope(all, resource, BOB)).toBe(true)
  })

  test('AllFromAgent covers only the data owner itself', () => {
    const own = authorization({ id: 'own', scopeOfAuthorization: INTEROP.AllFromAgent })
    expect(matchesScope(own, resource, BOB)).toBe(true)
    expect(matchesScope(own, resource, KIM)).toBe(false)
  })

  test('AllFromRegistry / SelectedFromRegistry key on the registration (and instance)', () => {
    const registry = authorization({ id: 'registry' })
    expect(matchesScope(registry, resource, BOB)).toBe(true)
    const other = { ...resource, dataRegistration: { id: `${REGISTRATION}-other` } }
    expect(matchesScope(registry, other as unknown as DataInstanceData, BOB)).toBe(false)

    const selected = authorization({
      id: 'selected',
      scopeOfAuthorization: INTEROP.SelectedFromRegistry,
      hasDataInstance: [RESOURCE],
    })
    expect(matchesScope(selected, resource, BOB)).toBe(true)
    const notSelected = authorization({
      id: 'not-selected',
      scopeOfAuthorization: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['https://data/bob/other'],
    })
    expect(matchesScope(notSelected, resource, BOB)).toBe(false)
  })

  describe('AllFromRole', () => {
    const allFromRole = authorization({
      id: 'role',
      scopeOfAuthorization: INTEROP.AllFromRole,
      grantee: WHIZ,
      dataOwner: BIZ,
    })

    test('covers the data of a member of the data-owner role', () => {
      expect(matchesScope(allFromRole, resource, YOYO, factsFor([allFromRole]))).toBe(true)
    })

    test('does not cover the data of a non-member', () => {
      // bob's own instance: bob is not a member of the Biz role
      expect(matchesScope(allFromRole, resource, BOB, factsFor([allFromRole]))).toBe(false)
    })

    test('an unresolved role can not be confirmed (no throw)', () => {
      expect(matchesScope(allFromRole, resource, YOYO)).toBe(false)
    })
  })

  describe('Inherited', () => {
    const parent = authorization({ id: 'parent' })
    const child = authorization({
      id: 'child',
      scopeOfAuthorization: INTEROP.Inherited,
      inheritsFromAuthorization: 'parent',
      grantee: DAN,
      accessMode: [ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify],
    })

    test('covers what its parent covers', () => {
      expect(matchesScope(child, resource, BOB, factsFor([parent, child]))).toBe(true)
    })

    test('covers nothing when the parent does not cover the resource', () => {
      const otherParent = authorization({ id: 'parent', hasDataRegistration: 'https://elsewhere' })
      expect(matchesScope(child, resource, BOB, factsFor([otherParent, child]))).toBe(false)
    })

    test('a missing parent is not access', () => {
      expect(matchesScope(child, resource, BOB, factsFor([child]))).toBe(false)
    })

    test('a parent cycle terminates', () => {
      const cyclic = [
        authorization({
          id: 'a',
          scopeOfAuthorization: INTEROP.Inherited,
          inheritsFromAuthorization: 'b',
        }),
        authorization({
          id: 'b',
          scopeOfAuthorization: INTEROP.Inherited,
          inheritsFromAuthorization: 'a',
        }),
      ]
      expect(matchesScope(cyclic[0], resource, BOB, factsFor(cyclic))).toBe(false)
    })
  })

  test('an unknown scope still throws', () => {
    const bogus = authorization({ id: 'bogus', scopeOfAuthorization: 'Bogus' })
    expect(() => matchesScope(bogus, resource, BOB)).toThrow(/incorrect Data Authorization/)
  })
})

describe('accessForResource', () => {
  test('reports direct agent grantees', () => {
    const direct = authorization({ id: 'direct' })
    const access = accessForResource([direct], resource, BOB, factsFor([direct]))
    expect(access.agents).toEqual([
      { agent: KIM, dataAuthorization: 'direct', accessMode: [ACCESS_ACTIONS.read] },
    ])
    expect(access.roles).toEqual([])
  })

  test('reports a granted role with its members expanded, not as an agent', () => {
    const roleScoped = authorization({
      id: 'role',
      scopeOfAuthorization: INTEROP.AllFromRole,
      grantee: WHIZ,
      dataOwner: BIZ,
    })
    const access = accessForResource([roleScoped], resource, YOYO, factsFor([roleScoped]))
    expect(access.agents).toEqual([])
    expect(access.roles).toEqual([
      {
        role: WHIZ,
        label: { '@none': 'Whiz' },
        members: [DAN],
        dataAuthorization: 'role',
        accessMode: [ACCESS_ACTIONS.read],
      },
    ])
  })

  test('a role grantee of a non-role scope is reported as a role too', () => {
    // SelectedFromRegistry granted to a role: coverage is registration-based,
    // the BEARER is still the role (its members)
    const selected = authorization({ id: 'selected', grantee: WHIZ })
    const access = accessForResource([selected], resource, BOB, factsFor([selected]))
    expect(access.agents).toEqual([])
    expect(access.roles.map(({ role }) => role)).toEqual([WHIZ])
    expect(access.roles[0].members).toEqual([DAN])
  })

  test('an agent granted directly AND through a role shows up in both (the Kim case)', () => {
    const direct = authorization({ id: 'direct', grantee: KIM })
    const throughRole = authorization({
      id: 'through-role',
      scopeOfAuthorization: INTEROP.AllFromRole,
      grantee: WHIZ,
      dataOwner: BIZ,
      registeredShapeTree: PROJECT_TREE,
    })
    const kimRole: RoleData = {
      id: WHIZ,
      type: [INTEROP.Role],
      label: { '@none': 'Whiz' },
      members: [KIM, DAN],
    }
    // bob's data is covered by the role-scoped authorization because the
    // data-owner role lists him
    const bizRole: RoleData = {
      id: BIZ,
      type: [INTEROP.Role],
      label: { '@none': 'Biz' },
      members: [BOB],
    }
    const facts = scopeFacts([kimRole, bizRole], [direct, throughRole])
    const access = accessForResource([direct, throughRole], resource, BOB, facts)
    expect(access.agents.map(({ agent }) => agent)).toEqual([KIM])
    expect(access.roles.map(({ role }) => role)).toEqual([WHIZ])
    expect(access.roles[0].members).toEqual([KIM, DAN])
    expect(access.agents[0].accessMode).toEqual([ACCESS_ACTIONS.read])
  })

  test('an Inherited child reports its own grantee once the parent covers', () => {
    const parent = authorization({ id: 'parent' })
    const child = authorization({
      id: 'child',
      scopeOfAuthorization: INTEROP.Inherited,
      inheritsFromAuthorization: 'parent',
      grantee: DAN,
      accessMode: [ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify],
    })
    const access = accessForResource([parent, child], resource, BOB, factsFor([parent, child]))
    expect(access.agents.map(({ agent }) => agent).toSorted()).toEqual([DAN, KIM].toSorted())
  })

  test('ignores authorizations for another shape tree', () => {
    const task = authorization({ id: 'task', registeredShapeTree: TASK_TREE })
    expect(accessForResource([task], resource, BOB, factsFor([task]))).toEqual({
      agents: [],
      roles: [],
    })
  })

  test('dedupes per grantee and unions the access modes', () => {
    const read = authorization({ id: 'read', accessMode: [ACCESS_ACTIONS.read] })
    const write = authorization({
      id: 'write',
      accessMode: [ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify],
    })
    const access = accessForResource([read, write], resource, BOB, factsFor([read, write]))
    expect(access.agents).toHaveLength(1)
    expect(access.agents[0].accessMode.toSorted()).toEqual(
      [ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify].toSorted()
    )
  })
})
