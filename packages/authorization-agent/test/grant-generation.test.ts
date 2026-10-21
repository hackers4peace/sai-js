import type { DataAuthorizationData, RegistrySetData } from '@janeirodigital/interop-data-model'
import { ACL, INTEROP, LDP, RDF } from '@janeirodigital/interop-utils'
import { DataFactory, type Quad, Store } from 'n3'
import { describe, expect, test, vi } from 'vitest'

import { MirrorIncompleteError, generateGrantsForAuthorization } from '../src/grant-generation.js'
import type { SparqlTransport } from '../src/sparql.js'
import type { DataModelDependencies } from '../src/types.js'

const { namedNode, quad } = DataFactory

// ──────────────────────────
// Fixtures: acme (us / grantor) delegates data owned by the peer alice to kim.
// The whole peer side is served from the LOCAL mirror — the transport below
// only knows mirrored graphs, and `deps.fetch` throws on any call, so the test
// fails loudly if the generation path dereferences anything.
// ──────────────────────────

const ACME = 'https://id/acme'
const ALICE = 'https://id/alice'
const KIM = 'https://id/kim'

const SOCIAL_AGENT_REGISTRY = 'https://registry/acme/social-agent/'
const GRANT_REGISTRY = 'https://registry/acme/grant/'
/** our registration of alice (the grantee's registry is ours) */
const ALICE_REGISTRATION = 'https://registry/acme/social-agent/r-alice'
/** alice's registration of us — the mirrored reciprocal */
const RECIPROCAL = 'https://registry/alice/social-agent/r-acme'
/** grants alice issued to us (delegation sources) */
const PROJECT_GRANT = 'https://registry/alice/grant/g-project'
const TASK_GRANT = 'https://registry/alice/grant/g-task'
/** the child of `PROJECT_GRANT` (Inherited scope) + our child authorization */
const CHILD_GRANT = 'https://registry/alice/grant/g-child'
const CHILD_AUTHORIZATION = 'https://registry/acme/authorization/a1-child'

const PROJECT_TREE = 'https://data/shapetrees/trees/Project'
const TASK_TREE = 'https://data/shapetrees/trees/Task'
const PROJECT_REGISTRATION = 'https://data/alice/registrations/projects'
const TASK_REGISTRATION = 'https://data/alice/registrations/tasks'
const PROJECT_STORAGE = 'https://data/alice/'
const TASK_STORAGE = 'https://data/alice/'

/**
 * Fresh terms per store: n3 stores assign internal term ids and MUTATE the term
 * objects they are given, so re-adding the same fixture quad objects to a second
 * store corrupts the first one's index.
 */
const cloneQuad = (source: Quad): Quad =>
  quad(
    namedNode(source.subject.value),
    namedNode(source.predicate.value),
    namedNode(source.object.value)
  )

/** A fake registry plane serving only named graphs (the mirror). */
function mirrorTransport(graphs: Map<string, Quad[]>): SparqlTransport & { queries: string[] } {
  const queries: string[] = []
  const allQuads = (): Quad[] => [...graphs.values()].flat()
  return {
    queries,
    async fetchBindings(query: string) {
      queries.push(query)
      if (query.includes('VALUES ?g')) {
        // presentGraphs — every `VALUES ?g { … }` list is checked; a `meta:`
        // graph name maps back to the IRI it backs (the graphDoc convention)
        const names = [...query.matchAll(/VALUES \?g \{([^}]*)\}/g)].flatMap((match) =>
          [...match[1].matchAll(/<([^>]+)>/g)].map((iri) => iri[1])
        )
        const present = new Set<string>()
        for (const name of names) {
          if ((graphs.get(name)?.length ?? 0) > 0) {
            present.add(name.startsWith('meta:') ? name.slice('meta:'.length) : name)
          }
        }
        return [...present].map((iri) => ({ g: { value: iri } })) as never
      }
      if (query.includes('inheritsFromAuthorization')) {
        // findInheritingAuthorizations — no children in these fixtures
        return allQuads()
          .filter((q) => q.predicate.value === INTEROP.inheritsFromAuthorization)
          .map((q) => ({ child: { value: q.subject.value } })) as never
      }
      if (query.includes(LDP.contains)) {
        // listContained — the container IRI is the first `GRAPH <…>`
        const container = /GRAPH <([^>]+)>/.exec(query)![1]
        return (graphs.get(container) ?? [])
          .filter((q) => q.predicate.value === LDP.contains)
          .map((q) => ({ child: { value: q.object.value } })) as never
      }
      throw new Error(`mirror transport: unhandled query\n${query}`)
    },
    async fetchTriples(query: string) {
      queries.push(query)
      // graphDoc — union of every `GRAPH <…>` block it names
      const store = new Store()
      for (const match of query.matchAll(/GRAPH <([^>]+)>/g)) {
        for (const source of graphs.get(match[1]) ?? []) {
          store.addQuad(cloneQuad(source))
        }
      }
      return store
    },
  } as unknown as SparqlTransport & { queries: string[] }
}

