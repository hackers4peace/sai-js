import type { DataRegistrationData, RegistrySetData } from '@janeirodigital/interop-data-model'
import { ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { describe, expect, test, vi } from 'vitest'

import { AuthorizationAgent } from '../src/index.ts'
import type {
  DataInstanceFacts,
  ShareContextFacts,
  ShareDataInstanceStructure,
} from '../src/index.ts'

// ──────────────────────────
// `buildShareDataAuthorizations` — the context facts path (org context).
//
// The session here is an ADMIN acting for the CONTEXT owner (`OWNER`): its own
// endpoint allowlist does not contain the context's data pods, so every read
// on the context's data plane (registration from `lws:partOf`, child
// registrations, existing access) is pre-read by the caller and handed in as
// `ShareContextFacts`. The tests pin that the build uses those facts — and
// that without them the session's own reads are used (personal context).
// ──────────────────────────

const OWNER = 'https://id/org'
const ADMIN = 'https://id/admin'
const KIM = 'https://id/kim'
const DAN = 'https://id/dan'

const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'
const RESOURCE = 'https://org.data/n3onkx'
const REGISTRATION = 'https://org.data/avn9hv'
const CHILD_REGISTRATION = 'https://org.data/taskreg'
const DATA_REGISTRY = 'https://org.data/'
const AUTH_REGISTRY = 'https://registry/org/authorization/'

const registrySet = {
  hasAuthorizationRegistry: { id: AUTH_REGISTRY },
} as unknown as RegistrySetData

const details: ShareDataInstanceStructure = {
  applicationId: 'https://app.example/',
  resource: RESOURCE,
  accessMode: [ACCESS_ACTIONS.read],
  children: [{ shapeTree: TASK_TREE, accessMode: [ACCESS_ACTIONS.read] }],
  // the owner is excluded by the rule, DAN already holds access
  agents: [OWNER, KIM, DAN],
}

const registration = {
  id: REGISTRATION,
  registeredShapeTree: PROJECT_TREE,
  partOf: DATA_REGISTRY,
} as unknown as DataRegistrationData

const childRegistration = {
  id: CHILD_REGISTRATION,
  registeredShapeTree: TASK_TREE,
  partOf: DATA_REGISTRY,
} as unknown as DataRegistrationData

const dataInstance: DataInstanceFacts = {
  id: RESOURCE,
  shapeTreeIri: PROJECT_TREE,
  dataRegistration: registration,
}

/** The context's own data plane: registration resolved, child reg read, DAN holds access. */
function contextFacts(overrides: Partial<ShareContextFacts> = {}): ShareContextFacts {
  return {
    dataInstance,
    agentsWithAccess: [DAN],
    registrations: new Map([[TASK_TREE, childRegistration]]),
    ...overrides,
  }
}

const failFetch = (async (url: string) => {
  throw new Error(`unexpected fetch: ${url}`)
}) as unknown as WhatwgFetch

type SessionInternals = {
  loadDataInstance: (id: string) => Promise<DataInstanceFacts>
  agentsWithAccessTo: (
    iri: string,
    ownerWebId: string,
    registrySet: RegistrySetData
  ) => Promise<Set<string>>
}

/**
 * The admin's session: no network at all (any fetch fails), deterministic
 * minting through an injected identifier strategy.
 */
function adminSession(): AuthorizationAgent {
  const agent = new AuthorizationAgent(ADMIN, 'https://admin.agent/#agent', {
    fetch: failFetch,
    randomUUID: () => 'unused-uuid',
    sparqlEndpoint: 'https://registry/admin/sparql',
  })
  let minted = 0
  const strategy = {
    mint: ({ parent }: { parent: string }): string => `${parent}${++minted}`,
    create: (): never => {
      throw new Error('unexpected creation plan')
    },
  }
  agent.identifierStrategies = {
    resolve: async (storageUrl: string) => ({ storageUrl, storageRoot: storageUrl, strategy }),
    forStorage: () => strategy,
  }
  return agent
}

describe('buildShareDataAuthorizations — context facts', () => {
  test('builds from the pre-read facts without touching the session reads', async () => {
    const agent = adminSession()
    const internals = agent as unknown as SessionInternals
    const load = vi.spyOn(internals, 'loadDataInstance')
    const alreadyHaveAccess = vi.spyOn(internals, 'agentsWithAccessTo')

    const recorded = await agent.buildShareDataAuthorizations(
      details,
      OWNER,
      registrySet,
      contextFacts()
    )

    // the context plane is authoritative — the session resolved nothing
    expect(load).not.toHaveBeenCalled()
    expect(alreadyHaveAccess).not.toHaveBeenCalled()

    // owner excluded, DAN filtered as already-having-access, KIM built from
    // the facts' instance/registration (child reg from the map). The result is
    // FLAT: the parent carries the reverse link, the child its forward link.
    const nestedChild = {
      type: [INTEROP.DataAuthorization],
      grantee: KIM,
      grantedBy: OWNER,
      registeredShapeTree: TASK_TREE,
      scopeOfAuthorization: INTEROP.Inherited,
      dataOwner: OWNER,
      hasDataRegistration: CHILD_REGISTRATION,
      accessMode: [ACCESS_ACTIONS.read],
    }
    expect(recorded).toEqual([
      {
        type: [INTEROP.DataAuthorization],
        grantee: KIM,
        grantedBy: OWNER,
        registeredShapeTree: PROJECT_TREE,
        scopeOfAuthorization: INTEROP.SelectedFromRegistry,
        dataOwner: OWNER,
        hasDataRegistration: REGISTRATION,
        accessMode: [ACCESS_ACTIONS.read],
        hasDataInstance: [RESOURCE],
        children: [nestedChild],
        id: `${AUTH_REGISTRY}1`,
        hasInheritingAuthorization: [`${AUTH_REGISTRY}2`],
      },
      {
        ...nestedChild,
        id: `${AUTH_REGISTRY}2`,
        inheritsFromAuthorization: `${AUTH_REGISTRY}1`,
      },
    ])
  })

  test('falls back to the session reads when no facts are passed (personal context)', async () => {
    const agent = adminSession()
    const internals = agent as unknown as SessionInternals
    const load = vi
      .spyOn(internals, 'loadDataInstance')
      .mockResolvedValue({ ...dataInstance, isBlob: false } as DataInstanceFacts)
    const alreadyHaveAccess = vi
      .spyOn(internals, 'agentsWithAccessTo')
      .mockResolvedValue(new Set([DAN]))
    const findDataRegistration = vi
      .spyOn(agent, 'findDataRegistration')
      .mockResolvedValue(childRegistration)

    const recorded = await agent.buildShareDataAuthorizations(details, OWNER, registrySet)

    expect(load).toHaveBeenCalledWith(RESOURCE)
    expect(alreadyHaveAccess).toHaveBeenCalledWith(RESOURCE, OWNER, registrySet)
    // the child registration is read through the instance's `lws:partOf` registry
    expect(findDataRegistration).toHaveBeenCalledWith(DATA_REGISTRY, TASK_TREE)
    // parent + its inheriting child, both for KIM
    expect(recorded.map(({ grantee }) => grantee)).toEqual([KIM, KIM])
    expect(recorded[0].hasInheritingAuthorization).toEqual([`${AUTH_REGISTRY}2`])
  })

  test('a child shape tree missing from the facts fails instead of falling back', async () => {
    const agent = adminSession()
    const findDataRegistration = vi.spyOn(agent, 'findDataRegistration')

    await expect(
      agent.buildShareDataAuthorizations(
        details,
        OWNER,
        registrySet,
        contextFacts({ registrations: new Map() })
      )
    ).rejects.toThrow(`no data registration for shape tree ${TASK_TREE}`)
    expect(findDataRegistration).not.toHaveBeenCalled()
  })

  test('an instance registration without `lws:partOf` can not resolve children', async () => {
    const agent = adminSession()
    const internals = agent as unknown as SessionInternals
    vi.spyOn(internals, 'loadDataInstance').mockResolvedValue({
      id: RESOURCE,
      shapeTreeIri: PROJECT_TREE,
      dataRegistration: { id: REGISTRATION, registeredShapeTree: PROJECT_TREE },
    } as unknown as DataInstanceFacts)
    vi.spyOn(internals, 'agentsWithAccessTo').mockResolvedValue(new Set())

    await expect(agent.buildShareDataAuthorizations(details, OWNER, registrySet)).rejects.toThrow(
      `data registration ${REGISTRATION} has no containing data registry (lws:partOf)`
    )
  })
})
