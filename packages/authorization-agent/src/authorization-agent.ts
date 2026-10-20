import {
  AdminAuthorization,
  type AdminAuthorizationData,
  type AgentId,
  type AgentOrRoleId,
  type ApplicationRegistrationData,
  type AuthorizationRegistryData,
  type DataAuthorizationData,
  type DataAuthorizationId,
  type DataInstanceData,
  type DataRegistrationData,
  type FinalDataAuthorizationData,
  type GeneratedGrants,
  RegistrySet,
  type RegistrySetData,
  type RoleData,
  // (a2) ShareDataInstanceStructure canonical shape moved verbatim into
  // data-model — re-exported here for source compatibility
  // (see the OpenWiki `data-model/entities.md`)
  type ShareDataInstanceStructure,
  type SocialAgentRegistrationData,
  WebIdProfile,
  type WebIdProfileData,
  dataModelContext,
  getDataGrantIris,
} from '@janeirodigital/interop-data-model'
// re-export so package consumers (components services, tests) keep importing
// it from '@janeirodigital/interop-authorization-agent'
export type { ShareDataInstanceStructure } from '@janeirodigital/interop-data-model'
const loadRegistrySet = loader(RegistrySet.fromJsonLd)
const loadWebIdProfile = loader(WebIdProfile.fromJsonLd)
const loadAdminAuthorization = loader(AdminAuthorization.fromJsonLd)
import {
  INTEROP,
  LDP,
  type WhatwgFetch,
  addStatement,
  discoverAgentRegistration,
  discoverAuthorizationAgent,
  getRegistrySetIri,
  iriForContained,
  linkedIrisJsonLd,
  loader,
  putJsonLd,
  replaceStatement,
  withContext,
} from '@janeirodigital/interop-utils'

import { replaceDataGrants } from './agent-registration.ts'
import { findRegistration as findRegistrationInAgentRegistry } from './agent-registry.ts'
import {
  type AccessAuthorizationStructure,
  type GrantedAuthorization,
  type NestedDataAuthorizationData,
  generateAuthorization,
  generateDataAuthorizations,
  matchesScope,
} from './authorization.ts'
import { loadDataInstance } from './data-instance.ts'
import { generateGrantsForAuthorization } from './grant-generation.ts'
import {
  findApplicationRegistration as findApplicationRegistrationFromSparql,
  findInheritingChildren,
  findSocialAgentInvitation as findInvitationFromSparql,
  findSocialAgentRegistration as findRegistrationFromSparql,
  findRolesWithMember,
  getApplicationRegistration,
  getDataAuthorization as getDataAuthorizationFromSparql,
  getDataRegistration as getDataRegistrationFromSparql,
  getGrantsAuthority,
  getSocialAgentRegistration as getRegistrationFromSparql,
  getRole as getRoleFromSparql,
  listContained,
  localSparqlTransport,
} from './sparql.ts'
import type { SparqlTransport } from './sparql.ts'
interface AuthorizationAgentDependencies {
  fetch: WhatwgFetch
  randomUUID(): string
  /** Internal SPARQL endpoint the session reads registry data from (org-context-sparql.md §2.3). */
  sparqlEndpoint: string
  /**
   * Owner-scoped endpoint allowlist from the internal account storage
   * (`podUrl -> endpoint`, the session owner's records). The session may only
   * read pods in this map; anything else is denied.
   */
  sparqlEndpoints?: Map<string, string>
}

export interface AgentWithAccess {
  agent: string
  dataAuthorization: string
  accessMode: string[]
}

/** How a role is used across authorizations (findRoleUsage). */
export interface RoleUsage {
  usedAsGrantee: boolean
  affectedGrantees: AgentOrRoleId[]
  authorizations: DataAuthorizationId[]
}

/** Authority-relevant fields of a grant removed by a revocation. */
export interface RevokedGrant {
  iri: string
  dataOwner: string
  grantedBy: string
  grantee: string
}

// TODO: adjust if registrations are not / nested in the registry
function registryOfRegistration(dataRegistrationIri: string): string {
  return `${dataRegistrationIri.split('/').slice(0, -2).join('/')}/`
}

