import { grantAccess } from '@janeirodigital/interop-data-model'
import { INTEROP, ODRL, ODRL_ID_JAG_CONTEXT } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  rewriteAccessClaim,
  setAccessClaimAssignee,
  verifyAccessClaim,
} from '../src/access-claim.js'

const STORAGE = 'https://data/acme.example/'
const SHAPE_TREE = 'https://data/shapetrees/trees/Project'
const REGISTRATION = 'https://data/acme.example/registration/'
const OWNER = 'https://id/alice'
const GRANTEE = 'https://id/bob'

function claim(scope: string): Record<string, any>[] {
  return grantAccess({
    scopeOfGrant: scope,
    owner: OWNER,
    storage: STORAGE,
    hasDataRegistration: REGISTRATION,
    hasDataInstance:
      scope === INTEROP.SelectedFromRegistry ? ['https://data/acme.example/p'] : undefined,
    registeredShapeTree: SHAPE_TREE,
    agent: 'https://id/yoyo#id',
    assigner: OWNER,
    assignee: GRANTEE,
    actions: [ODRL.read],
  }) as Record<string, any>[]
}

const parent = {
  id: 'urn:uuid:parent-grant',
  uid: 'urn:uuid:parent-grant',
  profile: 'http://www.w3.org/ns/solid/interop#AccessProfile',
  scopeOfGrant: 'http://www.w3.org/ns/solid/interop#AllFromRegistry',
  permission: [{ id: 'urn:uuid:parent-permission', action: ['odrl:read'] }],
}

const child = {
  id: 'urn:uuid:child-grant',
  uid: 'urn:uuid:child-grant',
  profile: 'http://www.w3.org/ns/solid/interop#AccessProfile',
  scopeOfGrant: 'http://www.w3.org/ns/solid/interop#Inherited',
  inheritsFromGrant: 'urn:uuid:parent-grant',
  permission: [{ id: 'urn:uuid:child-permission', action: ['odrl:read'] }],
}

describe('claim target profile', () => {
  test('accepts an AllFromAgent claim with a shape tree and no registration', async () => {
    await expect(
      verifyAccessClaim(claim(INTEROP.AllFromAgent), ODRL_ID_JAG_CONTEXT, STORAGE)
    ).resolves.toMatchObject({ storage: STORAGE })
  })

  test('rejects a policy-level registeredShapeTree', async () => {
    const legacy = claim(INTEROP.AllFromRegistry)
    const target = legacy[0].permission[0].target as Record<string, unknown>
    legacy[0].registeredShapeTree = target.registeredShapeTree
    delete target.registeredShapeTree
    await expect(verifyAccessClaim(legacy, ODRL_ID_JAG_CONTEXT, STORAGE)).rejects.toThrow(
      /belongs on the target/u
    )
  })

  test('rejects a selected claim without hasDataRegistration', async () => {
    const selected = claim(INTEROP.SelectedFromRegistry)
    delete (selected[0].permission[0].target as Record<string, unknown>).hasDataRegistration
    await expect(verifyAccessClaim(selected, ODRL_ID_JAG_CONTEXT, STORAGE)).rejects.toThrow(
      /hasDataRegistration/u
    )
  })
})

describe('access claim rewriting', () => {
  test('keeps parent/child links internal to the rewritten claim', () => {
    const [rewrittenParent, rewrittenChild] = rewriteAccessClaim(
      [parent, child],
      'https://id/yoyo'
    ) as Record<string, any>[]

    expect(rewrittenParent.id).toMatch(/^urn:uuid:/u)
    expect(rewrittenParent.id).not.toBe(parent.id)
    expect(rewrittenChild.id).toMatch(/^urn:uuid:/u)
    expect(rewrittenChild.id).not.toBe(child.id)
    expect(rewrittenChild.inheritsFromGrant).toBe(rewrittenParent.id)
    expect(JSON.stringify([rewrittenParent, rewrittenChild])).not.toContain(parent.id)
    expect(JSON.stringify([rewrittenParent, rewrittenChild])).not.toContain(child.id)
  })

  test('the first ID-JAG keeps the derivable parent/child link', () => {
    const [rewrittenParent, rewrittenChild] = setAccessClaimAssignee(
      [parent, child],
      'https://id/alice'
    ) as Record<string, any>[]

    expect(rewrittenChild.inheritsFromGrant).toBe(parent.uid)
    expect(rewrittenParent.assignee).toBe('https://id/alice')
    expect(rewrittenChild.assignee).toBe('https://id/alice')
  })
})
