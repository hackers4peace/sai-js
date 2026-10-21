import { describe, expect, test } from 'vitest'

import { rpcCall, rpcPayload } from './util'

// C0 acceptance (user-run under dagger): the read-only authorization listing
// for a peer, through the same RPC the UI calls. Seeded in
// environments/data/registry.trig: acme's authorizations for bob — a Project
// parent and its inherited Task child.

const acmeCookie = 'css-account=a1b9f0e2-3c4d-4e5f-8a7b-0c9d1e2f3a4b'
const acmeId = 'https://id/acme'
const bobId = 'https://id/bob'
const PARENT = 'https://registry/acme/authorization/p3j7mq'
const CHILD = 'https://registry/acme/authorization/m9k4wr'

interface RecordedAuthorization {
  id: string
  grantee: string
  grantedBy: string
  registeredShapeTree: string
  scopeOfAuthorization: string
  shapeTreeLabel: string
  accessMode: string[]
  dataOwner?: string
  hasDataRegistration?: string
  inheritsFromAuthorization?: string
  hasInheritingAuthorization?: string[]
}

function listAuthorizations(grantee: string) {
  return rpcCall<RecordedAuthorization[]>(
    rpcPayload({
      _tag: 'ListAuthorizations',
      grantee,
      lang: 'en',
      context: acmeId,
    }),
    acmeCookie
  )
}

describe('ListAuthorizations (C0)', () => {
  test('lists the recorded authorizations for a grantee, including inherited children', async () => {
    const authorizations = await listAuthorizations(bobId)

    expect(authorizations.map((authorization) => authorization.id)).toEqual(
      expect.arrayContaining([PARENT, CHILD])
    )
    const parent = authorizations.find((authorization) => authorization.id === PARENT)!
    const child = authorizations.find((authorization) => authorization.id === CHILD)!

    expect(parent.grantee).toBe(bobId)
    expect(parent.scopeOfAuthorization).toContain('AllFromAgent')
    expect(parent.shapeTreeLabel).toBeTruthy()
    expect(parent.accessMode.length).toBeGreaterThan(0)

    expect(child.inheritsFromAuthorization).toBe(PARENT)
    expect(child.scopeOfAuthorization).toContain('Inherited')
    expect(child.shapeTreeLabel).toBeTruthy()
  })

  test('returns an empty list for a grantee without authorizations', async () => {
    await expect(listAuthorizations('https://id/nobody')).resolves.toEqual([])
  })
})
