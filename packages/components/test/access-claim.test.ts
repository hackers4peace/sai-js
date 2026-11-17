import { describe, expect, test } from 'vitest'

import { rewriteAccessClaim, setAccessClaimAssignee } from '../src/access-claim.js'

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
