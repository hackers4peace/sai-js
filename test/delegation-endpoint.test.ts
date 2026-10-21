import { buildOidcSession, issuanceUrl } from '@elfpavlik/sai-components'
import type { IncomingGrantData } from '@janeirodigital/interop-data-model'
import { ACL, INTEROP, LDP, toStore } from '@janeirodigital/interop-utils'
import { afterEach, describe, expect, test } from 'vitest'

import { waitForQuiescence } from './util'
import { SOLIDTREES } from './vocabularies'

const bobId = 'https://id/bob'
const aliceId = 'https://id/alice'
const acmeId = 'https://id/acme'
const kimId = 'https://id/kim'
const testClient = 'https://data/test-client/public/id'
const grantRegistry = 'https://registry/acme/grant/'
// seeded in environments/data/registry.trig
const seededGrantCount = 10

const p9m2vr = `${grantRegistry}p9m2vr` // acme → bob (source)
const bobOwnGrant = 'https://registry/bob/grant/t2v9cd' // a different owner's registry

const commonGrantData = {
  grantedBy: bobId,
  dataOwner: acmeId,
  grantee: testClient,
  hasStorage: 'https://data/acme-rnd/',
}
const tasksGrantData: IncomingGrantData = {
  ...commonGrantData,
  registeredShapeTree: SOLIDTREES.Task,
  hasDataRegistration: 'https://data/acme-rnd/x0md9s/',
  accessMode: [ACL.Read, ACL.Update],
  scopeOfGrant: INTEROP.Inherited,
}
const projectsGrantData: IncomingGrantData = {
  ...commonGrantData,
  registeredShapeTree: SOLIDTREES.Project,
  hasDataRegistration: 'https://data/acme-rnd/reb39k/',
  accessMode: [ACL.Read, ACL.Update],
  scopeOfGrant: INTEROP.AllFromRegistry,
  hasInheritingGrant: [tasksGrantData],
}
// second delegable chain from the seed: acme-hr project → inherited task
const hrCommonGrantData = {
  ...commonGrantData,
  hasStorage: 'https://data/acme-hr/',
}
const hrTasksGrantData: IncomingGrantData = {
  ...hrCommonGrantData,
  registeredShapeTree: SOLIDTREES.Task,
  hasDataRegistration: 'https://data/acme-hr/v4n2qx/',
  accessMode: [ACL.Read, ACL.Update],
  scopeOfGrant: INTEROP.Inherited,
}
const hrProjectsGrantData: IncomingGrantData = {
  ...hrCommonGrantData,
  registeredShapeTree: SOLIDTREES.Project,
  hasDataRegistration: 'https://data/acme-hr/p7t9km/',
  accessMode: [ACL.Read, ACL.Update],
  scopeOfGrant: INTEROP.AllFromRegistry,
  hasInheritingGrant: [hrTasksGrantData],
}

const issuancePayload = (grants: IncomingGrantData[]): string =>
  JSON.stringify({ type: [INTEROP.AccessRequest], grants })

async function countGrants(): Promise<number> {
  const session = await buildOidcSession(acmeId)
  const response = await session.authFetch(grantRegistry, {
    headers: { Accept: 'application/ld+json' },
  })
  expect(response.status).toBe(200)
  const dataset = await toStore((await response.json()) as Record<string, unknown>)
  return Array.from(dataset).filter((quad) => quad.predicate.value === LDP.contains).length
}

const revocationPayload = (grants: string[]): string =>
  JSON.stringify({ type: [INTEROP.AccessRevocation], grants })

async function issueProjectsGrant(): Promise<string[]> {
  const session = await buildOidcSession(bobId)
  const response = await session.authFetch(issuanceUrl(acmeId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: issuancePayload([projectsGrantData]),
  })
  expect(response.status).toBe(200)
  // the endpoint echoes the finalised grants (step 4 of check-equivalence)
  const granted = (await response.json()) as { id: string }[]
  return granted.map((grant) => grant.id)
}

