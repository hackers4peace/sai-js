import { grantAccess } from '@janeirodigital/interop-data-model'
import { CONTEXT, INTEROP, ODRL } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { DelegatedAccessClaimValidator } from '../src/DelegatedAccessClaimValidator.js'
import { grantFromPolicy } from '../src/grant-policy.js'

const BOB = 'https://id/bob'
const CLIENT = 'https://data/test-client/public/id'
const ACME = 'https://id/acme'
const YOYO = 'https://id/yoyo'
const STORAGE = 'https://data/acme-rnd/'
const PROJECTS = 'https://data/acme-rnd/reb39k'
const TASKS = 'https://data/acme-rnd/x0md9s'
const PROJECT_X = 'https://data/acme-rnd/pbh2yw'
const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'

const registry = vi.hoisted(() => ({ grants: new Map<string, unknown>() }))

vi.mock('@janeirodigital/interop-authorization-agent', () => ({
  localSparqlTransport: () => ({}),
  getRegistryGrants: async () => [],
  getAccessGrantsForGrantee: async () => [...registry.grants.keys()].map((grant) => ({ grant })),
  getAccessGrant: async (_transport: unknown, id: string) => {
    const grant = registry.grants.get(id)
    if (!grant) {
      throw new Error(`unknown grant ${id}`)
    }
    return grant
  },
}))

vi.mock('../src/builders/sessionManager.js', () => ({
  buildSessionManager: () => ({
    getSession: async () => ({ sparqlEndpoint: 'http://fuseki/test' }),
  }),
}))

interface GrantOptions {
  assigner: string
  scopeOfGrant: string
  registration: string
  shapeTree: string
  instance?: string
}

/** One visible grant, in the shape `getAccessGrantsForGrantee` resolves. */
function addGrant(id: string, options: GrantOptions) {
  const [policy] = grantAccess({
    scopeOfGrant: options.scopeOfGrant,
    owner: ACME,
    storage: STORAGE,
    hasDataRegistration: options.registration,
    registeredShapeTree: options.shapeTree,
    assigner: options.assigner,
    assignee: BOB,
    actions: [ODRL.read],
    ...(options.instance ? { hasDataInstance: [options.instance] } : {}),
  })
  const grant = grantFromPolicy(policy, id, options.scopeOfGrant)
  registry.grants.set(id, grant)
  return grant
}

type ClaimPolicy = {
  scopeOfGrant: string
  permission: Array<{ target: { source: Array<string> } }>
}

function policiesOf(claim: { access: Array<unknown> } | undefined): Array<ClaimPolicy> {
  return (claim?.access ?? []) as Array<ClaimPolicy>
}

function find(validator: DelegatedAccessClaimValidator, forStorage = true) {
  return validator.find({ subject: BOB, client: CLIENT, storage: STORAGE, forStorage })
}

function selectedByYoyo() {
  return addGrant('https://registry/yoyo/q7w2nz', {
    assigner: YOYO,
    scopeOfGrant: INTEROP.SelectedFromRegistry,
    registration: PROJECTS,
    shapeTree: PROJECT_TREE,
    instance: PROJECT_X,
  })
}

describe('DelegatedAccessClaimValidator edge selection', () => {
  beforeEach(() => registry.grants.clear())

  test('prefers a registration-level edge over a cross-assigner selected-instance edge for a storage ID-JAG', async () => {
    addGrant('https://registry/acme/p9m2vr', {
      assigner: ACME,
      scopeOfGrant: INTEROP.AllFromRegistry,
      registration: PROJECTS,
      shapeTree: PROJECT_TREE,
    })
    selectedByYoyo()

    const claim = await find(new DelegatedAccessClaimValidator())

    const policies = policiesOf(claim)
    expect(policies).toHaveLength(1)
    expect(policies[0].scopeOfGrant).toBe(CONTEXT.AllFromRegistry)
    expect(policies[0].permission[0].target.source).toEqual([PROJECTS])
  })

  test('keeps every grant of the chosen assigner edge', async () => {
    const all = addGrant('https://registry/acme/p9m2vr', {
      assigner: ACME,
      scopeOfGrant: INTEROP.AllFromRegistry,
      registration: PROJECTS,
      shapeTree: PROJECT_TREE,
    })
    const inherited = addGrant('https://registry/acme/hdaymz', {
      assigner: ACME,
      scopeOfGrant: INTEROP.Inherited,
      registration: TASKS,
      shapeTree: TASK_TREE,
    })
    inherited.inheritsFromGrant = all.id
    selectedByYoyo()

    const claim = await find(new DelegatedAccessClaimValidator())

    const policies = policiesOf(claim)
    expect(policies.map((policy) => policy.scopeOfGrant).toSorted()).toEqual(
      [CONTEXT.AllFromRegistry, CONTEXT.Inherited].toSorted()
    )
    expect(
      policies.flatMap((policy) =>
        policy.permission.flatMap((permission) => permission.target.source)
      )
    ).toEqual(expect.arrayContaining([PROJECTS, TASKS]))
  })

  test('falls back to a selected-instance edge when it is all the user has', async () => {
    selectedByYoyo()

    const claim = await find(new DelegatedAccessClaimValidator())

    const policies = policiesOf(claim)
    expect(policies).toHaveLength(1)
    expect(policies[0].scopeOfGrant).toBe(CONTEXT.SelectedFromRegistry)
    expect(policies[0].permission[0].target.source).toEqual([PROJECT_X])
  })

  test('keeps the narrowest delegated edge for a delegation-hop ID-JAG', async () => {
    addGrant('https://registry/acme/p9m2vr', {
      assigner: ACME,
      scopeOfGrant: INTEROP.AllFromRegistry,
      registration: PROJECTS,
      shapeTree: PROJECT_TREE,
    })
    selectedByYoyo()

    // The next UAS can only back the edge it issued (YoYo -> Bob), so the
    // delegation hop must keep the narrow selected-instance grant.
    const claim = await find(new DelegatedAccessClaimValidator(), false)

    const policies = policiesOf(claim)
    expect(policies).toHaveLength(1)
    expect(policies[0].scopeOfGrant).toBe(CONTEXT.SelectedFromRegistry)
    expect(policies[0].permission[0].target.source).toEqual([PROJECT_X])
  })
})