function formatAgentWithAccess(dataAuthorization: DataAuthorizationData): AgentWithAccess {
  return {
    agent: dataAuthorization.grantee,
    dataAuthorization: dataAuthorization.id!,
    accessMode: dataAuthorization.accessMode,
  }
}

export class AuthorizationAgent {
  fetch: WhatwgFetch

  /** UUID generator for new resource IRIs (iriForContained). */
  randomUUID: () => string

  /** Internal SPARQL endpoint (shared store) this session reads registry data from. */
  sparqlEndpoint: string

  /** Owner-scoped endpoint allowlist (`podUrl -> endpoint`) from the account storage. */
  sparqlEndpoints: Map<string, string>

  webIdProfile!: WebIdProfileData

  registrySet!: RegistrySetData

  /**
   * Registry sets keyed by webId (C2 of org-admin-feature.md): the session's
   * own is eager-loaded into `registrySet`; every other context's is
   * lazy-resolved on demand via `getRegistrySet` and cached here. Sessions are
   * short-lived (one per request / temporal activity), so this map needs no
   * cross-request invalidation.
   */
  registrySets: Map<string, RegistrySetData> = new Map()

  webId: string

  agentId: string

  registrySetId?: string

  constructor(
    webId: string,
    agentId: string,
    dependencies: AuthorizationAgentDependencies,
    registrySetId?: string
  ) {
    this.webId = webId
    this.agentId = agentId
    this.registrySetId = registrySetId
    this.fetch = dependencies.fetch
    this.randomUUID = dependencies.randomUUID
    this.sparqlEndpoint = dependencies.sparqlEndpoint
    this.sparqlEndpoints = dependencies.sparqlEndpoints ?? new Map()
  }

  /**
   * Resolve a resource/pod IRI to an endpoint the session is allowed to use —
   * longest pod-URL prefix over the account-storage allowlist. `undefined`
   * when the IRI is not under any of the owner's pods (isolation).
   */
  public resolveEndpoint(iri: string): string | undefined {
    let best: string | undefined
    for (const podUrl of this.sparqlEndpoints.keys()) {
      if ((iri === podUrl || iri.startsWith(podUrl)) && (!best || podUrl.length > best.length)) {
        best = podUrl
      }
    }
    return best ? this.sparqlEndpoints.get(best) : undefined
  }

  /** A transport restricted to the session's own pods; throws when not allowed. */
  public sparqlTransportFor(iri: string): SparqlTransport {
    const endpoint = this.resolveEndpoint(iri)
    if (!endpoint) throw new Error(`session is not allowed to read ${iri}`)
    return localSparqlTransport(endpoint)
  }

  /**
   * The context registry's registration of application `registeredAgent`,
   * via the shared SPARQL query — list-and-scan over the application
   * registry's server-managed `ldp:contains` (docs/sparql.md step 3);
   * served per client-id by `AgentIdHandler`. Same query the services'
   * org-context counterpart runs against `/sparql-admin`.
   */
  public async findApplicationRegistration(iri: string, registrySet?: RegistrySetData) {
    return findApplicationRegistrationFromSparql(
      localSparqlTransport(this.sparqlEndpoint),
      (registrySet ?? this.registrySet).hasApplicationRegistry.id,
      iri
    )
  }

  /**
   * The context registry's registration of `registeredAgent`, via the shared
   * SPARQL query — the session reads its own registry through the internal
   * endpoint (docs/sparql.md). The services' org-context counterpart
   * (`findSocialAgentRegistrationInContext` in components) runs the same
   * query against `/sparql-admin`.
   */
  public async findSocialAgentRegistration(registeredAgent: string, registrySet?: RegistrySetData) {
    return findRegistrationFromSparql(
      localSparqlTransport(this.sparqlEndpoint),
      (registrySet ?? this.registrySet).hasSocialAgentRegistry.id,
      registeredAgent
    )
  }

  /**
   * Role by IRI — a single graph read (the role's own graph, keyed by its
   * IRI) via the shared SPARQL query, replacing the previous container
   * scan. The IRI targets the graph directly.
   */
  public async findRole(iri: string): Promise<RoleData | undefined> {
    return getRoleFromSparql(localSparqlTransport(this.sparqlEndpoint), iri)
  }

