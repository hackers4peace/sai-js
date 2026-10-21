import {
  type DataAuthorizationData,
  type DataRegistrationData,
  type FinalGrantData,
  type GeneratedGrants,
  type GrantData,
  type RegistrySetData,
  type SocialAgentRegistrationData,
  ShapeTree,
  childIris,
  frameDataInstance,
} from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)

import {
  INTEROP,
  type WhatwgFetch,
  iriForContained,
  loader,
  storageIri,
} from '@janeirodigital/interop-utils'

import {
  type SparqlTransport,
  findInheritingAuthorizations,
  getDataAuthorization,
  getDataGrant,
  getDataRegistration,
  getRole,
  getSocialAgentRegistration,
  listContained,
  localSparqlTransport,
  presentGraphs,
} from './sparql.ts'
import type { DataModelDependencies } from './types.ts'

// ──────────────────────────
// Instance enumeration over the registry plane (resolves the Phase-2
// wrinkle: components' `Grant.getDataInstanceIterator` usage)
// ──────────────────────────

/**
 * Iterate the data instance ids described by a grant, over the registry
 * plane — AllFromRegistry via the data registration's `contains`,
 * SelectedFromRegistry via `hasDataInstance`, Inherited via the parent chain
 * plus data-plane child walks. The Inherited arm still derefs instance
 * documents (data-instance framing) with the session's `fetch`.
 */
export async function* dataInstanceIrisForGrant(
  grant: GrantData,
  transport: SparqlTransport,
  fetch: WhatwgFetch
): AsyncIterable<string> {
  switch (grant.scopeOfGrant) {
    case INTEROP.AllFromRegistry: {
      const registration = await getDataRegistration(transport, grant.hasDataRegistration)
      for (const id of registration.contains) {
        yield id
      }
      break
    }
    case INTEROP.SelectedFromRegistry: {
      for (const id of grant.hasDataInstance ?? []) {
        yield id
      }
      break
    }
    case INTEROP.Inherited: {
      const parentGrant = await getDataGrant(transport, grant.inheritsFromGrant!)
      for await (const parentId of dataInstanceIrisForGrant(parentGrant, transport, fetch)) {
        yield* await getChildInstanceIris(parentGrant, parentId, grant.registeredShapeTree, fetch)
      }
      break
    }
    default:
      throw new Error(`Unknown scope: ${grant.scopeOfGrant}`)
  }
}

/**
 * Child instance ids referenced by a parent instance for a shape tree, via
 * the parent shape tree's reference predicate (data-plane read).
 */
async function getChildInstanceIris(
  parentGrant: GrantData,
  parentId: string,
  childShapeTree: string,
  fetch: WhatwgFetch
): Promise<string[]> {
  const parentShapeTree = await loadShapeTree(parentGrant.registeredShapeTree, fetch)
  const node = await frameDataInstance(parentId, fetch, parentShapeTree)
  return childIris(node, parentShapeTree, childShapeTree)
}

// ──────────────────────────
// Grant-generation chain (relocated from data-model; listings on the AA's
// registry plane — docs/sparql.md)
// ──────────────────────────

export interface SourceAndDelegatedGrants {
  source: FinalGrantData[]
  delegated: GrantData[]
}

/**
 * Fetch the data authorizations that inherit from this one (children linked
 * via interop:inheritsFromAuthorization) — via the registry plane.
 */
async function inheritingAuthorizations(
  data: DataAuthorizationData,
  transport: SparqlTransport
): Promise<DataAuthorizationData[]> {
  // the parent's `hasInheritingAuthorization` reverse list is UNRELIABLE
  // (the activity framing drops @reverse on embedded nodes — stored parents
  // can lack it); the child's forward `inheritsFromAuthorization` always
  // survives — union it with any stored reverse list and dedupe, covering
  // every storage state without re-migration
  const storedChildIris = data.hasInheritingAuthorization ?? []
  const forwardIris = await findInheritingAuthorizations(transport, data.id!)
  const iris = [...new Set([...storedChildIris, ...forwardIris])]
  return Promise.all(iris.map((iri) => getDataAuthorization(transport, iri)))
}

