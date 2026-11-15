import {
  accessGrantsUrl,
  accessRequestsUrl,
  buildOidcSession,
  buildSessionManager,
} from '@elfpavlik/sai-components'
import { type GrantData, grantAccess } from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP, LWS } from '@janeirodigital/interop-utils'
import { afterEach, describe, expect, test } from 'vitest'

import { containedCount, waitForQuiescence } from './util'
import { SOLIDTREES } from './vocabularies'

const bobId = 'https://id/bob'
const aliceId = 'https://id/alice'
const acmeId = 'https://id/acme'
const kimId = 'https://id/kim'
const testClient = 'https://data/test-client/public/id'
const grantRegistry = 'https://registry/acme/grant/'
// seeded in environments/data/registry.trig
const seededGrantCount = 10

const p9m2vr = 'https://registry/acme/p9m2vr' // acme → bob (source)
const bobOwnGrant = 'https://registry/bob/t2v9cd' // a different owner's registry

interface IncomingGrantFields {
  assignee?: string
  storage?: string
  scopeOfGrant: string
  hasDataRegistration: string
  registeredShapeTree: string
  grantedBy?: string
  dataOwner?: string
  actions?: string[]
  hasDataInstance?: string[]
  hasInheritingGrant?: GrantData[]
}

function incomingGrant(fields: IncomingGrantFields): GrantData {
  const storage = fields.storage ?? 'https://data/acme-rnd/'
  const actions = fields.actions ?? [ACCESS_ACTIONS.read, ACCESS_ACTIONS.modify]
  return {
    type: [LWS.AccessGrant],
    storage,
    access: grantAccess({
      scopeOfGrant: fields.scopeOfGrant,
      owner: fields.dataOwner ?? acmeId,
      storage,
      hasDataRegistration: fields.hasDataRegistration,
      hasDataInstance: fields.hasDataInstance,
      registeredShapeTree: fields.registeredShapeTree,
      assigner: fields.grantedBy ?? bobId,
      assignee: fields.assignee ?? testClient,
      actions,
    }),
    grantedBy: fields.grantedBy ?? bobId,
    dataOwner: fields.dataOwner ?? acmeId,
    registeredShapeTree: fields.registeredShapeTree,
    hasDataRegistration: fields.hasDataRegistration,
    scopeOfGrant: fields.scopeOfGrant,
    ...(fields.hasDataInstance ? { hasDataInstance: fields.hasDataInstance } : {}),
    ...(fields.hasInheritingGrant ? { hasInheritingGrant: fields.hasInheritingGrant } : {}),
  }
}

const tasksGrantData: GrantData = incomingGrant({
  registeredShapeTree: SOLIDTREES.Task,
  hasDataRegistration: 'https://data/acme-rnd/x0md9s',
  scopeOfGrant: INTEROP.Inherited,
})
const projectsGrantData: GrantData = incomingGrant({
  registeredShapeTree: SOLIDTREES.Project,
  hasDataRegistration: 'https://data/acme-rnd/reb39k',
  scopeOfGrant: INTEROP.AllFromRegistry,
  hasInheritingGrant: [tasksGrantData],
})
// second delegable chain from the seed: acme-hr project → inherited task
const hrTasksGrantData: GrantData = incomingGrant({
  storage: 'https://data/acme-hr/',
  registeredShapeTree: SOLIDTREES.Task,
  hasDataRegistration: 'https://data/acme-hr/v4n2qx',
  scopeOfGrant: INTEROP.Inherited,
})
const hrProjectsGrantData: GrantData = incomingGrant({
  storage: 'https://data/acme-hr/',
  registeredShapeTree: SOLIDTREES.Project,
  hasDataRegistration: 'https://data/acme-hr/p7t9km',
  scopeOfGrant: INTEROP.AllFromRegistry,
  hasInheritingGrant: [hrTasksGrantData],
})

const wireContext = [
  'https://www.w3.org/ns/lws/v1',
  'http://www.w3.org/ns/odrl.jsonld',
  'https://www.w3.org/ns/solid/interop-context/v1',
]

const issuancePayload = (grants: GrantData[]): string =>
  JSON.stringify(
    grants.map((top) => {
      const parentPolicyId = top.access[0]?.uid
      const children = (top.hasInheritingGrant ?? []) as unknown as GrantData[]
      const childPolicies = children.flatMap((child) =>
        child.access.map((policy) => ({
          ...policy,
          ...(parentPolicyId ? { inheritsFromGrant: parentPolicyId } : {}),
        }))
      )
      return {
        '@context': wireContext,
        type: ['AccessRequest', 'DelegationRequest'],
        access: [...top.access, ...childPolicies],
      }
    })
  )

async function countGrants(): Promise<number> {
  // flat registry: members are listed with `lws:contains`, and the registry
  // storage accepts only LWS tokens — read it through the session fetch
  const session = await buildSessionManager().getSession(acmeId)
  return containedCount(session, grantRegistry)
}

const revocationPayload = (grants: string[]): string =>
  JSON.stringify({
    '@context': wireContext,
    type: ['AccessRequest', 'AccessRevocationRequest'],
    grants,
  })

