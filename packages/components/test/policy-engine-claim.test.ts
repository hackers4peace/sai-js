import { grantAccess } from '@janeirodigital/interop-data-model'
import { INTEROP, ODRL, ODRL_ID_JAG_CONTEXT } from '@janeirodigital/interop-utils'
import type { Credentials } from '@solidlab/policy-engine'
import { PERMISSIONS } from '@solidlab/policy-engine'
import { describe, expect, test, vi } from 'vitest'

import { SaiPermissionsEngine } from '../src/SaiPermissionsEngine.js'

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
    getParent: vi.fn(async () => REGISTRATION),
  }
  const storageStrategy = {
    getStorageIdentifier: vi.fn(async () => ({ path: STORAGE })),
  }
  const endpointStore = {
    findSparqlByPodUrl: vi.fn(async () => undefined),
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
    expect(permissions[PERMISSIONS.Create]).toBe(false)
    expect(permissions[PERMISSIONS.Modify]).toBe(false)
    expect(permissions[PERMISSIONS.Delete]).toBe(false)
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
    expect(permissions[PERMISSIONS.Modify]).toBe(false)
  })

  test('denies a token claim for another storage without falling back', async () => {
    const { engine, manager } = createEngine()
    const permissions = await engine.getPermissions(
      RESOURCE,
      credentials(claim(INTEROP.AllFromRegistry, OTHER_STORAGE))
    )

    expect(permissions[PERMISSIONS.Read]).toBe(false)
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('denies an unparseable claim or an unknown context without broad matching', async () => {
    const { engine, manager } = createEngine()

    for (const access of ['not-a-claim', [{ id: 'urn:broken' }]]) {
      const permissions = await engine.getPermissions(RESOURCE, credentials(access))
      expect(permissions[PERMISSIONS.Read]).toBe(false)
    }

    const permissions = await engine.getPermissions(
      RESOURCE,
      credentials(claim(INTEROP.AllFromRegistry), {
        accessContext: 'https://context.example/unknown',
      })
    )
    expect(permissions[PERMISSIONS.Read]).toBe(false)
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
})
