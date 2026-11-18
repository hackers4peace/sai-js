import { agentId, buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import {
  getDataAuthorization,
  listContained,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { grantAccessModes, grantGrantee } from '@janeirodigital/interop-data-model'
import { INTEROP, getRegistrySetIri } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  awaitGrantCompletion,
  accessGrants,
  waitFor,
  waitForQuiescence,
  waitForRoleCreatedCompletion,
} from './util'

/**
 * Phase 2 of org-admin-feature.md — operating in context.
 *
 * Seed (environments/data/registry.trig): Dan is an admin of YoYo — YoYo's
 * registration of Dan (`ph8e70`) carries the `hasAdminGrant` admin marker and
 * YoYo's `.acr` `#fullAdminAccess` matches Dan + his UAS. Runs the
 * real-CSS-delivery path (RPCs via the account cookies, sessions via
 * buildOidcSession / buildSessionManager).
 */

const rpcEndpoint = 'https://auth/.sai/api'

const danId = 'https://id/dan'
// NOTE: the account cookie VALUE is the `accounts/cookies/<value>` key in kv.json,
// NOT the accountId — dan's account is 9f137c45-…, its cookie is 4f8fe6e4-…
const danCookie = 'css-account=4f8fe6e4-4a5a-4318-93f6-d8645778fc28'
const bobId = 'https://id/bob'
const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'
const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
const yoyoId = 'https://id/yoyo'
const yoyoRegistrySet = 'https://registry/yoyo/'

function rpcPayload(request: unknown) {
  return [
    {
      request,
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]
}

/** Resolve a RPC to its value; any non-Success outcome throws with the body. */
async function rpcCall<T>(payload: unknown, cookie: string): Promise<T> {
  const response = await fetch(rpcEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`RPC failed with ${response.status}: ${await response.text()}`)
  }
  const body = await response.json()
  const result = body[0]
  if (result._tag !== 'Success') {
    throw new Error(`RPC failed: ${JSON.stringify(result)}`)
  }
  return result.value as T
}

/** The RPC must reject (unallowed context / guard) — accepts ProtocolError and Failure shapes. */
async function expectRpcError(payload: unknown, cookie: string): Promise<void> {
  const response = await fetch(rpcEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) return // server-side error (defect → HTTP error)
  const body = await response.json()
  const result = body[0]
  if (result._tag === 'Success') {
    throw new Error(`expected RPC error, got Success: ${JSON.stringify(result.value)}`)
  }
}

describe('org context — discovery (2.1/2.2)', () => {
  test('personal ListSocialAgents flags the orgs the user administers (reciprocal `adminOf`)', async () => {
    const agents = await rpcCall<{ id: string; admin: boolean; adminOf: boolean }[]>(
      rpcPayload({ _tag: 'ListSocialAgents', lang: 'en', context: danId }),
      danCookie
    )
    const yoyo = agents.find((agent) => agent.id === yoyoId)
    expect(yoyo).toBeDefined()
    // the RECIPROCAL marker — the switcher source (orgs the user administers)
    expect(yoyo!.adminOf).toBe(true)
    // Phase 5: `admin` is the DIRECT marker in the personal context too —
    // Dan never made YoYo HIS admin, so it stays false here
    expect(yoyo!.admin).toBe(false)
    // a plain peer is not flagged either way
    const bob = agents.find((agent) => agent.id === bobId)
    if (bob) expect(bob.adminOf).toBe(false)
  })

  test('org-context ListSocialAgents reads the org registry directly (admin marker on the org registration)', async () => {
    const agents = await rpcCall<{ id: string; admin: boolean }[]>(
      rpcPayload({ _tag: 'ListSocialAgents', lang: 'en', context: yoyoId }),
      danCookie
    )
    const dan = agents.find((agent) => agent.id === danId)
    expect(dan).toBeDefined()
    expect(dan!.admin).toBe(true)
    expect(agents.some((agent) => agent.id === bobId)).toBe(true)
  })
})

describe('org context — registry-set resolution (2.3)', () => {
  test('AgentIdHandler exposes the hasRegistrySet link only to admins', async () => {
    const regSetRel = 'http://www.w3.org/ns/solid/interop#hasRegistrySet'

    const danSession = await buildOidcSession(danId)
    const adminResponse = await danSession.authFetch(agentId(yoyoId), { method: 'HEAD' })
    expect(adminResponse.status).toBe(200)
    expect(getRegistrySetIri(adminResponse.headers.get('link') ?? '')).toBe(yoyoRegistrySet)

    const bobSession = await buildOidcSession(bobId)
    const nonAdminResponse = await bobSession.authFetch(agentId(yoyoId), { method: 'HEAD' })
    expect(nonAdminResponse.status).toBe(200)
    const link = nonAdminResponse.headers.get('link') ?? ''
    expect(link).not.toContain(regSetRel)
  })

  test('the admin session resolves the org registry set and can read the org registries', async () => {
    const manager = buildSessionManager()
    const danSession = await manager.getSession(danId)

    const registrySet = await danSession.getRegistrySet(yoyoId)
    expect(registrySet.id).toBe(yoyoRegistrySet)
    expect(registrySet.hasSocialAgentRegistry.id).toBe('https://registry/yoyo/social-agent/')
    expect(registrySet.hasRoleRegistry.id).toBe('https://registry/yoyo/role/')

    // the resolved registry set must be readable with the admin's (authenticated) fetch
    const response = await danSession.fetch(registrySet.hasRoleRegistry.id)
    expect(response.ok).toBe(true)
  })
})

describe('org context — context authorization (2.2)', () => {
  test('an admin can target the org context; a non-admin is rejected', async () => {
    const roles = await rpcCall<unknown[]>(
      rpcPayload({ _tag: 'ListRoles', lang: 'en', context: yoyoId }),
      danCookie
    )
    expect(Array.isArray(roles)).toBe(true)

    await expectRpcError(rpcPayload({ _tag: 'ListRoles', lang: 'en', context: yoyoId }), bobCookie)
    await expectRpcError(
      rpcPayload({ _tag: 'ListRoles', lang: 'en', context: yoyoId }),
      aliceCookie
    )
  })

  test('the personal context is always allowed', async () => {
    const agents = await rpcCall<unknown[]>(
      rpcPayload({ _tag: 'ListSocialAgents', lang: 'en', context: bobId }),
      bobCookie
    )
    expect(Array.isArray(agents)).toBe(true)
  })
})

describe('org context — owner identity (2.4)', () => {
  test('a role created in the org context lands in the org registry with the org as owner', async () => {
    const role = await rpcCall<{ id: string; label: string; members: string[] }>(
      rpcPayload({
        _tag: 'CreateRole',
        label: 'YoYo Ops',
        members: [],
        context: yoyoId,
      }),
      danCookie
    )
    expect(role.id).toMatch(/^https:\/\/registry\/yoyo\/[0-9a-f-]{36}$/u)
    // activity-first (step 9): the role is PUT by the createRole workflow —
    // wait for the completion before reading it back
    const manager = buildSessionManager()
    const yoyoSession = await manager.getSession(yoyoId)
    await waitForRoleCreatedCompletion(yoyoSession)
    const found = await yoyoSession.findRole(role.id)
    expect(found).toBeDefined()
    // the stored label is a language map — the untagged value under `@none`
    expect(found!.label).toEqual({ '@none': 'YoYo Ops' })
  })
})

/** YoYo's profile of an agent in the org context — the marker is linked by the workflow, so poll. */
async function orgContextAdminFlag(webId: string, cookie: string): Promise<boolean | undefined> {
  const agents = await rpcCall<{ id: string; admin: boolean }[]>(
    rpcPayload({ _tag: 'ListSocialAgents', lang: 'en', context: yoyoId }),
    cookie
  )
  return agents.find((agent) => agent.id === webId)?.admin
}

describe('org context — admin gating + last-admin guard (2.2/2.4)', () => {
  test('AddAdmin/RemoveAdmin only succeed for admins of the context org', async () => {
    // non-admin caller is rejected before any mutation
    await expectRpcError(rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }), bobCookie)

    // Dan (admin of YoYo) promotes Bob — activity-first (step 5): the RPC
    // pre-mints the AdminAuthorization id + writes the activity only; the
    // hasAdminGrant marker lands via the workflow
    const promoted = await rpcCall<{ id: string; activityId: string }>(
      rpcPayload({ _tag: 'AddAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    expect(promoted.activityId).toEqual(expect.any(String))
    await waitFor(async () => (await orgContextAdminFlag(bobId, danCookie)) === true, {
      timeout: 20_000,
    })

    // ...and demotes him again (activity-first step 6: the ack echoes the
    // revoked AdminAuthorization id + the activity id; the workflow DELETEs
    // the resource, revokes grants + the ACR rewrite)
    const demoted = await rpcCall<{ id: string; activityId: string }>(
      rpcPayload({ _tag: 'RemoveAdmin', webId: bobId, context: yoyoId }),
      danCookie
    )
    expect(demoted.id).toMatch(/^https:\/\/registry\/yoyo\/[0-9a-f-]{36}$/u)
    expect(demoted.activityId).toEqual(expect.any(String))
    await waitFor(async () => (await orgContextAdminFlag(bobId, danCookie)) === false, {
      timeout: 20_000,
    })
  })

  test('the last admin cannot be removed', async () => {
    await expectRpcError(
      rpcPayload({ _tag: 'RemoveAdmin', webId: danId, context: yoyoId }),
      danCookie
    )
  })
})

/**
 * Peer-data read plane: the admin's UAS obtains a read-only ID-JAG **as the
 * org** for one peer storage (`SessionManager.impersonationFetch`), so the peer
 * sees the org and only `odrl:read`. The registry plane stays on
 * `/.sai/sparql-admin`. There is no document-proxy endpoint anymore.
 *
 * Seed (environments/data/registry.trig): Bob granted YoYo an access grant
 * (`registry/bob/t2v9cd`, AllFromRegistry over
 * `data/bob/avn9hv/` — instances `n3onkx`/"Neon" and `gl1tch`/"Glitch"),
 * linked from Bob's registration of YoYo (`n4m8qx`) — the reciprocal of
 * YoYo's registration of Bob (`z3k7wm`).
 */
describe('org context — peers’ granted data (read-only org impersonation)', () => {
  const bobDataRegistration = 'https://data/bob/avn9hv'
  const bobNeon = 'https://data/bob/n3onkx'
  const bobGlitch = 'https://data/bob/gl1tch'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const taskShapeTree = 'https://data/shapetrees/trees/Task'

  test('ListDataRegistries (peer branch) lists the peer registration the org is granted', async () => {
    const registries = await rpcCall<{ id: string; registrations: { id: string }[] }[]>(
      rpcPayload({ _tag: 'ListDataRegistries', agentId: bobId, lang: 'en', context: yoyoId }),
      danCookie
    )
    const bobRegistry = registries.find((registry) => registry.id === 'https://data/bob/')
    expect(bobRegistry).toBeDefined()
    expect(bobRegistry!.registrations.map((registration) => registration.id)).toContain(
      bobDataRegistration
    )
  })

  test('ListDataInstances on the peer’s granted registration lists the instances (labels)', async () => {
    const instances = await rpcCall<{ id: string; label?: string }[]>(
      rpcPayload({
        _tag: 'ListDataInstances',
        agentId: bobId,
        registrationId: bobDataRegistration,
        context: yoyoId,
      }),
      danCookie
    )
    expect(instances).toHaveLength(2)
    expect(instances.map((instance) => instance.id)).toEqual(
      expect.arrayContaining([bobGlitch, bobNeon])
    )
    expect(instances.find((instance) => instance.id === bobNeon)?.label).toBe('Neon')
    expect(instances.find((instance) => instance.id === bobGlitch)?.label).toBe('Glitch')
  })

  test('GetResource on the peer-granted instance returns the full body', async () => {
    const resource = await rpcCall<{
      id: string
      label?: string
      shapeTree: { id: string }
      accessGrantedTo: string[]
      accessGrantedViaRoles: { role: string; label: string; members: string[] }[]
      children: { shapeTree: { id: string }; count: number }[]
    }>(rpcPayload({ _tag: 'GetResource', id: bobNeon, lang: 'en', context: yoyoId }), danCookie)
    expect(resource.id).toBe(bobNeon)
    expect(resource.label).toBe('Neon')
    expect(resource.shapeTree.id).toBe(projectShapeTree)
    // the org recorded no authorizations over Bob's data → empty access lists
    expect(resource.accessGrantedTo).toEqual([])
    expect(resource.accessGrantedViaRoles).toEqual([])
    // Project references several shape trees (Image, Task, …) — find by id
    const taskChild = resource.children.find((child) => child.shapeTree.id === taskShapeTree)
    expect(taskChild?.count).toBe(2)
  })
})

/**
 * The org context's WRITE path (org-admin-feature.md §2.4): an admin shares one
 * of the ORG's own data instances with a peer.
 *
 * The org's data pods sit outside the admin's session allowlist (isolation), so
 * the share build must read the instance's registration (from `lws:partOf`),
 * the child registrations and the existing access through `/sparql-admin`.
 * The RPC builds as the CONTEXT owner: the materialized DataAuthorization and
 * the generated grants must belong to the org, not to the signed-in admin.
 *
 * Seed: YoYo's registration of Bob (`z3k7wm`) exists, but the seeded project
 * authorization (`k2m5qp`) covers `data/yoyo-eu/w4n9kx` only — Bob holds
 * nothing over `data/yoyo-na/`, so he is a fresh grantee here.
 */
describe('org context — sharing the org’s own data (2.4 write path)', () => {
  const yoyoRegistrationOfBob = 'https://registry/yoyo/z3k7wm'
  const yoyoAuthorizationRegistry = 'https://registry/yoyo/authorization/'
  const applicationId = 'https://data/test-client/public/id'
  const ghost = 'https://data/yoyo-na/q7p2lm' // Project "Ghost"
  const projectRegistration = 'https://data/yoyo-na/k9m4wx'
  const taskRegistration = 'https://data/yoyo-na/p3n7vz'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const taskShapeTree = 'https://data/shapetrees/trees/Task'
  const readMode = 'http://www.w3.org/ns/odrl/2/read'

  test('an admin shares an org instance; the authorization and grants belong to the org', async () => {
    // previous tests in this file leave workflow tails behind (their markers
    // land mid-chain) — settle before opening the notification barrier below,
    // so its Update can not be a leftover
    await waitForQuiescence([yoyoId, bobId])

    const manager = buildSessionManager()
    const yoyoSession = await manager.getSession(yoyoId)
    const regForBob = (await yoyoSession.findSocialAgentRegistration(bobId))!
    expect(regForBob.id).toBe(yoyoRegistrationOfBob)

    // the registration Update + the workflow tail are the completion signal
    await awaitGrantCompletion(yoyoSession.fetch, regForBob.id, [yoyoId, bobId], async () => {
      const response = await fetch(rpcEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: danCookie,
        },
        body: JSON.stringify(
          rpcPayload({
            _tag: 'ShareResource',
            authorization: {
              applicationId,
              resource: ghost,
              agents: [bobId],
              accessMode: [readMode],
              // a child need forces the child-registration read on the org's
              // data pod (the pre-fix path guessed it from the instance URI)
              children: [{ shapeTree: taskShapeTree, accessMode: [readMode] }],
            },
            context: yoyoId,
          })
        ),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      const { _tag, value } = body[0]
      expect(_tag).toBe('Success')
      expect(value).toEqual(expect.objectContaining({ callbackEndpoint: 'https://test-client' }))
    })

    // the DataAuthorization in the ORG's authorization registry: the context
    // owner is grantor and data owner (the session is only the admin), and the
    // registration came from the org data pod's `lws:partOf`
    const transport = localSparqlTransport(yoyoSession.sparqlEndpoint)
    const authorizationIris = await listContained(transport, yoyoAuthorizationRegistry)
    const authorizations = await Promise.all(
      authorizationIris.map((iri) => getDataAuthorization(transport, iri))
    )
    const shared = authorizations.find(
      (authorization) =>
        authorization.grantee === bobId && (authorization.hasDataInstance ?? []).includes(ghost)
    )
    expect(shared).toBeDefined()
    expect(shared!.dataOwner).toBe(yoyoId)
    expect(shared!.grantedBy).toBe(yoyoId)
    expect(shared!.registeredShapeTree).toBe(projectShapeTree)
    expect(shared!.hasDataRegistration).toBe(projectRegistration)
    expect(shared!.scopeOfAuthorization).toBe(INTEROP.SelectedFromRegistry)

    // the child (Inherited) authorization: its registration is the org's Task
    // registration — read through the context plane, not guessed from a path
    const child = authorizations.find(
      (authorization) => authorization.inheritsFromAuthorization === shared!.id
    )
    expect(child).toBeDefined()
    expect(child!.registeredShapeTree).toBe(taskShapeTree)
    expect(child!.hasDataRegistration).toBe(taskRegistration)
    expect(child!.scopeOfAuthorization).toBe(INTEROP.Inherited)

    // the grants: bodies in the ORG's grant registry, linked from the org's
    // registration of Bob. `dataOwner === yoyo` is the decisive assertion — a
    // build as the admin would route grant generation down the delegated path
    const linked = (await yoyoSession.findSocialAgentRegistration(bobId))!
    const grants = await accessGrants(linked, yoyoSession)
    const sharedGrant = grants.find(
      (grant) =>
        grant.registeredShapeTree === projectShapeTree &&
        grantGrantee(grant) === bobId &&
        grant.hasDataInstance?.includes(ghost)
    )
    expect(sharedGrant).toBeDefined()
    expect(sharedGrant!.dataOwner).toBe(yoyoId)
    expect(sharedGrant!.grantedBy).toBe(yoyoId)
    expect(sharedGrant!.scopeOfGrant).toBe(INTEROP.SelectedFromRegistry)
    expect(grantAccessModes(sharedGrant!)).toEqual([readMode])

    // the read side agrees: the org context reports the peer as a DIRECT
    // grantee (the grantee-facing replication of these grants is covered by
    // federation-mirror)
    const access = await rpcCall<{ accessGrantedTo: string[] }>(
      rpcPayload({ _tag: 'GetResource', id: ghost, lang: 'en', context: yoyoId }),
      danCookie
    )
    expect(access.accessGrantedTo).toContain(bobId)
  })
})

/**
 * org-admin-feature.md §2.4 — the org context's OWN data plane. Membership is
 * read through `/.sai/sparql-admin/<org>?pod=<pod>`; the instance content via
 * the admin's own credential, which the org's storage exchange turns into the
 * read-only `scope: admin` (an org session there would be `scope: owner`).
 *
 * The first version of this check is what surfaced the `?pod=` handler bug
 * (every data-pod query used to run against the org's REGISTRY dataset) — see
 * the share check above.
 */
describe('org context — listing the org’s own data (2.4 data plane)', () => {
  const yoyoEu = 'https://data/yoyo-eu/'
  const yoyoNa = 'https://data/yoyo-na/'
  const projectRegistration = 'https://data/yoyo-na/k9m4wx'
  const taskRegistration = 'https://data/yoyo-na/p3n7vz'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const taskShapeTree = 'https://data/shapetrees/trees/Task'
  const ghost = 'https://data/yoyo-na/q7p2lm'
  const cipher = 'https://data/yoyo-na/w5x8kr'

  test('ListDataRegistries resolves the org’s own pods and their registrations', async () => {
    const registries = await rpcCall<
      {
        id: string
        label: string
        registrations: { id: string; shapeTree: string; count: number }[]
      }[]
    >(
      rpcPayload({ _tag: 'ListDataRegistries', agentId: yoyoId, lang: 'en', context: yoyoId }),
      danCookie
    )
    // both org pods — the registry set's `hasDataRegistry`
    expect(registries.map((registry) => registry.id).toSorted()).toEqual(
      [yoyoEu, yoyoNa].toSorted()
    )

    const na = registries.find((registry) => registry.id === yoyoNa)!
    expect(na.registrations.map((registration) => registration.id).toSorted()).toEqual(
      [projectRegistration, taskRegistration].toSorted()
    )
    const project = na.registrations.find(
      (registration) => registration.id === projectRegistration
    )!
    expect(project.shapeTree).toBe(projectShapeTree)
    // Ghost + Cipher live in the project registration
    expect(project.count).toBe(2)
    expect(
      na.registrations.find((registration) => registration.id === taskRegistration)!.shapeTree
    ).toBe(taskShapeTree)
  })

  test('ListDataInstances reads the org registration’s membership and labels', async () => {
    const instances = await rpcCall<{ id: string; label?: string }[]>(
      rpcPayload({
        _tag: 'ListDataInstances',
        agentId: yoyoId,
        registrationId: projectRegistration,
        context: yoyoId,
      }),
      danCookie
    )
    expect(instances.map((instance) => instance.id).toSorted()).toEqual([ghost, cipher].toSorted())
    expect(instances.find((instance) => instance.id === ghost)?.label).toBe('Ghost')
    expect(instances.find((instance) => instance.id === cipher)?.label).toBe('Cipher')
  })
})

/**
 * The OTHER DataAuthorization producer in the org context (`AuthorizeApp` —
 * the app/invitation flow, as opposed to the share build): the DAs are built
 * from the request payload, so the read side is not the risk here — the write
 * side is: the pre-minted ids, the stored authorization and the generated
 * grants must all belong to the ORG (the context owner), not the admin.
 *
 * Seed: Bob holds nothing over `data/yoyo-na/k9m4wx`, so the AllFromRegistry
 * authorization is a fresh one; the Task need inherits from the Project need.
 */
describe('org context — authorizing an agent over the org’s data (2.4 write path)', () => {
  const projectRegistration = 'https://data/yoyo-na/k9m4wx'
  const projectShapeTree = 'https://data/shapetrees/trees/Project'
  const taskShapeTree = 'https://data/shapetrees/trees/Task'
  const accessNeedGroup = 'https://data/test-client/public/access-needs#need-group-pm'
  const projectNeed = 'https://data/test-client/public/access-needs#need-project'
  const taskNeed = 'https://data/test-client/public/access-needs#need-task'
  const readMode = 'http://www.w3.org/ns/odrl/2/read'

  test('the authorization and the grants belong to the org', async () => {
    await waitForQuiescence([yoyoId, bobId])

    const manager = buildSessionManager()
    const yoyoSession = await manager.getSession(yoyoId)
    const regForBob = (await yoyoSession.findSocialAgentRegistration(bobId))!
    expect(regForBob).toBeDefined()

    let ids: string[] = []
    await awaitGrantCompletion(yoyoSession.fetch, regForBob.id, [yoyoId, bobId], async () => {
      const body = await rpcCall<{ activityId: string; ids: string[] }>(
        rpcPayload({
          _tag: 'AuthorizeApp',
          authorization: {
            grantee: bobId,
            accessNeedGroup,
            dataAuthorizations: [
              {
                accessNeed: projectNeed,
                scope: 'AllFromRegistry',
                dataRegistration: projectRegistration,
              },
              { accessNeed: taskNeed, scope: 'Inherited' },
            ],
            granted: true,
          },
          context: yoyoId,
        }),
        danCookie
      )
      // activity-first: pending ack with the pre-minted DA ids + the activity
      expect(body.activityId).toEqual(expect.any(String))
      expect(body.ids.length).toBe(2)
      ids = body.ids
    })

    // the materialized DataAuthorizations — the ORG is the grantor
    const transport = localSparqlTransport(yoyoSession.sparqlEndpoint)
    const authorizations = await Promise.all(ids.map((id) => getDataAuthorization(transport, id)))
    const parent = authorizations.find(
      (authorization) => authorization.scopeOfAuthorization === INTEROP.AllFromRegistry
    )
    expect(parent).toBeDefined()
    expect(parent!.grantee).toBe(bobId)
    expect(parent!.grantedBy).toBe(yoyoId)
    expect(parent!.registeredShapeTree).toBe(projectShapeTree)
    expect(parent!.hasDataRegistration).toBe(projectRegistration)
    expect(parent!.accessMode).toContain(readMode)

    const child = authorizations.find(
      (authorization) => authorization.scopeOfAuthorization === INTEROP.Inherited
    )
    expect(child).toBeDefined()
    expect(child!.registeredShapeTree).toBe(taskShapeTree)
    expect(child!.inheritsFromAuthorization).toBe(parent!.id)

    // the grants: the org is the data owner, Bob the grantee
    const linked = (await yoyoSession.findSocialAgentRegistration(bobId))!
    const grants = await accessGrants(linked, yoyoSession)
    const projectGrant = grants.find(
      (grant) =>
        grantGrantee(grant) === bobId &&
        grant.hasDataRegistration === projectRegistration &&
        grant.scopeOfGrant === INTEROP.AllFromRegistry
    )
    expect(projectGrant).toBeDefined()
    expect(projectGrant!.dataOwner).toBe(yoyoId)
    expect(projectGrant!.grantedBy).toBe(yoyoId)
    expect(grantAccessModes(projectGrant!)).toContain(readMode)
  })
})
