import { grantAccess } from '@janeirodigital/interop-data-model'
import { INTEROP, LWS, ODRL, ODRL_ID_JAG_CONTEXT, toStore } from '@janeirodigital/interop-utils'
import type { Quad } from '@rdfjs/types'
import type { Credentials } from '@solidlab/policy-engine'
import { ACP, PERMISSIONS } from '@solidlab/policy-engine'
import { DataFactory, Store } from 'n3'
import { describe, expect, test, vi } from 'vitest'

const sparqlMock: { parent?: string } = { parent: 'https://data/acme.example/registration/' }

vi.mock('fetch-sparql-endpoint', async () => {
  const { Readable } = await import('node:stream')
  return {
    SparqlEndpointFetcher: class {
      async fetchBindings(_endpoint: string, query: string) {
        if (query.includes('lws#partOf')) {
          return Readable.from(sparqlMock.parent ? [{ parent: { value: sparqlMock.parent } }] : [])
        }
        return Readable.from([])
      }
    },
  }
})

import { SaiPermissionsEngine } from '../src/SaiPermissionsEngine.js'

const { namedNode } = DataFactory

const STORAGE = 'https://data/acme.example/'
const OTHER_STORAGE = 'https://data/other.example/'
const REGISTRATION = 'https://data/acme.example/registration/'
const RESOURCE = 'https://data/acme.example/project'
const SHAPE_TREE = 'https://data/shape/trees/Project'
const ALICE = 'https://id/alice'
const CLIENT = 'https://data/test-client/public/id'
const READ = ODRL.read

function withoutAssigner(policies: any[]): any[] {
  return policies.map((policy) => {
    const { assigner: _policyAssigner, ...rest } = policy
    return {
      ...rest,
      permission: policy.permission.map((permission: any) => {
        const { assigner: _permissionAssigner, ...permissionRest } = permission
        return permissionRest
      }),
    }
  })
}

function claim(scope: string, storage = STORAGE, registration = REGISTRATION) {
  return withoutAssigner(
    grantAccess({
      scopeOfGrant: scope,
      owner: ALICE,
      storage,
      hasDataRegistration: registration,
      hasDataInstance: scope === INTEROP.SelectedFromRegistry ? [RESOURCE] : undefined,
      registeredShapeTree: SHAPE_TREE,
      assigner: ALICE,
      assignee: ALICE,
      actions: [READ],
    })
  )
}

function createEngine() {
  const manager = {
    // The claim-first branch must never read the grant registry.
    getAuthorizationData: vi.fn(async () => {
      throw new Error('registry read')
    }),
    getStorage: vi.fn(async () => STORAGE),
  }
  const storageStrategy = {
    getStorageIdentifier: vi.fn(async () => ({ path: STORAGE })),
  }
  const endpointStore = {
    findSparqlByPodUrl: vi.fn(async () => ({ endpoint: 'https://data.example/sparql' })),
  }
  const engine = new SaiPermissionsEngine(
    manager as never,
    storageStrategy as never,
    endpointStore as never
  )
  return { engine, manager }
}

function credentials(access: unknown, overrides: Record<string, unknown> = {}) {
  return {
    agent: ALICE,
    client: CLIENT,
    access,
    accessContext: ODRL_ID_JAG_CONTEXT,
    storage: STORAGE,
    ...overrides,
  } as Credentials
}

