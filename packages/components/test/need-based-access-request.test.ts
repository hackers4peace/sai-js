import { ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import { BadRequestHttpError } from '@solid/community-server'
import { describe, expect, test } from 'vitest'

import {
  isOdrlNeedBasedAccessRequest,
  needBasedAccessRequestFromOdrl,
} from '../src/need-based-access-request.js'

const REQUESTER = 'https://id/bob'
const OWNER = 'https://id/alice'
const TREE = 'https://data/shapetrees/trees/Project'
const INSTANCE_1 = 'https://data/alice-home/n1'
const INSTANCE_2 = 'https://data/alice-home/n2'
const REGISTRATION = 'https://data/alice-home/x1n3cm'
const GROUP = 'urn:uuid:6a1f3c2e-4b5d-4e6f-9a0b-1c2d3e4f5a6b'

interface PermissionOptions {
  action?: string[]
  assignee?: string
  assigner?: string
  owner?: string
  type?: string[]
  source?: string[]
  partOf?: string[]
  constraint?: unknown[]
}

function permission(source: string | string[], options: PermissionOptions = {}) {
  return {
    uid: `urn:uuid:${crypto.randomUUID()}`,
    assigner: options.assigner ?? REQUESTER,
    assignee: options.assignee ?? REQUESTER,
    action: options.action ?? [ACCESS_ACTIONS.read],
    ...(options.constraint ? { constraint: options.constraint } : {}),
    target: {
      type: options.type ?? ['Asset'],
      owner: options.owner ?? OWNER,
      source: Array.isArray(source) ? source : [source],
      ...(options.partOf ? { partOf: options.partOf } : {}),
    },
  }
}

function policy(
  permissions: ReturnType<typeof permission>[],
  overrides: Record<string, unknown> = {}
) {
  return {
    type: ['Request', 'AccessNeed', 'AccessRequired'],
    uid: 'urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b',
    profile: 'AccessProfile',
    accessNeedGroup: GROUP,
    registeredShapeTree: TREE,
    ...overrides,
    permission: permissions,
  }
}

function request(policies: Array<Record<string, unknown>>) {
  return {
    type: ['AccessRequest', 'NeedBasedAccessRequest'],
    access: policies,
  }
}

describe('needBasedAccessRequestFromOdrl', () => {
  test('reads every permission of an instance-scoped need', () => {
    const message = request([
      policy(
        [
          permission(INSTANCE_1, { partOf: [REGISTRATION] }),
          permission(INSTANCE_2, { partOf: [REGISTRATION] }),
        ],
        { scopeOfGrant: 'SelectedFromRegistry' }
      ),
    ])
    const result = needBasedAccessRequestFromOdrl(message, REQUESTER, OWNER)
    expect(result.hasAccessNeedGroup.hasAccessNeed).toEqual([
      {
        id: 'urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b',
        type: [INTEROP.AccessNeed],
        registeredShapeTree: TREE,
        required: INTEROP.AccessRequired,
        accessMode: [ACCESS_ACTIONS.read],
        hasDataInstance: [INSTANCE_1, INSTANCE_2],
        hasDataRegistration: REGISTRATION,
      },
    ])
  })

  test('leaves the registration undefined when the instances have no partOf hint', () => {
    const message = request([
      policy([permission(INSTANCE_1), permission(INSTANCE_2)], {
        scopeOfGrant: 'SelectedFromRegistry',
      }),
    ])
    const result = needBasedAccessRequestFromOdrl(message, REQUESTER, OWNER)
    const [need] = result.hasAccessNeedGroup.hasAccessNeed as Record<string, unknown>[]
    expect(need.hasDataInstance).toEqual([INSTANCE_1, INSTANCE_2])
    expect(need.hasDataRegistration).toBeUndefined()
  })

  test('keeps a shape-tree need unchanged', () => {
    const message = request([
      policy([permission(TREE, { type: ['AssetCollection', 'st:ShapeTree'] })]),
    ])
    const result = needBasedAccessRequestFromOdrl(message, REQUESTER, OWNER)
    expect(result.hasAccessNeedGroup.hasAccessNeed).toEqual([
      {
        id: 'urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b',
        type: [INTEROP.AccessNeed],
        registeredShapeTree: TREE,
        required: INTEROP.AccessRequired,
        accessMode: [ACCESS_ACTIONS.read],
      },
    ])
  })

  test('reads a registration-scoped need', () => {
    const message = request([
      policy(
        [
          permission(REGISTRATION, {
            type: ['AssetCollection', 'DataRegistration'],
          }),
        ],
        { scopeOfGrant: 'AllFromRegistry' }
      ),
    ])
    const result = needBasedAccessRequestFromOdrl(message, REQUESTER, OWNER)
    const [need] = result.hasAccessNeedGroup.hasAccessNeed as Record<string, unknown>[]
    expect(need.hasDataRegistration).toBe(REGISTRATION)
    expect(need.hasDataInstance).toBeUndefined()
  })

  test('nests inherited needs', () => {
    const child = policy([permission(INSTANCE_2)], {
      uid: 'urn:uuid:8c3b5e40-6d7f-4f81-9a2b-3c4d5e6f7a8b',
      registeredShapeTree: 'https://data/shapetrees/trees/Task',
      inheritsFromNeed: 'urn:uuid:7b2a4d3f-5c6e-4f70-9a1b-2c3d4e5f6a7b',
      scopeOfGrant: 'SelectedFromRegistry',
    })
    const message = request([
      policy([permission(INSTANCE_1)], { scopeOfGrant: 'SelectedFromRegistry' }),
      child,
    ])
    const result = needBasedAccessRequestFromOdrl(message, REQUESTER, OWNER)
    const [need] = result.hasAccessNeedGroup.hasAccessNeed as Record<string, any>[]
    expect(need.hasDataInstance).toEqual([INSTANCE_1])
    expect(need.hasInheritingNeed).toHaveLength(1)
    expect(need.hasInheritingNeed[0].id).toBe('urn:uuid:8c3b5e40-6d7f-4f81-9a2b-3c4d5e6f7a8b')
    expect(need.hasInheritingNeed[0].hasDataInstance).toEqual([INSTANCE_2])
  })

  test('normalizes compact action terms and rejects unknown actions', () => {
    const compact = policy([permission(INSTANCE_1, { action: ['read', 'modify'] })])
    const result = needBasedAccessRequestFromOdrl(request([compact]), REQUESTER, OWNER)
    const [need] = result.hasAccessNeedGroup.hasAccessNeed as Record<string, unknown>[]
    expect(need.accessMode).toEqual([ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify])

    const unknown = policy([permission(INSTANCE_1, { action: ['write'] })])
    expect(() => needBasedAccessRequestFromOdrl(request([unknown]), REQUESTER, OWNER)).toThrow(
      BadRequestHttpError
    )
  })

  test('rejects mixed Asset and AssetCollection targets in one need', () => {
    const mixed = policy([
      permission(INSTANCE_1),
      permission(TREE, { type: ['AssetCollection', 'st:ShapeTree'] }),
    ])
    expect(() => needBasedAccessRequestFromOdrl(request([mixed]), REQUESTER, OWNER)).toThrow(
      /mixes instance and collection targets/u
    )
  })

  test('rejects inconsistent envelope/assignment values', () => {
    const wrongAssignee = policy([
      permission(INSTANCE_1),
      permission(INSTANCE_2, { assignee: 'https://id/karin' }),
    ])
    expect(() =>
      needBasedAccessRequestFromOdrl(request([wrongAssignee]), REQUESTER, OWNER)
    ).toThrow(/invalid grantedBy\/grantee/u)

    const wrongOwner = policy([permission(INSTANCE_1, { owner: 'https://id/karin' })])
    expect(() => needBasedAccessRequestFromOdrl(request([wrongOwner]), REQUESTER, OWNER)).toThrow(
      /invalid dataOwner/u
    )

    const secondGroup = policy([permission(INSTANCE_1)], { accessNeedGroup: 'urn:uuid:other' })
    const firstGroup = policy([permission(INSTANCE_2)])
    expect(() =>
      needBasedAccessRequestFromOdrl(request([firstGroup, secondGroup]), REQUESTER, OWNER)
    ).toThrow(/multiple access need groups/u)
  })

  test('rejects ODRL constraints', () => {
    const withConstraint = policy([permission(INSTANCE_1)])
    withConstraint.constraint = [
      { leftOperand: 'purpose', operator: 'eq', rightOperand: 'https://purpose.example/x' },
    ]
    expect(() =>
      needBasedAccessRequestFromOdrl(request([withConstraint]), REQUESTER, OWNER)
    ).toThrow(/constraints are not supported/u)
  })

  test('an instance need requires registeredShapeTree', () => {
    const noTree = policy([permission(INSTANCE_1)], { registeredShapeTree: undefined })
    expect(() => needBasedAccessRequestFromOdrl(request([noTree]), REQUESTER, OWNER)).toThrow(
      /require registeredShapeTree/u
    )
  })

  test('isOdrlNeedBasedAccessRequest still requires the SAI type', () => {
    expect(
      isOdrlNeedBasedAccessRequest({
        type: ['AccessRequest', 'NeedBasedAccessRequest'],
        access: [],
      })
    ).toBe(true)
    expect(isOdrlNeedBasedAccessRequest({ type: ['AccessRequest'], access: [] })).toBe(false)
  })
})