async function generateChildDelegatedGrantData(
  data: DataAuthorizationData,
  parentGrantIri: string,
  sourceGrant: GrantData,
  registrySet: RegistrySetData,
  grantee: string,
  deps: DataModelDependencies,
  transport: SparqlTransport
): Promise<GrantData[]> {
  const result: GrantData[] = []
  const childAuthorizations = await inheritingAuthorizations(data, transport)
  for (const childAuthorization of childAuthorizations) {
    // Find matching child grant by reading each child IRI (registry plane)
    let childSourceGrant: GrantData | undefined
    for (const childIri of sourceGrant.hasInheritingGrant ?? []) {
      const childGrant = await getDataGrant(transport, childIri)
      if (childGrant.registeredShapeTree === childAuthorization.registeredShapeTree) {
        childSourceGrant = childGrant
        break
      }
    }
    if (!childSourceGrant) continue

    const childData: GrantData = {
      // no id — delegation endpoint assigns IRIs
      type: [INTEROP.DataGrant],
      grantee,
      grantedBy: data.grantedBy,
      dataOwner: childSourceGrant.dataOwner,
      registeredShapeTree: childAuthorization.registeredShapeTree,
      hasDataRegistration: childSourceGrant.hasDataRegistration,
      hasStorage: childSourceGrant.hasStorage,
      scopeOfGrant: INTEROP.Inherited,
      accessMode: childAuthorization.accessMode.filter((mode) =>
        childSourceGrant.accessMode.includes(mode)
      ),
      inheritsFromGrant: parentGrantIri,
      delegationOfGrant: childSourceGrant.id!,
    }
    result.push(childData)
  }
  return result
}

/**
 * Raised when the local reciprocal mirror does not hold a graph the delegation
 * path needs. Delegated-grant generation may only read replicated peer data
 * (improve-grant-replication.md §2/§5) — a missing graph means the mirror sync
 * has not landed yet, and generating without it would silently produce fewer
 * (or wrong) delegated grants. The workflow retries; the delegated-grants
 * consumer replicates before every regeneration.
 */
export class MirrorIncompleteError extends Error {
  public readonly iri: string
  public readonly kind: 'registration' | 'grant'

  public constructor(iri: string, kind: 'registration' | 'grant') {
    super(
      `reciprocal mirror is missing the ${kind} graph <${iri}> — replicate the peer side before generating delegated grants`
    )
    this.name = 'MirrorIncompleteError'
    this.iri = iri
    this.kind = kind
  }
}

interface MirroredPeer {
  /** the peer's registration of us (the mirrored reciprocal) */
  reciprocal: SocialAgentRegistrationData
  /** the grants the peer issued to us — the delegation sources */
  grants: GrantData[]
}

/**
 * Per-regeneration cache over the mirrored peer side.
 *
 * `generateDelegatedDataGrants` runs once per data authorization (and once per
 * role member for `AllFromRole`), and it used to re-read the whole social-agent
 * registry plus every reciprocal registration and grant body on each pass —
 * A × (1 + 2P + PG) graph reads. This index reads the registry listing once and
 * each peer's mirrored side once on first use, so the cost is (1 + 2P + PG)
 * per regeneration and only for the peers the filters actually reach.
 *
 * Presence is checked before framing: a reciprocal-linked registration or a
 * linked grant with no local graph is a mirror gap, not a data-model problem, so
 * it surfaces as `MirrorIncompleteError` naming the IRI instead of the generic
 * framing error. Grants are immutable (a change mints a fresh IRI), so a graph
 * that is present is also current — nothing is compared or re-fetched.
 */
class MirroredPeerIndex {
  private readonly transport: SparqlTransport
  private readonly registrySet: RegistrySetData
  private registrations?: Promise<SocialAgentRegistrationData[]>
  private readonly peers = new Map<string, Promise<MirroredPeer>>()

  public constructor(transport: SparqlTransport, registrySet: RegistrySetData) {
    this.transport = transport
    this.registrySet = registrySet
  }

  /** Our registrations that carry a reciprocal link — the delegation candidates. */
  public async socialAgents(): Promise<SocialAgentRegistrationData[]> {
    this.registrations ??= listContained(
      this.transport,
      this.registrySet.hasSocialAgentRegistry.id
    ).then((iris) =>
      Promise.all(iris.map((iri) => getSocialAgentRegistration(this.transport, iri)))
    )
    return (await this.registrations).filter((registration) => registration.reciprocalRegistration)
  }

