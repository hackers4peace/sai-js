import { INTEROP, LWS, ODRL, RDF } from '@janeirodigital/interop-utils'
import { LwsExchangeAccessDeniedError } from '@solid/community-server'
import { DataFactory, Store } from 'n3'
import { describe, expect, test, vi } from 'vitest'

import { StorageExchangeAccessPolicy } from '../src/StorageExchangeAccessPolicy.js'

const { namedNode } = DataFactory

const STORAGE = 'https://data/yoyo-eu/'
const ALICE = 'https://id/alice'
const DAN = 'https://id/dan'
const UAS = 'https://auth/.sai/agents/agent'
const CLIENT = 'https://data/test-client/public/id'

function adminGrant(assignee = DAN): Store {
  const grant = namedNode('https://registry/yoyo/admin-grant')
  const policy = namedNode('urn:policy')
  const permission = namedNode('urn:permission')
  const store = new Store()
  store.addQuad(grant, namedNode(RDF.type), namedNode(INTEROP.AdminGrant))
  store.addQuad(grant, namedNode(INTEROP.scopeOfAdminGrant), namedNode(INTEROP.DataRegistry))
  store.addQuad(grant, namedNode(LWS.access), policy)
  store.addQuad(policy, namedNode(ODRL.permission), permission)
  store.addQuad(permission, namedNode(ODRL.assignee), namedNode(assignee))
  return store
}

class TestPolicy extends StorageExchangeAccessPolicy {
  public agent?: string

  protected async discoverAgent(): Promise<string | undefined> {
    return this.agent
  }
}

function createPolicy(
  options: {
    owners?: string[]
    subject?: string
    data?: Store
    agent?: string
  } = {}
) {
  const podStore = {
    findByBaseUrl: vi.fn(async () => ({ id: 'pod' })),
    getOwners: vi.fn(async () => (options.owners ?? []).map((webId) => ({ webId }))),
  }
  const storageStrategy = {
    getStorageIdentifier: vi.fn(async () => ({ path: STORAGE })),
  }
  const manager = {
    getAuthorizationData: vi.fn(async () => options.data),
  }
  const policy = new TestPolicy(podStore as never, storageStrategy as never, manager as never)
  policy.agent = options.agent
  return { policy, podStore, manager }
}

describe('StorageExchangeAccessPolicy', () => {
  test('mints the owner scope for the storage owner using their own UAS', async () => {
    const { policy, manager } = createPolicy({ owners: [ALICE], agent: UAS })
    await expect(
      policy.determineScope({
        subject: ALICE,
        client: UAS,
        issuer: 'https://auth/',
        resource: STORAGE,
      })
    ).resolves.toEqual(['owner'])
    expect(manager.getAuthorizationData).not.toHaveBeenCalled()
  })

  test('does not widen the owner exception to an app client', async () => {
    const { policy } = createPolicy({ owners: [ALICE], agent: UAS })
    await expect(
      policy.determineScope({
        subject: ALICE,
        client: CLIENT,
        issuer: 'https://auth/',
        resource: STORAGE,
      })
    ).rejects.toBeInstanceOf(LwsExchangeAccessDeniedError)
  })

  test('mints the read-only admin scope for a DataRegistry AdminGrant holder', async () => {
    const { policy } = createPolicy({ data: adminGrant(), agent: UAS })
    await expect(
      policy.determineScope({
        subject: DAN,
        client: UAS,
        issuer: 'https://auth/',
        resource: STORAGE,
      })
    ).resolves.toEqual(['admin'])
  })

  test('rejects an admin using a non-UAS client', async () => {
    const { policy } = createPolicy({ data: adminGrant(), agent: UAS })
    await expect(
      policy.determineScope({
        subject: DAN,
        client: CLIENT,
        issuer: 'https://auth/',
        resource: STORAGE,
      })
    ).rejects.toBeInstanceOf(LwsExchangeAccessDeniedError)
  })

  test('rejects a claimless exchange with no owner or admin authority', async () => {
    const { policy } = createPolicy({ agent: UAS })
    await expect(
      policy.determineScope({
        subject: ALICE,
        client: UAS,
        issuer: 'https://auth/',
        resource: STORAGE,
      })
    ).rejects.toBeInstanceOf(LwsExchangeAccessDeniedError)
  })
})