  /**
   * The invitation with `capabilityUrl` in the context's agent registry, via
   * the shared SPARQL query — the `hasSocialAgentInvitation` listing + one
   * graph read per invitation (docs/sparql.md, invitations candidate; served
   * by `InvitationHandler`). Same query the services run against
   * `/sparql-admin` in org context.
   */
  public async findSocialAgentInvitation(capabilityUrl: string) {
    return findInvitationFromSparql(
      localSparqlTransport(this.sparqlEndpoint),
      this.registrySet.hasInvitationRegistry.id,
      capabilityUrl
    )
  }

  /**
   * The context's data registration for `shapeTree` in `dataRegistryIri` —
   * via the registry plane (docs/sparql.md step 4): `listContained` (the
   * server-managed `ldp:contains` listing) + one `getDataRegistration`
   * graph read per registration. The container IRI targets the graph
   * directly.
   */
  public async findDataRegistration(
    dataRegistryIri: string,
    shapeTree: string
  ): Promise<DataRegistrationData | undefined> {
    const transport = localSparqlTransport(this.sparqlEndpoint)
    let dataRegistration: DataRegistrationData | undefined
    for (const iri of await listContained(transport, dataRegistryIri)) {
      const registration = await getDataRegistrationFromSparql(transport, iri)
      if (registration.registeredShapeTree === shapeTree) {
        dataRegistration = registration
        break
      }
    }
    return dataRegistration
  }

  private async bootstrap(): Promise<void> {
    this.webIdProfile = await loadWebIdProfile(this.webId, this.fetch)
    if (this.registrySetId) {
      this.registrySet = await loadRegistrySet(this.registrySetId, this.fetch)
    }
  }

  /**
   * Resolve the RegistrySet for a webId. The session's own registry set is
   * returned directly; any other webId's is discovered through that agent's
   * authorization-agent (agent-id) document — fetched with this session's
   * (authenticating agent's) fetch — via the admin-only
   * `Link: <registrySet>; rel="interop:hasRegistrySet"` response header
   * (served by AgentIdHandler), then loaded and cached per session.
   *
   * Federated case: the org's authorization agent may live on a different
   * server than the caller's — the org's AA serves the registry-set link and
   * the caller's fetch carries its own credentials, so the link is
   * authoritative across servers.
   */
  public async getRegistrySet(webId: string): Promise<RegistrySetData> {
    if (webId === this.webId) return this.registrySet
    const cached = this.registrySets.get(webId)
    if (cached) return cached
    const authorizationAgentIri = await discoverAuthorizationAgent(webId, this.fetch)
    if (!authorizationAgentIri) {
      throw new Error(`cannot discover authorization agent for ${webId}`)
    }
    const response = await this.fetch(authorizationAgentIri, { method: 'HEAD' })
    if (!response.ok) {
      throw new Error(`failed to fetch authorization agent for ${webId}: ${response.status}`)
    }
    const registrySetId = getRegistrySetIri(response.headers.get('Link') ?? '')
    if (!registrySetId) {
      throw new Error(`${webId} does not expose a registry set to this agent`)
    }
    const registrySet = await loadRegistrySet(registrySetId, this.fetch)
    this.registrySets.set(webId, registrySet)
    return registrySet
  }

  public static async build(
    webId: string,
    agentId: string,
    registrySetId: string,
    dependencies: AuthorizationAgentDependencies
    // TODO: reorder argumets
  ): Promise<AuthorizationAgent> {
    const instance = new AuthorizationAgent(webId, agentId, dependencies, registrySetId)
    await instance.bootstrap()
    return instance
  }

  /*
  /*
   * Sincle solid doesn't provide atomic transactions we should follow this order
   * 1. Create Data Authorizations (or reuse existing when possible)
   * 2. Update Authorization Registry in single request
   *   * a) Remove reference to prior Data Authorizations for the grantee
   *   * b) Add reference to new Data Authorizations
   * TODO: reuse existing Data Authorizations wherever possible - see Data Authorization tests
   */
  public async recordAccessAuthorization(
    authorization: AccessAuthorizationStructure,
    extendIfExists = false
  ): Promise<FinalDataAuthorizationData[]> {
    return generateAuthorization(
      authorization,
      this.webId,
      this.registrySet.hasAuthorizationRegistry,
      { fetch: this.fetch, randomUUID: this.randomUUID },
      extendIfExists,
      this.sparqlEndpoint
    )
  }