  /** The mirrored peer side for one of our registrations (cached per reciprocal IRI). */
  public async for(registration: SocialAgentRegistrationData): Promise<MirroredPeer | undefined> {
    const reciprocalIri = registration.reciprocalRegistration
    if (!reciprocalIri) return undefined
    let peer = this.peers.get(reciprocalIri)
    if (!peer) {
      peer = this.load(reciprocalIri)
      this.peers.set(reciprocalIri, peer)
    }
    return peer
  }

  private async load(reciprocalIri: string): Promise<MirroredPeer> {
    const presentReciprocals = await presentGraphs(this.transport, [reciprocalIri])
    if (!presentReciprocals.has(reciprocalIri)) {
      throw new MirrorIncompleteError(reciprocalIri, 'registration')
    }
    const reciprocal = await getSocialAgentRegistration(this.transport, reciprocalIri)
    const grantIris = reciprocal.hasDataGrant ?? []
    if (grantIris.length === 0) return { reciprocal, grants: [] }
    const presentGrants = await presentGraphs(this.transport, grantIris)
    const missing = grantIris.find((iri) => !presentGrants.has(iri))
    if (missing) throw new MirrorIncompleteError(missing, 'grant')
    const grants = await Promise.all(grantIris.map((iri) => getDataGrant(this.transport, iri)))
    return { reciprocal, grants }
  }
}

async function generateDelegatedDataGrants(
  data: DataAuthorizationData,
  registrySet: RegistrySetData,
  peers: MirroredPeerIndex,
  grantee: string,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  dataOwner?: string
): Promise<GrantData[]> {
  if (data.scopeOfAuthorization === INTEROP.Inherited) {
    throw new Error('this method should not be callend on data authorizations with Inherited scope')
  }
  const result: GrantData[] = []

  for (const agentRegistration of await peers.socialAgents()) {
    // data onwer is specified but it is not their registration
    if (dataOwner && dataOwner !== agentRegistration.registeredAgent) {
      continue
    }
    // don't create delegated data grants for data owned by the grantee (registeredAgent)
    if (grantee === agentRegistration.registeredAgent) {
      continue
    }
    // the mirrored reciprocal registration + the grants it links (the source
    // grants); throws MirrorIncompleteError when the mirror has a gap
    const peer = await peers.for(agentRegistration)
    if (!peer || peer.grants.length === 0) continue

    let matchingDataGrants = peer.grants.filter(
      (grant) => grant.registeredShapeTree === data.registeredShapeTree
    )
    if (data.hasDataRegistration) {
      matchingDataGrants = matchingDataGrants.filter(
        (grant) => grant.hasDataRegistration === data.hasDataRegistration
      )
    }

    for (const sourceGrant of matchingDataGrants) {
      const regularGrantIri = iriForContained(registrySet.hasGrantRegistry, deps.randomUUID)

      const childGrantData: GrantData[] = await generateChildDelegatedGrantData(
        data,
        regularGrantIri,
        sourceGrant,
        registrySet,
        grantee,
        deps,
        transport
      )
      const scope: string =
        data.scopeOfAuthorization === INTEROP.SelectedFromRegistry ||
        sourceGrant.scopeOfGrant === INTEROP.SelectedFromRegistry
          ? INTEROP.SelectedFromRegistry
          : INTEROP.AllFromRegistry
      const grant: GrantData = {
        type: [INTEROP.DataGrant],
        grantee,
        grantedBy: data.grantedBy,
        dataOwner: sourceGrant.dataOwner,
        registeredShapeTree: sourceGrant.registeredShapeTree,
        hasDataRegistration: sourceGrant.hasDataRegistration,
        hasStorage: sourceGrant.hasStorage,
        scopeOfGrant: scope,
        delegationOfGrant: sourceGrant.id!,
        accessMode: data.accessMode.filter((mode) => sourceGrant.accessMode.includes(mode)),
      }
      if (grant.scopeOfGrant === INTEROP.SelectedFromRegistry) {
        if (data.hasDataInstance?.length) {
          grant.hasDataInstance = [...data.hasDataInstance]
        } else {
          grant.hasDataInstance = [...(sourceGrant.hasDataInstance ?? [])]
        }
      }
      if (childGrantData.length) {
        // embed full child grant data for delegation endpoint to assign IRIs
        grant.hasInheritingGrant = childGrantData as unknown as string[]
      }
      // only push parent — children are embedded in hasInheritingGrant and handled by GrantIssuanceHandler
      result.push(grant)
    }
  }
  return result
}