const registrationGraph = (
  id: string,
  registeredAgent: string,
  reciprocal: string,
  grants: string[]
): Quad[] => [
  quad(namedNode(id), namedNode(RDF.type), namedNode(INTEROP.SocialAgentRegistration)),
  quad(namedNode(id), namedNode(INTEROP.registeredAgent), namedNode(registeredAgent)),
  quad(namedNode(id), namedNode(INTEROP.reciprocalRegistration), namedNode(reciprocal)),
  ...grants.map((grant) => quad(namedNode(id), namedNode(INTEROP.hasDataGrant), namedNode(grant))),
]

const grantGraph = (
  id: string,
  fields: {
    shapeTree: string
    dataRegistration: string
    storage: string
    accessMode?: string[]
    scopeOfGrant?: string
  }
): Quad[] => [
  quad(namedNode(id), namedNode(RDF.type), namedNode(INTEROP.DataGrant)),
  quad(namedNode(id), namedNode(INTEROP.registeredShapeTree), namedNode(fields.shapeTree)),
  quad(namedNode(id), namedNode(INTEROP.hasDataRegistration), namedNode(fields.dataRegistration)),
  quad(namedNode(id), namedNode(INTEROP.hasStorage), namedNode(fields.storage)),
  quad(namedNode(id), namedNode(INTEROP.dataOwner), namedNode(ALICE)),
  quad(namedNode(id), namedNode(INTEROP.grantedBy), namedNode(ALICE)),
  quad(namedNode(id), namedNode(INTEROP.grantee), namedNode(ACME)),
  quad(
    namedNode(id),
    namedNode(INTEROP.scopeOfGrant),
    namedNode(fields.scopeOfGrant ?? INTEROP.AllFromRegistry)
  ),
  ...(fields.accessMode ?? [INTEROP.Read]).map((mode) =>
    quad(namedNode(id), namedNode(INTEROP.accessMode), namedNode(mode))
  ),
]

/**
 * The mirrored peer side: alice's registration of us + the grants it links.
 * Registration bodies live in their `meta:<iri>` graphs (the CSS convention the
 * seed uses), so the presence probe must see them there — that union is what
 * `graphDoc` reads.
 *
 * `withInheriting` adds the parent/child pair the grantor links on BOTH sides:
 * the child grant appears in `hasDataGrant` (so the mirror holds it, and the
 * presence check demands it), while the parent document carries the *reverse*
 * edge `<child> interop:inheritsFromGrant <parent>`. That reverse triple is how
 * `hasInheritingGrant` is encoded — the data-model context defines it as
 * `@reverse` of `inheritsFromGrant` (data-model/src/context.ts), so the
 * grantor's parent document emits it and framing surfaces it as
 * `hasInheritingGrant`, which is the forward link
 * `generateChildDelegatedGrantData` walks. (There is no
 * `interop:hasInheritingGrant` term.)
 */
function mirroredPeerGraphs(options: { withInheriting?: boolean } = {}): Map<string, Quad[]> {
  const linked = [PROJECT_GRANT, TASK_GRANT, ...(options.withInheriting ? [CHILD_GRANT] : [])]
  const projectGrant = grantGraph(PROJECT_GRANT, {
    shapeTree: PROJECT_TREE,
    dataRegistration: PROJECT_REGISTRATION,
    storage: PROJECT_STORAGE,
    accessMode: [INTEROP.Read, ACL.Write],
  })
  if (options.withInheriting) {
    // reverse edge: the child declares the parent (see the fixture note above)
    projectGrant.push(
      quad(namedNode(CHILD_GRANT), namedNode(INTEROP.inheritsFromGrant), namedNode(PROJECT_GRANT))
    )
  }
  return new Map<string, Quad[]>([
    [
      SOCIAL_AGENT_REGISTRY,
      [
        quad(
          namedNode(SOCIAL_AGENT_REGISTRY),
          namedNode(LDP.contains),
          namedNode(ALICE_REGISTRATION)
        ),
      ],
    ],
    [
      `meta:${ALICE_REGISTRATION}`,
      registrationGraph(ALICE_REGISTRATION, ALICE, RECIPROCAL, linked),
    ],
    [`meta:${RECIPROCAL}`, registrationGraph(RECIPROCAL, ACME, ALICE_REGISTRATION, linked)],
    [PROJECT_GRANT, projectGrant],
    [
      TASK_GRANT,
      grantGraph(TASK_GRANT, {
        shapeTree: TASK_TREE,
        dataRegistration: TASK_REGISTRATION,
        storage: TASK_STORAGE,
      }),
    ],
    ...(options.withInheriting
      ? [
          [
            CHILD_GRANT,
            grantGraph(CHILD_GRANT, {
              shapeTree: TASK_TREE,
              dataRegistration: TASK_REGISTRATION,
              storage: TASK_STORAGE,
              scopeOfGrant: INTEROP.Inherited,
            }),
          ] as [string, Quad[]],
          [CHILD_AUTHORIZATION, childAuthorizationGraph()] as [string, Quad[]],
        ]
      : []),
  ])
}