describe('claim-first policy evaluation', () => {
  test('grants a resource through an AllFromRegistry claim without reading the registry', async () => {
    const { engine, manager } = createEngine()
    const permissions = await engine.getPermissions(
      RESOURCE,
      credentials(claim(INTEROP.AllFromRegistry))
    )

    expect(permissions[PERMISSIONS.Read]).toBe(true)
    expect(permissions[PERMISSIONS.Create]).toBeFalsy()
    expect(permissions[PERMISSIONS.Modify]).toBeFalsy()
    expect(permissions[PERMISSIONS.Delete]).toBeFalsy()
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('grants a selected resource through a SelectedFromRegistry claim', async () => {
    const { engine } = createEngine()
    const permissions = await engine.getPermissions(
      RESOURCE,
      credentials(claim(INTEROP.SelectedFromRegistry))
    )
    expect(permissions[PERMISSIONS.Read]).toBe(true)
  })

  test('maps a claim-internal parent link to the synthetic parent root', async () => {
    const { engine } = createEngine()
    const parent = claim(INTEROP.AllFromRegistry)
    parent[0].id = 'urn:uuid:claim-parent'
    parent[0].uid = parent[0].id
    const child = claim(INTEROP.Inherited, STORAGE, 'https://data/acme.example/task-reg/')
    child[0].id = 'urn:uuid:claim-child'
    child[0].uid = child[0].id
    child[0].inheritsFromGrant = parent[0].id

    const data = await (
      engine as unknown as {
        findAccessClaimData(target: string, credentials: Credentials): Promise<Quad[] | undefined>
      }
    ).findAccessClaimData(RESOURCE, credentials([...parent, ...child]))
    const store = new Store(data ?? [])
    const roots = [...store.getSubjects(namedNode(LWS.access), null, null)]
    const childRoot = roots.find((root) =>
      store
        .getObjects(root, namedNode(LWS.access), null)
        .some((policy) => policy.value === child[0].id)
    )
    const parentRoot = roots.find((root) =>
      store
        .getObjects(root, namedNode(LWS.access), null)
        .some((policy) => policy.value === parent[0].id)
    )
    expect(parentRoot).toBeDefined()
    expect(childRoot).toBeDefined()
    expect(store.getObjects(childRoot!, namedNode(INTEROP.inheritsFromGrant), null)[0]?.value).toBe(
      parentRoot!.value
    )
  })

  test('evaluates each policy of a multi-policy claim independently', async () => {
    const { engine } = createEngine()
    const OTHER_REGISTRATION = 'https://data/acme.example/other-registration/'
    const policies = [
      ...claim(INTEROP.AllFromRegistry),
      ...claim(INTEROP.AllFromRegistry, STORAGE, OTHER_REGISTRATION).map((policy) => ({
        ...policy,
        permission: policy.permission.map((permission) => ({
          ...permission,
          action: [ODRL.modify],
        })),
      })),
    ]
    const permissions = await engine.getPermissions(RESOURCE, credentials(policies))

    expect(permissions[PERMISSIONS.Read]).toBe(true)
    // The matching AllFromRegistry policy only carries Read; a shared
    // synthetic grant root would leak the other registration's Modify.
    expect(permissions[PERMISSIONS.Modify]).toBeFalsy()
  })

  test('denies a token claim for another storage without falling back', async () => {
    const { engine, manager } = createEngine()
    const permissions = await engine.getPermissions(
      RESOURCE,
      credentials(claim(INTEROP.AllFromRegistry, OTHER_STORAGE))
    )

    expect(permissions[PERMISSIONS.Read]).toBeFalsy()
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('denies an unparseable claim or an unknown context without broad matching', async () => {
    const { engine, manager } = createEngine()

    for (const access of ['not-a-claim', [{ id: 'urn:broken' }]]) {
      const permissions = await engine.getPermissions(RESOURCE, credentials(access))
      expect(permissions[PERMISSIONS.Read]).toBeFalsy()
    }

    const permissions = await engine.getPermissions(
      RESOURCE,
      credentials(claim(INTEROP.AllFromRegistry), {
        accessContext: 'https://context.example/unknown',
      })
    )
    expect(permissions[PERMISSIONS.Read]).toBeFalsy()
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('grants all modes for an owner scope without reading the registry', async () => {
    const { engine, manager } = createEngine()
    const permissions = await engine.getPermissions(RESOURCE, {
      agent: ALICE,
      client: CLIENT,
      scope: ['owner'],
    } as Credentials)

    expect(permissions).toEqual({
      [PERMISSIONS.Create]: true,
      [PERMISSIONS.Append]: true,
      [PERMISSIONS.Read]: true,
      [PERMISSIONS.Modify]: true,
      [PERMISSIONS.Delete]: true,
    })
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('grants read only for an admin scope', async () => {
    const { engine, manager } = createEngine()
    const permissions = await engine.getPermissions(RESOURCE, {
      agent: ALICE,
      client: CLIENT,
      scope: ['admin'],
    } as Credentials)

    expect(permissions[PERMISSIONS.Read]).toBe(true)
    expect(permissions[PERMISSIONS.Create]).toBeFalsy()
    expect(permissions[PERMISSIONS.Modify]).toBeFalsy()
    expect(permissions[PERMISSIONS.Delete]).toBeFalsy()
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('denies a claimless, scopeless token without registry fallback', async () => {
    const { engine, manager } = createEngine()
    const permissions = await engine.getPermissions(RESOURCE, {
      agent: ALICE,
      client: CLIENT,
    } as Credentials)

    expect(permissions[PERMISSIONS.Read]).toBeFalsy()
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('ignores identity fields in an AS-issued claim', async () => {
    const { engine } = createEngine()
    // The token endpoint already bound the claim to the subject; the engine
    // evaluates only target/action.
    const other = withoutAssigner(
      grantAccess({
        scopeOfGrant: INTEROP.AllFromRegistry,
        owner: ALICE,
        storage: STORAGE,
        hasDataRegistration: REGISTRATION,
        registeredShapeTree: SHAPE_TREE,
        assigner: ALICE,
        assignee: 'https://id/mallory',
        actions: [READ],
      })
    )
    const permissions = await engine.getPermissions(RESOURCE, credentials(other))
    expect(permissions[PERMISSIONS.Read]).toBe(true)
  })

  test('denies when the data pod has no lws:partOf metadata (no path fallback)', async () => {
    const { engine } = createEngine()
    sparqlMock.parent = undefined
    try {
      const permissions = await engine.getPermissions(
        RESOURCE,
        credentials(claim(INTEROP.AllFromRegistry))
      )
      expect(permissions[PERMISSIONS.Read]).toBeFalsy()
    } finally {
      sparqlMock.parent = REGISTRATION
    }
  })
})

describe('public grants', () => {
  async function publicEngine() {
    const publicGrant = grantAccess({
      scopeOfGrant: INTEROP.AllFromRegistry,
      owner: ALICE,
      storage: STORAGE,
      hasDataRegistration: REGISTRATION,
      registeredShapeTree: SHAPE_TREE,
      assigner: ACP.PublicAgent,
      assignee: ACP.PublicClient,
      actions: [READ],
    })
    const store = await toStore({ '@context': ODRL_ID_JAG_CONTEXT, '@graph': publicGrant })
    store.addQuad(
      namedNode('https://registry/alice/public-grant'),
      namedNode(LWS.access),
      namedNode(publicGrant[0].uid)
    )
    const quads = [...store]
    const manager = {
      getAuthorizationData: vi.fn(async () => quads),
      getStorage: vi.fn(async () => STORAGE),
    }
    const storageStrategy = {
      getStorageIdentifier: vi.fn(async () => ({ path: STORAGE })),
    }
    const endpointStore = {
      findSparqlByPodUrl: vi.fn(async () => ({ endpoint: 'https://data.example/sparql' })),
    }
    const engine = new SaiPermissionsEngine(
      manager as never,
      storageStrategy as never,
      endpointStore as never
    )
    return { engine, manager }
  }

  test('grants read without any credentials', async () => {
    const { engine } = await publicEngine()
    const permissions = await engine.getPublicPermissions(RESOURCE)
    expect(permissions[PERMISSIONS.Read]).toBe(true)
    expect(permissions[PERMISSIONS.Modify]).toBeFalsy()
  })

  test('does not use public grants as a token fallback', async () => {
    const { engine } = await publicEngine()
    const permissions = await engine.getPermissions(RESOURCE, {
      agent: ALICE,
      client: 'https://id/mallory',
    } as Credentials)
    expect(permissions[PERMISSIONS.Read]).toBeFalsy()
  })
})
