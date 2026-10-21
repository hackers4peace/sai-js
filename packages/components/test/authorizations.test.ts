import { INTEROP } from '@janeirodigital/interop-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The service resolves shape-tree labels through the data-model module. Mock
// only the two ShapeTree functions (the rest of the module stays real), so the
// test exercises the mapping without serving shape-tree documents over HTTP.
const shapeTreeMock = vi.hoisted(() => ({
  fromJsonLd: vi.fn(),
  getDescription: vi.fn(),
}))

const authzReaderMock = vi.hoisted(() => vi.fn())

vi.mock('@janeirodigital/interop-data-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janeirodigital/interop-data-model')>()
  return {
    ...actual,
    ShapeTree: {
      ...actual.ShapeTree,
      fromJsonLd: shapeTreeMock.fromJsonLd,
      getDescription: shapeTreeMock.getDescription,
    },
  }
})

// The service binds the CONTEXT registry set + transport (org contexts read
// via `/sparql-admin`); mock the AA registry-plane reader, not the session.
vi.mock('@janeirodigital/interop-authorization-agent', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@janeirodigital/interop-authorization-agent')>()
  return { ...actual, findAuthorizationsForGrantee: authzReaderMock }
})

import { listAuthorizations } from '../src/services/Authorization.js'
import type { ResolvedContext } from '../src/services/Context.js'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const GRANTEE = 'https://projectron.example/#app'
const OWNER = 'https://id/acme'
const PROJECT_TREE = 'https://solidshapes.example/trees/Project'
const TASK_TREE = 'https://solidshapes.example/trees/Task'
const PARENT = 'https://registry/acme/authorization/parent'
const CHILD = 'https://registry/acme/authorization/child'
const REGISTRATION = 'https://data/acme/rnd/'
const AUTHZ_REGISTRY = 'https://registry/acme/authorization/'
const ROLE_REGISTRY = 'https://registry/acme/role/'
const READ = 'http://www.w3.org/ns/auth/acl#Read'
const UPDATE = 'http://www.w3.org/ns/auth/acl#Update'

const parentAuthorization = {
  id: PARENT,
  type: [INTEROP.DataAuthorization],
  grantee: GRANTEE,
  grantedBy: OWNER,
  registeredShapeTree: PROJECT_TREE,
  scopeOfAuthorization: INTEROP.AllFromRegistry,
  dataOwner: OWNER,
  hasDataRegistration: REGISTRATION,
  accessMode: [READ, UPDATE],
}

const childAuthorization = {
  id: CHILD,
  type: [INTEROP.DataAuthorization],
  grantee: GRANTEE,
  grantedBy: OWNER,
  registeredShapeTree: TASK_TREE,
  scopeOfAuthorization: INTEROP.Inherited,
  inheritsFromAuthorization: PARENT,
  accessMode: [READ],
}

function buildContext(authorizations: unknown[]): {
  ctx: ResolvedContext
  reader: typeof authzReaderMock
} {
  authzReaderMock.mockResolvedValue(authorizations)
  const ctx = {
    session: {
      sparqlEndpoint: 'http://example.test/sparql',
      // `loadShapeTree` fetches the document before the mocked `fromJsonLd`
      // decodes it; any JSON body is enough here
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    },
    registrySet: {
      hasAuthorizationRegistry: { id: AUTHZ_REGISTRY },
      hasRoleRegistry: { id: ROLE_REGISTRY },
    },
    webId: OWNER,
    userWebId: OWNER,
  } as unknown as ResolvedContext
  return { ctx, reader: authzReaderMock }
}

beforeEach(() => {
  authzReaderMock.mockReset()
  shapeTreeMock.fromJsonLd.mockImplementation(async (_doc: unknown, id: string) => ({
    id,
    type: [],
    descriptionLanguages: ['en'],
    references: [],
  }))
  shapeTreeMock.getDescription.mockImplementation(async (tree: { id: string }) => ({
    id: `${tree.id}#description`,
    type: [],
    label: { en: tree.id === PROJECT_TREE ? 'Project' : 'Task' },
  }))
})

describe('listAuthorizations — C0 read model', () => {
  test('maps the AA rows to the RPC shape and resolves shape-tree labels', async () => {
    const { ctx, reader } = buildContext([parentAuthorization, childAuthorization])

    const result = await listAuthorizations(ctx, GRANTEE, 'en')

    expect(reader).toHaveBeenCalledWith(expect.anything(), ctx.registrySet, GRANTEE)
    expect(result).toHaveLength(2)

    // sorted by (dataOwner, registeredShapeTree, id) — Project before Task
    expect(result[0]).toMatchObject({
      id: PARENT,
      grantee: GRANTEE,
      grantedBy: OWNER,
      registeredShapeTree: PROJECT_TREE,
      scopeOfAuthorization: INTEROP.AllFromRegistry,
      dataOwner: OWNER,
      hasDataRegistration: REGISTRATION,
      accessMode: [READ, UPDATE],
      shapeTreeLabel: 'Project',
    })

    expect(result[1]).toMatchObject({
      id: CHILD,
      registeredShapeTree: TASK_TREE,
      scopeOfAuthorization: INTEROP.Inherited,
      inheritsFromAuthorization: PARENT,
      accessMode: [READ],
      shapeTreeLabel: 'Task',
    })
    // optional fields are omitted, not set to undefined
    expect(result[1]).not.toHaveProperty('dataOwner')
    expect(result[1]).not.toHaveProperty('hasDataRegistration')
    expect(result[1]).not.toHaveProperty('hasInheritingAuthorization')
  })

  test('falls back to the shape-tree IRI when the description is unavailable', async () => {
    shapeTreeMock.getDescription.mockRejectedValueOnce(new Error('missing description'))
    const { ctx } = buildContext([parentAuthorization])

    const [authorization] = await listAuthorizations(ctx, GRANTEE, 'en')

    expect(authorization.shapeTreeLabel).toBe(PROJECT_TREE)
  })

  test('returns an empty list when the grantee has no authorizations', async () => {
    const { ctx } = buildContext([])

    await expect(listAuthorizations(ctx, GRANTEE, 'en')).resolves.toEqual([])
  })
})