async function issueProjectsGrant(): Promise<string[]> {
  const session = await buildOidcSession(bobId)
  const response = await session.authFetch(accessRequestsUrl(acmeId), {
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

  test('the read-only grant endpoint rejects revocation POSTs', async (): Promise<void> => {
    const session = await buildOidcSession(acmeId)
    const response = await session.authFetch(accessGrantsUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([p9m2vr]),
    })
    expect(response.status).toBe(405)
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('revokes a listed grant and its inheriting child', async (): Promise<void> => {
    const ids = await issueProjectsGrant()
    const [parentId, childId] = ids

    // a grantor cannot DELETE grant resources directly (DD14 — read-only ACR)
    // the direct DELETE must carry the storage's LWS token so the read-only
    // ACR denies it (403); a DPoP-only request would 401 before the ACR check
    const bobSession = await buildSessionManager().getSession(bobId)
    const directDelete = await bobSession.fetch(childId, { method: 'DELETE' })
    expect(directDelete.status).toBe(403)

    const session = await buildOidcSession(bobId)
    const response = await session.authFetch(accessRequestsUrl(acmeId), {
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

    const first = await session.authFetch(accessRequestsUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId]),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([parentId])

    const second = await session.authFetch(accessRequestsUrl(acmeId), {
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
    const response = await session.authFetch(accessRequestsUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([parentId, 'https://registry/acme/does-not-exist']),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([parentId, 'https://registry/acme/does-not-exist'])
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('unauthorized grantor fails the whole request with no mutation', async (): Promise<void> => {
    const ids = await issueProjectsGrant()
    const [parentId] = ids

    const kimSession = await buildOidcSession(kimId)
    const response = await kimSession.authFetch(accessRequestsUrl(acmeId), {
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
    const response = await session.authFetch(accessRequestsUrl(acmeId), {
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

  test('revoking an existing grant owned by someone else is unauthorized', async (): Promise<void> => {
    const session = await buildOidcSession(acmeId)
    const response = await session.authFetch(accessRequestsUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: revocationPayload([bobOwnGrant]),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'unauthorized',
      grants: [bobOwnGrant],
    })
    // the foreign owner's grant is untouched
    expect(await countGrants()).toBe(seededGrantCount)
  })

  test('a grant IRI from no known registry is a typed unknown refusal', async (): Promise<void> => {
    const session = await buildOidcSession(acmeId)
    const unknownGrant = 'https://unknown.example/registry/grant/x'
    const response = await session.authFetch(accessRequestsUrl(acmeId), {
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
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          incomingGrant({
            grantedBy,
            assignee: grantee,
            registeredShapeTree: SOLIDTREES.Project,
            hasDataRegistration: 'https://data/acme-rnd/reb39k',
            scopeOfGrant: INTEROP.AllFromRegistry,
          }),
        ]),
      })
      expect(response.status).toBe(200)
      const granted = (await response.json()) as { id: string; type: string[] }[]
      expect(granted).toHaveLength(1)
      expect(granted[0].type).toContain(LWS.AccessGrant)
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
    const response = await session.authFetch(accessRequestsUrl(acmeId), {
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
  test('the read-only grant endpoint rejects delegation POSTs', async (): Promise<void> => {
    const session = await buildOidcSession(bobId)
    const response = await session.authFetch(accessGrantsUrl(acmeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: issuancePayload([projectsGrantData]),
    })
    expect(response.status).toBe(405)
    expect(await countGrants()).toBe(seededGrantCount)
  })

  describe('agent delegates to application', (): void => {
    test('happy path', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
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
      // issued grants are flat registry members: `{registryPodRoot}{uuid}`
      for (const grant of granted)
        expect(grant.id).toMatch(/^https:\/\/registry\/acme\/[0-9a-f-]{36}$/u)
      expect(granted[0].hasInheritingGrant).toEqual([granted[1].id])
      expect(granted[1].inheritsFromGrant).toBe(granted[0].id)
      expect(await countGrants()).toBe(seededGrantCount + 2)
    })
    test('multiple grants are issued all-or-nothing', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
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
      // issued grants are flat registry members: `{registryPodRoot}{uuid}`
      for (const grant of granted)
        expect(grant.id).toMatch(/^https:\/\/registry\/acme\/[0-9a-f-]{36}$/u)
      // response order: parent, its children, next parent, its children
      expect(granted[0].hasInheritingGrant).toEqual([granted[1].id])
      expect(granted[2].hasInheritingGrant).toEqual([granted[3].id])
      expect(await countGrants()).toBe(seededGrantCount + 4)
    })
    test('invalid grantedBy fails and nothing is created', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          incomingGrant({
            grantedBy: 'https://id/kim',
            registeredShapeTree: SOLIDTREES.Project,
            hasDataRegistration: 'https://data/acme-rnd/reb39k',
            scopeOfGrant: INTEROP.AllFromRegistry,
          }),
        ]),
      })
      expect(response.status).toBe(400)
      expect(await countGrants()).toBe(seededGrantCount)
    })
    test('no covering upstream grant fails and nothing is created (C1)', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          incomingGrant({
            registeredShapeTree: SOLIDTREES.Project,
            hasDataRegistration: 'https://data/acme-rnd/does-not-exist/',
            scopeOfGrant: INTEROP.AllFromRegistry,
          }),
        ]),
      })
      expect(response.status).toBe(400)
      expect(await countGrants()).toBe(seededGrantCount)
    })
    test('different dataOwner fails all grants and nothing is created', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([
          incomingGrant({
            dataOwner: 'https://id/kim',
            registeredShapeTree: SOLIDTREES.Project,
            hasDataRegistration: 'https://data/acme-rnd/reb39k',
            scopeOfGrant: INTEROP.AllFromRegistry,
          }),
          projectsGrantData,
        ]),
      })
      expect(response.status).toBe(400)
      expect(await countGrants()).toBe(seededGrantCount)
    })
    test('empty grants fails', async (): Promise<void> => {
      const session = await buildOidcSession(bobId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([]),
      })
      expect(response.status).toBe(400)
    })
    test('wrong client', async (): Promise<void> => {
      const clientId = 'https://data/test-client/public/id'
      const session = await buildOidcSession(bobId, clientId)
      const response = await session.authFetch(accessRequestsUrl(acmeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json' },
        body: issuancePayload([projectsGrantData]),
      })
      expect(response.status).toBe(403)
    })
  })
})