async function generateChildSourceGrantData(
  data: DataAuthorizationData,
  parentGrantIri: string,
  dataRegistrations: DataRegistrationData[],
  registrySet: RegistrySetData,
  grantee: string,
  dataStorageIri: string,
  deps: DataModelDependencies,
  transport: SparqlTransport
): Promise<FinalGrantData[]> {
  const result: FinalGrantData[] = []
  const childAuthorizations = await inheritingAuthorizations(data, transport)
  for (const childAuthorization of childAuthorizations) {
    const childGrantIri = iriForContained(registrySet.hasGrantRegistry, deps.randomUUID)
    const dataRegistration = dataRegistrations.find(
      (registration) => registration.registeredShapeTree === childAuthorization.registeredShapeTree
    )
    if (!dataRegistration) continue

    const childData: FinalGrantData = {
      id: childGrantIri,
      type: [INTEROP.DataGrant],
      grantee,
      grantedBy: childAuthorization.grantedBy,
      dataOwner: childAuthorization.grantedBy,
      registeredShapeTree: childAuthorization.registeredShapeTree,
      hasDataRegistration: dataRegistration.id,
      hasStorage: dataStorageIri,
      scopeOfGrant: INTEROP.Inherited,
      accessMode: childAuthorization.accessMode,
      inheritsFromGrant: parentGrantIri,
    }
    result.push(childData)
  }
  return result
}

async function generateSourceDataGrants(
  data: DataAuthorizationData,
  registrySet: RegistrySetData,
  grantee: string,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  endpoints?: Map<string, string>
): Promise<FinalGrantData[]> {
  if (data.scopeOfAuthorization === INTEROP.Inherited) {
    throw new Error('this method should not be callend on data authorizations with Inherited scope')
  }

  const result: FinalGrantData[] = []

  // data pods from the account-storage allowlist when available (the caller
  // excludes the registry pod); the registry set is only the fallback
  const pods: [string, string | undefined][] = endpoints
    ? [...endpoints.entries()]
    : registrySet.hasDataRegistry.map((registry) => [registry.id, undefined])
  for (const [podUrl, endpoint] of pods) {
    const podTransport = endpoint ? localSparqlTransport(endpoint) : transport

    // the `ldp:contains` listing + bodies via the registry plane
    // (replaces the HTTP `DataRegistry.registrations` iterator)
    const registrationIris = await listContained(podTransport, podUrl)
    const dataRegistrations = await Promise.all(
      registrationIris.map((iri) => getDataRegistration(podTransport, iri))
    )

    let matchingRegistration: DataRegistrationData | undefined

    if (data.hasDataRegistration) {
      // match registration if specified
      matchingRegistration = dataRegistrations.find(
        (registration) => registration.id === data.hasDataRegistration
      )
    } else {
      // match shape tree
      matchingRegistration = dataRegistrations.find(
        (registration) => registration.registeredShapeTree === data.registeredShapeTree
      )
    }

    if (!matchingRegistration) continue

    // create source grant
    const regularGrantIri = iriForContained(registrySet.hasGrantRegistry, deps.randomUUID)

    // create children if needed
    const childGrantData: FinalGrantData[] = await generateChildSourceGrantData(
      data,
      regularGrantIri,
      dataRegistrations,
      registrySet,
      grantee,
      await storageIri({ id: podUrl }, deps.fetch),
      deps,
      transport
    )

    let scopeOfGrant: string = INTEROP.AllFromRegistry
    if (data.scopeOfAuthorization === INTEROP.SelectedFromRegistry)
      scopeOfGrant = INTEROP.SelectedFromRegistry
    const grant: FinalGrantData = {
      id: regularGrantIri,
      type: [INTEROP.DataGrant],
      grantee,
      grantedBy: data.grantedBy,
      dataOwner: data.grantedBy,
      registeredShapeTree: data.registeredShapeTree,
      hasDataRegistration: matchingRegistration.id,
      hasStorage: await storageIri({ id: podUrl }, deps.fetch),
      scopeOfGrant,
      accessMode: data.accessMode,
    }
    if (data.hasDataInstance?.length) {
      grant.hasDataInstance = data.hasDataInstance
    }
    if (childGrantData.length) {
      grant.hasInheritingGrant = childGrantData.map((g) => g.id).filter(Boolean)
    }
    result.push(grant, ...childGrantData)
  }

  if (!result.length) throw new Error('no data grants were generated!')
  return result
}