  // ──────────────────────────
  // Grant/role match semantics (Phase 4 — moved from temporal activities)
  // ──────────────────────────

  /**
   * The grantees whose authorizations cover `peerId`: authorizations where the
   * peer is the data owner (delegation) and — without `roleId` — All-scope
   * authorizations; grantees equal to the peer are excluded. Deduped and typed
   * (may include roles).
   */
  public async findAffectedGrantees(peerId: string, roleId?: string): Promise<AgentOrRoleId[]> {
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const iris = await listContained(transport, this.registrySet.hasAuthorizationRegistry.id)
    const dataAuthorizations = (
      await Promise.all(iris.map((iri) => getDataAuthorizationFromSparql(transport, iri)))
    ).filter((dataAuthorization) => {
      if (!dataAuthorization.type.includes(INTEROP.DataAuthorization)) return false
      if (dataAuthorization.grantee === peerId) return false
      return (
        dataAuthorization.dataOwner === peerId ||
        (!roleId && dataAuthorization.scopeOfAuthorization === INTEROP.All)
      )
    })
    const grantees: AgentOrRoleId[] = []
    const seen = new Set<string>()
    for (const dataAuthorization of dataAuthorizations) {
      const grantee = dataAuthorization.grantee
      if (seen.has(grantee)) continue
      seen.add(grantee)
      grantees.push(await this.typeGrantee(grantee))
    }
    return grantees
  }

  /** How a role is used across authorizations (single scan). */
  public async findRoleUsage(roleId: string): Promise<RoleUsage> {
    const transport = localSparqlTransport(this.sparqlEndpoint)
    let usedAsGrantee = false
    const affectedGrantees: AgentOrRoleId[] = []
    const authorizations: DataAuthorizationId[] = []
    const seenAuthorizations = new Set<string>()
    const seenGrantees = new Set<string>()
    const iris = await listContained(transport, this.registrySet.hasAuthorizationRegistry.id)
    const dataAuthorizations = await Promise.all(
      iris.map((iri) => getDataAuthorizationFromSparql(transport, iri))
    )
    for (const dataAuthorization of dataAuthorizations) {
      if (!dataAuthorization.type.includes(INTEROP.DataAuthorization)) continue
      const grantee = dataAuthorization.grantee
      const isGranteeMatch = grantee === roleId
      const isDataOwnerMatch = dataAuthorization.dataOwner === roleId && grantee !== roleId
      if (!isGranteeMatch && !isDataOwnerMatch) continue
      if (!seenAuthorizations.has(dataAuthorization.id!)) {
        seenAuthorizations.add(dataAuthorization.id!)
        authorizations.push({ id: dataAuthorization.id, type: dataAuthorization.type })
      }
      if (isGranteeMatch) usedAsGrantee = true
      if (isDataOwnerMatch && !seenGrantees.has(grantee)) {
        seenGrantees.add(grantee)
        affectedGrantees.push(await this.typeGrantee(grantee))
      }
    }
    return { usedAsGrantee, affectedGrantees, authorizations }
  }

  /** Route a grantee by type: Role → its members, agent types → as-is. */
  public async getGrantees(grantee: AgentOrRoleId): Promise<AgentId[]> {
    if (grantee.type.includes(INTEROP.Role)) {
      const role = await this.findRole(grantee.id)
      if (!role) throw new Error(`role not found: ${grantee.id}`)
      return (role.members ?? []).map((member) => ({ id: member, type: [INTEROP.SocialAgent] }))
    }
    return [grantee as AgentId]
  }

  /**
   * Type an agent registration as an AgentId (Application vs SocialAgent).
   */
  private agentIdFromRegistration(
    registration: ApplicationRegistrationData | SocialAgentRegistrationData
  ): AgentId {
    return {
      id: registration.registeredAgent,
      type: registration.type.includes(INTEROP.ApplicationRegistration)
        ? [INTEROP.Application]
        : [INTEROP.SocialAgent],
    }
  }