/** Our child authorization (Inherited scope) — read via the registry plane. */
const childAuthorizationGraph = (): Quad[] => [
  quad(namedNode(CHILD_AUTHORIZATION), namedNode(RDF.type), namedNode(INTEROP.DataAuthorization)),
  quad(namedNode(CHILD_AUTHORIZATION), namedNode(INTEROP.grantee), namedNode(KIM)),
  quad(namedNode(CHILD_AUTHORIZATION), namedNode(INTEROP.grantedBy), namedNode(ACME)),
  quad(
    namedNode(CHILD_AUTHORIZATION),
    namedNode(INTEROP.registeredShapeTree),
    namedNode(TASK_TREE)
  ),
  quad(
    namedNode(CHILD_AUTHORIZATION),
    namedNode(INTEROP.scopeOfAuthorization),
    namedNode(INTEROP.Inherited)
  ),
  quad(namedNode(CHILD_AUTHORIZATION), namedNode(INTEROP.accessMode), namedNode(INTEROP.Read)),
  quad(
    namedNode(CHILD_AUTHORIZATION),
    namedNode(INTEROP.inheritsFromAuthorization),
    namedNode('https://registry/acme/authorization/a1')
  ),
]

const registrySet = {
  id: 'https://registry/acme/',
  type: [INTEROP.RegistrySet],
  hasSocialAgentRegistry: { id: SOCIAL_AGENT_REGISTRY },
  hasGrantRegistry: { id: GRANT_REGISTRY },
} as unknown as RegistrySetData

function deps(): { deps: DataModelDependencies; fetchStub: ReturnType<typeof vi.fn> } {
  // any fetch at all is a peer dereference — generation must stay replica-only
  const fetchStub = vi.fn(() => {
    throw new Error('delegated-grant generation must not fetch (mirror-only)')
  })
  return {
    deps: {
      fetch: fetchStub as unknown as DataModelDependencies['fetch'],
      randomUUID: () => 'minted',
    },
    fetchStub,
  }
}

const authorization = (suffix: string, over: Partial<DataAuthorizationData> = {}) =>
  ({
    id: `https://registry/acme/authorization/${suffix}`,
    type: [INTEROP.DataAuthorization],
    grantee: KIM,
    grantedBy: ACME,
    dataOwner: ALICE,
    registeredShapeTree: PROJECT_TREE,
    scopeOfAuthorization: INTEROP.AllFromAgent,
    accessMode: [INTEROP.Read],
    ...over,
  }) as DataAuthorizationData