/**
 * Generate source and/or delegated data grants for a single data authorization.
 *
 * Source grants are only created if the data authorization is registered by the
 * data owner; otherwise only delegated data grants are created. Handles the
 * AllFromRole scope by iterating over role members.
 *
 * Kept as the public single-authorization entry point: it builds a fresh
 * `MirroredPeerIndex`, so a caller that generates for several authorizations
 * should go through `generateGrantsForAuthorization`, which shares one index
 * across them (the peer side is then read once per regeneration, not once per
 * authorization).
 */
export async function generateDataGrants(
  data: DataAuthorizationData,
  registrySet: RegistrySetData,
  grantee: string,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  endpoints?: Map<string, string>
): Promise<SourceAndDelegatedGrants> {
  return generateDataGrantsWithPeers(
    data,
    new MirroredPeerIndex(transport, registrySet),
    registrySet,
    grantee,
    deps,
    transport,
    endpoints
  )
}

async function generateDataGrantsWithPeers(
  data: DataAuthorizationData,
  peers: MirroredPeerIndex,
  registrySet: RegistrySetData,
  grantee: string,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  endpoints?: Map<string, string>
): Promise<SourceAndDelegatedGrants> {
  const dataGrantData: SourceAndDelegatedGrants = {
    source: [],
    delegated: [],
  }

  if (data.dataOwner && data.scopeOfAuthorization === INTEROP.AllFromRole) {
    const role = await getRole(transport, data.dataOwner)
    if (!role) throw new Error(`role not found: ${data.dataOwner}`)
    for (const member of role.members) {
      if (member === data.grantedBy) {
        const sourceGrants = await generateSourceDataGrants(
          data,
          registrySet,
          grantee,
          deps,
          transport,
          endpoints
        )
        dataGrantData.source.push(...sourceGrants)
      } else {
        const delegatedGrants = await generateDelegatedDataGrants(
          data,
          registrySet,
          peers,
          grantee,
          deps,
          transport,
          member
        )
        dataGrantData.delegated.push(...delegatedGrants)
      }
    }
    return dataGrantData
  }

  /* Source grants are only created if Data Authorization is registred by the data owner.
   * This can only happen with scope:
   * - All - there will be no dataOwner set
   * - AllFromAgent - dataOwner will equal grantedBy
   * - lower with same condition as previous
   * Otherwise only delegated data grants are created
   */
  if (!data.dataOwner || data.dataOwner === data.grantedBy) {
    dataGrantData.source = await generateSourceDataGrants(
      data,
      registrySet,
      grantee,
      deps,
      transport,
      endpoints
    )
  }

  // do not create delegated data grants if granted by data owner, source grants will be created instead
  /* Delegated grants are only created for data owned by others than agent granting the authorization
   * This can only happen with scopes:
   * - All - there will be no dataOwner set
   * - All From Agent - dataOwner will be different than grantedBy
   * - lower with same condition as previous
   * Otherwise only source data grants are created
   */
  if (!data.dataOwner || data.dataOwner !== data.grantedBy) {
    dataGrantData.delegated = await generateDelegatedDataGrants(
      data,
      registrySet,
      peers,
      grantee,
      deps,
      transport,
      data.dataOwner
    )
  }

  return dataGrantData
}

/**
 * Generate source and delegated data grants for a list of data authorizations.
 *
 * Inherited-scope data authorizations are skipped (they are handled by their
 * parent via hasInheritingAuthorization). An empty list means the grantee is
 * not granted and results in empty grants.
 */
export async function generateGrantsForAuthorization(
  dataAuthorizations: DataAuthorizationData[],
  registrySet: RegistrySetData,
  grantee: string,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  endpoints?: Map<string, string>
): Promise<GeneratedGrants> {
  const sourceGrants: FinalGrantData[] = []
  const delegatedGrants: GrantData[] = []
  // one peer index for the whole regeneration: the mirrored peer side is read
  // once, no matter how many authorizations (or role members) delegate from it
  const peers = new MirroredPeerIndex(transport, registrySet)

  for (const dataAuthorization of dataAuthorizations) {
    if (dataAuthorization.scopeOfAuthorization === INTEROP.Inherited) {
      continue
    }
    const grants = await generateDataGrantsWithPeers(
      dataAuthorization,
      peers,
      registrySet,
      grantee,
      deps,
      transport,
      endpoints
    )
    sourceGrants.push(...grants.source)
    delegatedGrants.push(...grants.delegated)
  }

  return {
    sourceGrants,
    delegatedGrants,
  }
}