  /**
   * Type a grantee IRI as `AgentOrRoleId` (agent via the agent registry —
   * social and application registrations — over the registry plane, else role
   * via `getRole`). Public since the payload-contract flip: activity objects
   * carry plain-IRI parties (`authorizationGrantee`/`grantee`), whose kind is
   * resolved here in the store — never baked into the activity.
   */
  public async typeGrantee(iri: string): Promise<AgentOrRoleId> {
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const socialIris = await listContained(transport, this.registrySet.hasSocialAgentRegistry.id)
    for (const registrationIri of socialIris) {
      const registration = await getRegistrationFromSparql(transport, registrationIri)
      if (registration.registeredAgent === iri) return this.agentIdFromRegistration(registration)
    }
    const applicationIris = await listContained(
      transport,
      this.registrySet.hasApplicationRegistry.id
    )
    for (const registrationIri of applicationIris) {
      const registration = await getApplicationRegistration(transport, registrationIri)
      if (registration.registeredAgent === iri) return this.agentIdFromRegistration(registration)
    }
    const role = await this.findRole(iri)
    if (role) return { id: iri, type: [INTEROP.Role] }
    throw new Error('agent or role registration for the grantee does not exist')
  }

  // ──────────────────────────
  // Revocation core (Phase 4 — moved from GrantRevocationHandler)
  // ──────────────────────────

  /**
   * Validate and compute the revocation closure for the given grants: all must
   * share one data owner, the requester must be each grant's grantor
   * (`grantedBy`) or the data owner, and the listed grants plus their
   * inheriting children (fixpoint over `inheritsFromGrant`) are returned.
   * Already-removed grants are absent (idempotent tolerance).
   */
  public async revokeGrants(grants: string[], requesterWebId?: string): Promise<RevokedGrant[]> {
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const loaded = await getGrantsAuthority(transport, grants)

    const dataOwners = new Set([...loaded.values()].map((grant) => grant.dataOwner))
    if (dataOwners.size > 1) {
      throw new Error('all grants must have the same dataOwner')
    }

    // authority per grant, before any deletion: grantor (grantedBy) or owner
    for (const grant of loaded.values()) {
      const isGrantor = requesterWebId === grant.grantedBy
      const isDataOwner = requesterWebId === grant.dataOwner
      if (!isGrantor && !isDataOwner) {
        throw new Error('requester is neither grantor nor the data owner')
      }
    }

    // dependent closure: the listed grants plus their inheriting children
    // (fixpoint over inheritsFromGrant — one level today, recursive-ready)
    const closure = new Map<string, RevokedGrant>()
    for (const [iri, grant] of loaded) closure.set(iri, { iri, ...grant })
    while (true) {
      const children = await findInheritingChildren(transport, [...closure.keys()])
      const fresh = children.filter((child) => !closure.has(child))
      if (fresh.length === 0) break
      for (const [iri, grant] of await getGrantsAuthority(transport, fresh)) {
        closure.set(iri, { iri, ...grant })
      }
    }
    return [...closure.values()]
  }

  /**
   * Clear the given grant IRIs from the grantee's registration `hasDataGrant`
   * links — the requester-hop projection cleanup (formerly
   * `util/registrations.ts removeGrantsFromRegistration`). No-op when the
   * grantee has no registration.
   */
  public async removeGrantsFromRegistration(grantee: string, grants: string[]): Promise<void> {
    const registration = await findRegistrationInAgentRegistry(
      this.registrySet.hasSocialAgentRegistry,
      this.registrySet.hasApplicationRegistry,
      this.fetch,
      grantee
    )
    if (!registration) return // nothing to clear — the projection is already empty
    const revoked = new Set(grants)
    const current = getDataGrantIris(registration)
    await replaceDataGrants(
      registration,
      this.fetch,
      current.filter((iri) => !revoked.has(iri))
    )
  }