describe('delegated-grant generation — mirror only', () => {
  test('reads the mirrored peer side once for a batch of authorizations', async () => {
    const transport = mirrorTransport(mirroredPeerGraphs())
    const { deps: dataModelDeps, fetchStub } = deps()

    const generated = await generateGrantsForAuthorization(
      [authorization('a1'), authorization('a2'), authorization('a3')],
      registrySet,
      KIM,
      dataModelDeps,
      transport
    )

    // one delegated grant per authorization, all delegated from the mirrored source
    expect(generated.delegatedGrants).toHaveLength(3)
    expect(generated.delegatedGrants.map((grant) => grant.delegationOfGrant)).toEqual([
      PROJECT_GRANT,
      PROJECT_GRANT,
      PROJECT_GRANT,
    ])
    // …and the peer side was read ONCE, not once per authorization
    expect(transport.queries.filter((query) => query.includes(LDP.contains))).toHaveLength(1)
    // two presence probes (reciprocal, then its grants) — cached afterwards
    expect(transport.queries.filter((query) => query.includes('VALUES ?g'))).toHaveLength(2)
    // four graph reads: our registration, the reciprocal, and the two grants it
    // links (the index loads the peer's whole linked set once, then the
    // per-authorization shape-tree match runs in memory — same as before, but
    // no longer repeated per authorization)
    expect(transport.queries.filter((query) => query.includes('CONSTRUCT'))).toHaveLength(4)
    // no peer dereference at all
    expect(fetchStub).not.toHaveBeenCalled()
  })

  test('carries the source grant fields, intersected with the authorization', async () => {
    const transport = mirrorTransport(mirroredPeerGraphs())
    const { deps: dataModelDeps } = deps()

    const generated = await generateGrantsForAuthorization(
      [authorization('a1')],
      registrySet,
      KIM,
      dataModelDeps,
      transport
    )

    expect(generated.delegatedGrants).toHaveLength(1)
    const [grant] = generated.delegatedGrants
    expect(grant).toMatchObject({
      grantee: KIM,
      grantedBy: ACME,
      dataOwner: ALICE,
      registeredShapeTree: PROJECT_TREE,
      hasDataRegistration: PROJECT_REGISTRATION,
      hasStorage: PROJECT_STORAGE,
      scopeOfGrant: INTEROP.AllFromRegistry,
      delegationOfGrant: PROJECT_GRANT,
      // the source allows Read+Write, the authorization asks for Read only
      accessMode: [INTEROP.Read],
    })
  })

  test('matches by shape tree — only the Project grant delegates', async () => {
    const transport = mirrorTransport(mirroredPeerGraphs())
    const { deps: dataModelDeps } = deps()

    const generated = await generateGrantsForAuthorization(
      [authorization('a1', { registeredShapeTree: TASK_TREE, accessMode: [INTEROP.Read] })],
      registrySet,
      KIM,
      dataModelDeps,
      transport
    )

    expect(generated.delegatedGrants.map((grant) => grant.delegationOfGrant)).toEqual([TASK_GRANT])
  })

  test('MirrorIncompleteError when the reciprocal registration is not mirrored', async () => {
    const graphs = mirroredPeerGraphs()
    graphs.delete(`meta:${RECIPROCAL}`)
    const transport = mirrorTransport(graphs)
    const { deps: dataModelDeps } = deps()

    const error = await generateGrantsForAuthorization(
      [authorization('a1')],
      registrySet,
      KIM,
      dataModelDeps,
      transport
    ).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(MirrorIncompleteError)
    expect(error).toMatchObject({ iri: RECIPROCAL, kind: 'registration' })
  })

  test('MirrorIncompleteError when a linked grant is not mirrored', async () => {
    const graphs = mirroredPeerGraphs()
    graphs.delete(PROJECT_GRANT)
    const transport = mirrorTransport(graphs)
    const { deps: dataModelDeps } = deps()

    const error = await generateGrantsForAuthorization(
      [authorization('a1')],
      registrySet,
      KIM,
      dataModelDeps,
      transport
    ).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(MirrorIncompleteError)
    expect(error).toMatchObject({ iri: PROJECT_GRANT, kind: 'grant' })
  })

  test('delegates an inheriting child grant from the mirrored child grant', async () => {
    // the grantor links the child in `hasDataGrant` (so the mirror holds it and
    // the presence check demands it) AND on the parent as `hasInheritingGrant`
    // (the forward link the child delegation walks)
    const transport = mirrorTransport(mirroredPeerGraphs({ withInheriting: true }))
    const { deps: dataModelDeps, fetchStub } = deps()

    const generated = await generateGrantsForAuthorization(
      [authorization('a1')],
      registrySet,
      KIM,
      dataModelDeps,
      transport
    )

    expect(generated.delegatedGrants).toHaveLength(1)
    const [parent] = generated.delegatedGrants
    expect(parent.delegationOfGrant).toBe(PROJECT_GRANT)
    // the child rides the parent as embedded data (the issuance endpoint assigns
    // IRIs) and delegates from the peer's mirrored child grant
    const [child] = parent.hasInheritingGrant as unknown as {
      registeredShapeTree: string
      scopeOfGrant: string
      delegationOfGrant: string
      dataOwner: string
    }[]
    expect(child).toMatchObject({
      registeredShapeTree: TASK_TREE,
      scopeOfGrant: INTEROP.Inherited,
      delegationOfGrant: CHILD_GRANT,
      dataOwner: ALICE,
    })
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
