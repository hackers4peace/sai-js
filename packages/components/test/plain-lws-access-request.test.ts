import { ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import { BadRequestHttpError } from '@solid/community-server'
import { describe, expect, test } from 'vitest'

import {
  isPlainLwsAccessRequest,
  plainLwsAccessRequestToNeedBased,
} from '../src/plain-lws-access-request.js'
import type { PlainLwsTargetResolver } from '../src/plain-lws-access-request.js'

const REQUESTER = 'https://id/bob'
const OWNER = 'https://id/alice'
const TREE = 'https://data/shapetrees/trees/Project'
const INSTANCE_1 = 'https://data/alice-home/n1'
const INSTANCE_2 = 'https://data/alice-home/n2'
const REGISTRATION = 'https://data/alice-home/x1n3cm'

const resolver: PlainLwsTargetResolver = async (target) => {
  if (target.source.includes(INSTANCE_1) || target.source.includes(INSTANCE_2)) {
    return [
      {
        registeredShapeTree: TREE,
        hasDataRegistration: REGISTRATION,
        hasDataInstance: target.source,
      },
    ]
  }
  if (target.source.includes(REGISTRATION)) {
    return [{ registeredShapeTree: TREE, hasDataRegistration: REGISTRATION }]
  }
  if (target.source.includes(TREE)) {
    return [{ registeredShapeTree: TREE }]
  }
  return []
}

function permission(action: Array<string>, type: Array<string>, source: Array<string>, extra = {}) {
  return {
    action,
    assignee: REQUESTER,
    target: { type, source },
    ...extra,
  }
}

function message(permissions: Array<Record<string, unknown>>) {
  return {
    type: ['AccessRequest'],
    access: [{ type: ['Request'], uid: 'urn:uuid:policy', permission: permissions }],
  }
}

describe('isPlainLwsAccessRequest', () => {
  test('accepts AccessRequest without the SAI need type', () => {
    expect(isPlainLwsAccessRequest({ type: ['AccessRequest'], access: [] })).toBe(true)
    expect(
      isPlainLwsAccessRequest({
        type: ['AccessRequest', 'NeedBasedAccessRequest'],
        access: [],
      })
    ).toBe(false)
    expect(
      isPlainLwsAccessRequest({ type: ['AccessRequest', 'DelegationRequest'], access: [] })
    ).toBe(false)
    expect(isPlainLwsAccessRequest({ type: ['AccessRequest'] })).toBe(false)
  })
})

describe('plainLwsAccessRequestToNeedBased', () => {
  test('maps Asset permissions to instance-scoped needs and groups by action set', async () => {
    const input = await plainLwsAccessRequestToNeedBased(
      message([
        permission([ACCESS_ACTIONS.read], ['Asset'], [INSTANCE_1, INSTANCE_2]),
        permission([ACCESS_ACTIONS.modify], ['Asset'], [INSTANCE_1]),
      ]),
      REQUESTER,
      OWNER,
      resolver
    )

    expect(input.grantee).toBe(REQUESTER)
    expect(input.grantedBy).toBe(REQUESTER)
    expect(input.dataOwner).toBe(OWNER)
    expect(input.hasAccessNeedGroup.hasAccessNeed).toEqual([
      expect.objectContaining({
        type: [INTEROP.AccessNeed],
        registeredShapeTree: TREE,
        required: INTEROP.AccessRequired,
        accessMode: [ACCESS_ACTIONS.read],
        hasDataInstance: [INSTANCE_1, INSTANCE_2],
        hasDataRegistration: REGISTRATION,
      }),
      expect.objectContaining({
        registeredShapeTree: TREE,
        accessMode: [ACCESS_ACTIONS.modify],
        hasDataInstance: [INSTANCE_1],
        hasDataRegistration: REGISTRATION,
      }),
    ])
  })

  test('maps an AssetCollection DataRegistration target to a registration-scoped need', async () => {
    const input = await plainLwsAccessRequestToNeedBased(
      message([
        permission([ACCESS_ACTIONS.read], ['AssetCollection', 'DataRegistration'], [REGISTRATION]),
      ]),
      REQUESTER,
      OWNER,
      resolver
    )
    const [need] = input.hasAccessNeedGroup.hasAccessNeed as Array<Record<string, unknown>>
    expect(need.hasDataRegistration).toBe(REGISTRATION)
    expect(need.hasDataInstance).toBeUndefined()
  })

  test('maps an AssetCollection ShapeTree target to a shape-tree need', async () => {
    const input = await plainLwsAccessRequestToNeedBased(
      message([permission([ACCESS_ACTIONS.read], ['AssetCollection', 'st:ShapeTree'], [TREE])]),
      REQUESTER,
      OWNER,
      resolver
    )
    const [need] = input.hasAccessNeedGroup.hasAccessNeed as Array<Record<string, unknown>>
    expect(need.registeredShapeTree).toBe(TREE)
    expect(need.hasDataRegistration).toBeUndefined()
    expect(need.hasDataInstance).toBeUndefined()
  })

  test('accepts a missing assigner (self-request) and compact actions', async () => {
    const input = await plainLwsAccessRequestToNeedBased(
      message([
        {
          action: ['read'],
          assignee: REQUESTER,
          target: { type: ['Asset'], source: [INSTANCE_1] },
        },
      ]),
      REQUESTER,
      OWNER,
      resolver
    )
    const [need] = input.hasAccessNeedGroup.hasAccessNeed as Array<Record<string, unknown>>
    expect(need.accessMode).toEqual([ACCESS_ACTIONS.read])
  })

  test('rejects constraints, wrong assignees, empty sources, and unresolvable targets', async () => {
    await expect(
      plainLwsAccessRequestToNeedBased(
        message([
          permission([ACCESS_ACTIONS.read], ['Asset'], [INSTANCE_1], {
            constraint: [{ leftOperand: 'purpose', operator: 'eq', rightOperand: 'x' }],
          }),
        ]),
        REQUESTER,
        OWNER,
        resolver
      )
    ).rejects.toThrow(/constraints are not supported/u)

    await expect(
      plainLwsAccessRequestToNeedBased(
        message([
          {
            action: ['read'],
            assignee: 'https://id/karin',
            target: { type: ['Asset'], source: [INSTANCE_1] },
          },
        ]),
        REQUESTER,
        OWNER,
        resolver
      )
    ).rejects.toThrow(BadRequestHttpError)

    await expect(
      plainLwsAccessRequestToNeedBased(
        message([permission([ACCESS_ACTIONS.read], ['Asset'], [])]),
        REQUESTER,
        OWNER,
        resolver
      )
    ).rejects.toThrow(/has no source/u)

    await expect(
      plainLwsAccessRequestToNeedBased(
        message([permission([ACCESS_ACTIONS.read], ['Asset'], ['https://data/unknown'])]),
        REQUESTER,
        OWNER,
        resolver
      )
    ).rejects.toThrow(/does not resolve/u)
  })
})