  public async generateDataGrants(
    dataAuthorizationIris: string[],
    grantee: string
  ): Promise<GeneratedGrants> {
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const dataAuthorizations = await Promise.all(
      dataAuthorizationIris.map((iri) => getDataAuthorizationFromSparql(transport, iri))
    )
    // data pods from the account-storage allowlist (the registry pod is not a
    // data registry) — the data registrations live in these per-pod datasets
    const dataPodEndpoints = new Map(
      [...this.sparqlEndpoints].filter(([podUrl]) => podUrl !== this.registrySetId)
    )
    return generateGrantsForAuthorization(
      dataAuthorizations,
      this.registrySet,
      grantee,
      { fetch: this.fetch, randomUUID: this.randomUUID },
      transport,
      dataPodEndpoints.size ? dataPodEndpoints : undefined
    )
  }

  // ──────────────────────────
  // AdminAuthorizations (org-admin markers, R1)
  // ──────────────────────────

  /**
   * Record an AdminAuthorization in the given AuthorizationRegistry — PUT via
   * iriForContained (containment is server-managed, matching data
   * authorizations). Defaults to the session's own authorization registry.
   */
  public async recordAdminAuthorization(
    adminAuthorization: Pick<
      AdminAuthorizationData,
      'grantee' | 'grantedBy' | 'scopeOfAuthorization'
    >,
    registry: AuthorizationRegistryData = this.registrySet.hasAuthorizationRegistry
  ): Promise<AdminAuthorizationData> {
    const iri = iriForContained(registry, this.randomUUID)
    const data: AdminAuthorizationData = {
      id: iri,
      type: [INTEROP.AdminAuthorization],
      ...adminAuthorization,
    }
    await putJsonLd(iri, this.fetch, AdminAuthorization.toJsonLd(data), { 'If-None-Match': '*' })
    return data
  }

  /**
   * The AdminAuthorizations in the given AuthorizationRegistry (type-filtered
   * over the `contains` listing; used by the admin RPCs and the syncAdminAcr
   * workflow).
   */
  public async adminAuthorizations(
    registry: AuthorizationRegistryData = this.registrySet.hasAuthorizationRegistry
  ): Promise<AdminAuthorizationData[]> {
    const iris = await linkedIrisJsonLd(registry.id, this.fetch, LDP.contains)
    const result: AdminAuthorizationData[] = []
    for (const iri of iris) {
      const adminAuthorization = await loadAdminAuthorization(iri, this.fetch)
      if (adminAuthorization.type.includes(INTEROP.AdminAuthorization)) {
        result.push(adminAuthorization)
      }
    }
    return result
  }

  /** The AdminAuthorization for a grantee in the given registry, if any. */
  public async findAdminAuthorization(
    grantee: string,
    registry: AuthorizationRegistryData = this.registrySet.hasAuthorizationRegistry
  ): Promise<AdminAuthorizationData | undefined> {
    const authorizations = await this.adminAuthorizations(registry)
    return authorizations.find((authorization) => authorization.grantee === grantee)
  }

  /** Delete an AdminAuthorization resource from the org's AuthorizationRegistry. */
  public async deleteAdminAuthorization(id: string): Promise<void> {
    const response = await this.fetch(id, { method: 'DELETE' })
    if (!response.ok) {
      throw new Error(`failed to delete admin authorization: ${response.status}`)
    }
  }

  // ──────────────────────────
  // Reciprocal registration discovery (peer leg)
  // ──────────────────────────

  /**
   * Discover the peer's reciprocal registration IRI: the registered agent's
   * authorization agent, then its registration of this agent.
   */
  public async discoverReciprocal(data: SocialAgentRegistrationData): Promise<string | null> {
    const authrizationAgentIri = await discoverAuthorizationAgent(data.registeredAgent, this.fetch)
    if (!authrizationAgentIri) return null
    return (await discoverAgentRegistration(authrizationAgentIri, this.fetch)) ?? null
  }

  /** Discover the reciprocal registration and patch the link onto the registration. */
  public async discoverAndUpdateReciprocal(data: SocialAgentRegistrationData): Promise<void> {
    const reciprocalRegistrationIri = await this.discoverReciprocal(data)
    if (!reciprocalRegistrationIri) return
    const doc = withContext(dataModelContext, {
      id: data.id,
      reciprocalRegistration: reciprocalRegistrationIri,
    })
    if (data.reciprocalRegistration) {
      const priorDoc = withContext(dataModelContext, {
        id: data.id,
        reciprocalRegistration: data.reciprocalRegistration,
      })
      await replaceStatement(data.id, this.fetch, priorDoc, doc)
    } else {
      await addStatement(data.id, this.fetch, doc)
    }
    data.reciprocalRegistration = reciprocalRegistrationIri
  }