describe('DelegationRevocationEndpoint', () => {
  // A revocation PATCHes the owner's registration, which fires the grantee's
  // reciprocal webhook and starts a mirror/regeneration workflow. Never let
  // it outlive the test: the per-test dataset reset would race the still
  // running workflow (the CSS store 500 seen on `getExistingGrants`).
  afterEach(async () => {
    await waitForQuiescence([acmeId, bobId, aliceId, kimId])
  })

  test('revokes a listed grant and its inheriting child', async (): Promise<void> => {
    const ids = await issueProjectsGrant()
    const [parentId, childId] = ids

    // a grantor cannot DELETE grant resources directly (DD14 — read-only ACR)
    const bobSession = await buildOidcSession(bobId)
    const directDelete = await bobSession.authFetch(childId, { method: 'DELETE' })
    expect(directDelete.status).toBe(403)

    const session = await buildOidcSession(bobId)
    const response = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId]),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([parentId])

    // the child dies with its parent — the registry is back to the seed
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('re-revoking an already-removed grant is an idempotent echo', async (): Promise<void> => {
    const ids = await issueProjectsGrant()
    const [parentId] = ids
    const session = await buildOidcSession(bobId)

    const first = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId]),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([parentId])

    const second = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId]),
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual([parentId])
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('mixed existing and already-removed grants echoes both and removes the existing', async (): Promise<void> => {
    const ids = await issueProjectsGrant()
    const [parentId] = ids

    const session = await buildOidcSession(bobId)
    const response = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId, 'https://registry/acme/grant/does-not-exist']),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([parentId, 'https://registry/acme/grant/does-not-exist'])
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('unauthorized grantor fails the whole request with no mutation', async (): Promise<void> => {
    const ids = await issueProjectsGrant()
    const [parentId] = ids

    const kimSession = await buildOidcSession(kimId)
    const response = await kimSession.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId]),
    })
    expect(response.status).toBe(403)
    // typed (C4): the body carries the machine-readable code
    expect((await response.json()).code).toBe('unauthorized')
    expect(await countGrants()).toBe(seededGrantCount + 2)
  })

  test('a mixed-owner request fails as a whole on the requested set (B2)', async (): Promise<void> => {
    const session = await buildOidcSession(acmeId)
    const response = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([p9m2vr, bobOwnGrant]),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'mixed-owner',
      grants: [p9m2vr, bobOwnGrant],
    })
    // no partial apply
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('a grant IRI from no known registry is a typed unknown refusal', async (): Promise<void> => {
    const session = await buildOidcSession(acmeId)
    const unknownGrant = 'https://unknown.example/registry/grant/x'
    const response = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([unknownGrant]),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'unknown',
      grants: [unknownGrant],
    })
  })

  test('multi-hop chain: revoking the entry point removes the downstream grant (C1)', async () => {
    const issueHop = async (grantedBy: string, grantee: string): Promise<string> => {
      const session = await buildOidcSession(grantedBy)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          {
            ...commonGrantData,
            grantedBy,
            grantee,
            registeredShapeTree: SOLIDTREES.Project,
            hasDataRegistration: 'https://data/acme-rnd/reb39k/',
            accessMode: [ACL.Read, ACL.Update],
            scopeOfGrant: INTEROP.AllFromRegistry,
          },
        ]),
      })
      expect(response.status).toBe(200)
      const granted = (await response.json()) as { id: string }[]
      expect(granted).toHaveLength(1)
      return granted[0].id
    }

    // acme → bob (seeded source) → alice (first hop) → bob (second hop). The
    // second hop is valid only through the recursive chain predicate; the old
    // direct-upstream check accepted it too, but the revocation closure is
    // what C1 changes.
    const entryPoint = await issueHop(bobId, aliceId)
    await issueHop(aliceId, bobId)
    expect(await countGrants()).toBe(seededGrantCount + 2)

    const session = await buildOidcSession(bobId)
    const response = await session.authFetch(issuanceUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([entryPoint]),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([entryPoint])
    // the entry point and the downstream hop are both gone
    expect(await countGrants()).toBe(seededGrantCount)
  })
})

describe('DelegationIssuanceEndpoint', () => {
  describe('agent delegates to application', (): void => {
    test('happy path', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([projectsGrantData]),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      // the echo carries the finalised grants: parent + inheriting child, linked
      const granted = (await response.json()) as {
        id: string
        hasInheritingGrant?: string[]
        inheritsFromGrant?: string
      }[]
      expect(granted).toHaveLength(2) // parent + inheriting child
      for (const grant of granted) expect(grant.id).toMatch(grantRegistry)
      expect(granted[0].hasInheritingGrant).toEqual([granted[1].id])
      expect(granted[1].inheritsFromGrant).toBe(granted[0].id)
      expect(await countGrants()).toBe(seededGrantCount + 2)
    })
    test('multiple grants are issued all-or-nothing', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([projectsGrantData, hrProjectsGrantData]),
      })
      expect(response.status).toBe(200)
      const granted = (await response.json()) as {
        id: string
        hasInheritingGrant?: string[]
      }[]
      expect(granted).toHaveLength(4) // two parents + two inheriting children
      for (const grant of granted) expect(grant.id).toMatch(grantRegistry)
      // response order: parent, its children, next parent, its children
      expect(granted[0].hasInheritingGrant).toEqual([granted[1].id])
      expect(granted[2].hasInheritingGrant).toEqual([granted[3].id])
      expect(await countGrants()).toBe(seededGrantCount + 4)
    })
    test('invalid grantedBy fails and nothing is created', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([{ ...projectsGrantData, grantedBy: 'https://id/kim' }]),
      })
      expect(response.status).toBe(400)
      expect(await countGrants()).toBe(seededGrantCount)
    })
    test('no covering upstream grant fails and nothing is created (C1)', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          {
            ...projectsGrantData,
            hasDataRegistration: 'https://data/acme-rnd/does-not-exist/',
            hasInheritingGrant: undefined,
          },
        ]),
      })
      expect(response.status).toBe(400)
      expect(await countGrants()).toBe(seededGrantCount)
    })
    test('different dataOwner fails all grants and nothing is created', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          { ...projectsGrantData, dataOwner: 'https://id/kim' },
          projectsGrantData,
        ]),
      })
      expect(response.status).toBe(400)
      expect(await countGrants()).toBe(seededGrantCount)
    })
    test('empty grants fails', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([]),
      })
      expect(response.status).toBe(400)
    })
    test('wrong client', async (): Promise<void> => {
      const clientId = 'https://data/test-client/public/id'
      const session = await buildOidcSession(bobId, clientId)
      const response = await session.authFetch(issuanceUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([projectsGrantData]),
      })
      expect(response.status).toBe(403)
    })
  })
})