  public async findAuthorizationsForAgent(peerId: string): Promise<DataAuthorizationData[]> {
    // Registry plane (docs/sparql.md step 2): the authorization listing
    // reuses the same `listContained` + `getDataAuthorization` read
    // `findAgentsWithAccess` performs; role membership is one SELECT
    // (`findRolesWithMember`) — the former HTTP O(N×M) authorizations ×
    // roles sweep is gone. Non-DataAuthorizations (e.g. AdminAuthorizations
    // share the registry container) are type-filtered like the HTTP
    // `dataAuthorizations` iterator did.
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const [iris, roleIris] = await Promise.all([
      listContained(transport, this.registrySet.hasAuthorizationRegistry.id),
      findRolesWithMember(transport, this.registrySet.hasRoleRegistry.id, peerId),
    ])
    const roleIriSet = new Set(roleIris)
    const authorizations = await Promise.all(
      iris.map((iri) => getDataAuthorizationFromSparql(transport, iri))
    )
    return authorizations.filter(
      (dataAuthorization) =>
        dataAuthorization.type.includes(INTEROP.DataAuthorization) &&
        (dataAuthorization.grantee === peerId || roleIriSet.has(dataAuthorization.grantee))
    )
  }

  public async findSocialAgentsWithAccess(
    dataInstanceIri: string,
    ownerWebId = this.webId,
    registrySet = this.registrySet
  ): Promise<AgentWithAccess[]> {
    const agentsWithAccess = await this.findAgentsWithAccess(
      dataInstanceIri,
      ownerWebId,
      registrySet
    )
    const socialAgentsWithAccess: AgentWithAccess[] = []
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const iris = await listContained(transport, registrySet.hasSocialAgentRegistry.id)
    const registrations = await Promise.all(
      iris.map((iri) => getRegistrationFromSparql(transport, iri))
    )
    for (const registration of registrations) {
      const socialAgentWithAccess = agentsWithAccess.find(
        ({ agent }) => agent === registration.registeredAgent
      )
      if (socialAgentWithAccess) {
        socialAgentsWithAccess.push(socialAgentWithAccess)
      }
    }
    return socialAgentsWithAccess
  }

  public async findAgentsWithAccess(
    dataInstanceIri: string,
    ownerWebId = this.webId,
    registrySet = this.registrySet
  ): Promise<AgentWithAccess[]> {
    const dataInstance = await loadDataInstance(dataInstanceIri, this.fetch)
    const shapeTree = dataInstance.dataRegistration!.registeredShapeTree
    const agentsWithAccess: AgentWithAccess[] = []
    // the shared SPARQL listing over the authorization registry (same query
    // the org-context "who has access" uses) instead of the HTTP sweep
    const transport = localSparqlTransport(this.sparqlEndpoint)
    const iris = await listContained(transport, registrySet.hasAuthorizationRegistry.id)
    const authorizations = await Promise.all(
      iris.map((iri) => getDataAuthorizationFromSparql(transport, iri))
    )
    for (const dataAuthorization of authorizations) {
      if (dataAuthorization.registeredShapeTree !== shapeTree) continue
      if (matchesScope(dataAuthorization, dataInstance, ownerWebId)) {
        agentsWithAccess.push(formatAgentWithAccess(dataAuthorization))
      }
    }
    return agentsWithAccess
  }

  private async formatAuthorization(
    agent: string,
    dataInstance: DataInstanceData,
    details: ShareDataInstanceStructure
  ): Promise<GrantedAuthorization> {
    const dataAuthorization: NestedDataAuthorizationData = {
      type: [INTEROP.DataAuthorization],
      grantee: agent,
      grantedBy: this.webId,
      registeredShapeTree: dataInstance.dataRegistration!.registeredShapeTree,
      scopeOfAuthorization: INTEROP.SelectedFromRegistry,
      dataOwner: this.webId, // TODO: delegated authorizations and trusted agents
      hasDataRegistration: dataInstance.dataRegistration!.id,
      accessMode: details.accessMode,
      hasDataInstance: [dataInstance.id],
      children: await Promise.all(
        details.children.map(async (child) => {
          const dataRegistration = await this.findDataRegistration(
            registryOfRegistration(dataInstance.dataRegistration!.id),
            child.shapeTree
          )
          if (!dataRegistration) {
            throw new Error(`no data registration for shape tree ${child.shapeTree}`)
          }
          return {
            type: [INTEROP.DataAuthorization],
            grantee: agent,
            grantedBy: this.webId,
            registeredShapeTree: child.shapeTree,
            scopeOfAuthorization: INTEROP.Inherited,
            dataOwner: this.webId, // TODO: delegated authorizations and trusted agents
            hasDataRegistration: dataRegistration.id,
            accessMode: child.accessMode,
          }
        })
      ),
    }

    return {
      grantee: agent,
      granted: true,
      dataAuthorizations: [dataAuthorization],
    }
  }

  /*
   * Authorizes access to a specific Data Instance to multiple agents
   * TODO: support delegated authorization
   */
  public async shareDataInstance(
    details: ShareDataInstanceStructure,
    ownerWebId?: string
  ): Promise<FinalDataAuthorizationData[]> {
    // ensure owner doesn't grant acces for oneself (class-C fix: filter the
    // *context owner*, not the session's webId)
    // TODO: reconsider for TrustedGrants grantees, compare with data instance owner instead
    const owner = ownerWebId ?? this.webId
    const requestedAgents = details.agents.filter((agent) => agent !== owner)
    // filter out agents who already have access
    // TODO: do we need to adjust once we handle access modes? or require separate operation for such change
    const agentsWithAccess = (await this.findSocialAgentsWithAccess(details.resource)).map(
      (obj) => obj.agent
    )
    const agents = requestedAgents.filter((agent) => !agentsWithAccess.includes(agent))

    // TODO: ensure all agents have social agent registrations, throw error

    const dataInstance = await loadDataInstance(details.resource, this.fetch)
    const authorizations = await Promise.all(
      agents.map(async (agent) => {
        const authorization = await this.formatAuthorization(agent, dataInstance, details)
        return this.recordAccessAuthorization(authorization, true)
      })
    )
    return authorizations.flat()
  }

  /**
   * The build half of `shareDataInstance` (activity-first step 3,
   * authorization-granting.md): compute the DataAuthorizations-to-be for a
   * share selection WITHOUT writing — owner-excluded, already-have-access
   * filtered, ids PRE-MINTED (`generateDataAuthorizations`). The RPC embeds
   * them as one `AuthorizationGranted` per deduped grantee; the
   * `processAuthorizationGranted` workflow materializes them with the
   * context/org session (`getSession(ctx.webId)`) — fixing the org-context
   * debt (`shareDataInstance` wrote against the SESSION's own registry set).
   * `ownerWebId`/`registrySet` are the CONTEXT (the owner), not the session.
   */
  public async buildShareDataAuthorizations(
    details: ShareDataInstanceStructure,
    ownerWebId: string,
    registrySet: RegistrySetData = this.registrySet
  ): Promise<FinalDataAuthorizationData[]> {
    // ensure owner doesn't grant access for oneself (the context owner, not
    // the session's webId)
    const requestedAgents = details.agents.filter((agent) => agent !== ownerWebId)
    // filter out agents who already have access — evaluated from the CONTEXT
    // owner's perspective in the CONTEXT registry
    const agentsWithAccess = (
      await this.findSocialAgentsWithAccess(details.resource, ownerWebId, registrySet)
    ).map((obj) => obj.agent)
    const agents = requestedAgents.filter((agent) => !agentsWithAccess.includes(agent))

    const dataInstance = await loadDataInstance(details.resource, this.fetch)
    const builds = await Promise.all(
      agents.map(async (agent) => {
        const authorization = await this.formatAuthorization(agent, dataInstance, details)
        return generateDataAuthorizations(
          authorization.dataAuthorizations ?? [],
          ownerWebId,
          registrySet.hasAuthorizationRegistry,
          { fetch: this.fetch, randomUUID: this.randomUUID }
        )
      })
    )
    return builds.flat()
  }
}
