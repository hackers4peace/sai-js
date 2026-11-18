import { QueryEngine } from '@comunica/query-sparql-rdfjs'
import { ShapeTree } from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)

import {
  ACCESS_ACTIONS,
  INTEROP,
  LWS,
  ODRL,
  ODRL_ID_JAG_CONTEXT,
  loader,
  toStore,
} from '@janeirodigital/interop-utils'
import type { Quad } from '@rdfjs/types'
import { arrayifyStream } from '@solid/community-server'
import type { StorageLocationStrategy } from '@solid/community-server'
import type {
  Credentials,
  PermissionMap,
  PermissionReport,
  PolicyEngine,
} from '@solidlab/policy-engine'
import { ACP, PERMISSIONS } from '@solidlab/policy-engine'
import { type IBindings, SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { getLoggerFor } from 'global-logger-factory'
import { DataFactory, Store } from 'n3'

import type { PodEndpointStore } from './PodEndpointStore.js'
import type { SaiAuthorizationManager } from './SaiAuthorizationManager.js'

enum TargetType {
  Registry = 'Registry',
  Registration = 'Registration',
  Resource = 'Resource',
}

/** The token-carried credential fields of the LWS access-claim profile. */
type AccessClaimCredentials = Credentials & {
  access?: unknown
  accessContext?: string
  storage?: string
  /** Storage authority minted by this server's exchange (`owner`/`admin`). */
  scope?: string[]
}

/** The grant identity a registry lookup matches; public grants use ACP's public actors. */
interface GrantIdentity {
  agent: string
  client: string
}

const PUBLIC_IDENTITY: GrantIdentity = {
  agent: ACP.PublicAgent,
  client: ACP.PublicClient,
}

const { namedNode } = DataFactory

export class SaiPermissionsEngine implements PolicyEngine {
  private readonly logger = getLoggerFor(this)
  private readonly queryEngine = new QueryEngine()

  constructor(
    protected readonly manager: SaiAuthorizationManager,
    private readonly storageStrategy: StorageLocationStrategy,
    private readonly endpointStore: PodEndpointStore
  ) {}

  /** The dataset that holds the resource's own graph (data pod). */
  private async resolvePodEndpoint(resourceId: string): Promise<string | undefined> {
    let podUrl: string
    try {
      podUrl = (await this.storageStrategy.getStorageIdentifier({ path: resourceId })).path
    } catch {
      // not under any pod — no data pod to query
      return undefined
    }
    const record = await this.endpointStore.findSparqlByPodUrl(podUrl)
    return record?.endpoint
  }
  /**
   * Returns the granted and denied permissions for the given input.
   *
   * @param target - Identifier of the targeted resource.
   * @param credentials - Credentials identifying who or what is trying to access the target resource.
   */
  async getPermissions(target: string, credentials: Credentials): Promise<PermissionMap> {
    // A claim always wins over a scope: an owner/admin who presents a narrower
    // claim gets exactly that claim, never the broad scope.
    const claimData = await this.findAccessClaimData(target, credentials)
    if (claimData !== undefined) return this.getClaimPermissions(target, credentials, claimData)

    const { scope: rawScope } = credentials as AccessClaimCredentials
    const scope = new Set(
      Array.isArray(rawScope)
        ? rawScope.filter((value): value is string => typeof value === 'string')
        : []
    )
    if (scope.has('owner')) return this.permissionMap(Object.values(ACCESS_ACTIONS))
    // Admin access is read-only; writing needs a normal access claim.
    if (scope.has('admin')) return this.permissionMap([ACCESS_ACTIONS.read])
    // Claimless, scopeless tokens are never issued for a data storage. Deny
    // rather than falling back to registry or public matching (D10/D22).
    return this.permissionMap([])
  }

  /**
   * Public grants are credential-independent (D24) and read-only. They are
   * evaluated in `PublicPermissionReader`, never as a fallback for a claim or a
   * scope.
   */
  async getPublicPermissions(target: string): Promise<PermissionMap> {
    let data: Awaited<ReturnType<SaiAuthorizationManager['getAuthorizationData']>>
    try {
      data = await this.manager.getAuthorizationData(target)
    } catch (error: unknown) {
      // Fail closed on a registry-store outage.
      this.logger.warn(`could not read public grants for ${target}: ${(error as Error).message}`)
      return this.permissionMap([])
    }
    if (!data) return this.permissionMap([])
    const quads: Quad[] = Array.isArray(data) ? data : [...data]
    return this.evaluateTarget(target, quads, PUBLIC_IDENTITY, (parent) =>
      this.getPublicPermissions(parent)
    )
  }

  /**
   * Only granted modes are reported. A `false` would be an explicit denial in
   * `UnionPermissionReader` and would veto the credential-independent public
   * reader; an absent mode is denied by the LDP authorization by default.
   */
  private permissionMap(modes: string[]): PermissionMap {
    const permissions: PermissionMap = {}
    if (modes.includes(ACCESS_ACTIONS.create)) {
      permissions[PERMISSIONS.Create] = true
      // LDP POST on a container asks for Append, which is separate from Create.
      permissions[PERMISSIONS.Append] = true
    }
    if (modes.includes(ACCESS_ACTIONS.read)) permissions[PERMISSIONS.Read] = true
    if (modes.includes(ACCESS_ACTIONS.modify)) permissions[PERMISSIONS.Modify] = true
    if (modes.includes(ACCESS_ACTIONS.delete)) permissions[PERMISSIONS.Delete] = true
    return permissions
  }

  /**
   * The token-carried ODRL claim, converted to the same `lws:access` graph the
   * registry path evaluates. Returns `undefined` when the credentials have no
   * claim, and an empty graph when the claim is malformed or for another
   * storage — a token with an `access` claim never falls back to broad registry
   * matching (D10).
   */
  private async findAccessClaimData(
    target: string,
    credentials: Credentials
  ): Promise<Quad[] | undefined> {
    const { access, accessContext } = credentials as AccessClaimCredentials
    if (access === undefined) return undefined
    if (accessContext !== ODRL_ID_JAG_CONTEXT) return []

    try {
      const policies = Array.isArray(access) ? access : [access]
      const store = await toStore({ '@context': accessContext, '@graph': policies })
      const storages = new Set(
        store.getObjects(null, namedNode(LWS.storage), null).map((term) => term.value)
      )
      const storage = await this.manager.getStorage(target)
      if (storages.size !== 1 || !storage || [...storages][0] !== storage) return []

      // The registry evaluator looks up policies through an `lws:access` edge;
      // the token claim is just the policy graph. Give every policy its own
      // synthetic grant root so a match reads only that policy's actions, and
      // mirror `inheritsFromGrant` onto the root for `findInheritedModes`.
      // Claim-internal parent references point at policy ids; remap them to the
      // parent policy's synthetic root so inheritance stays in the claim graph.
      const claimPolicies = [...store.getSubjects(namedNode(ODRL.permission), null, null)]
      const rootByPolicy = new Map<string, string>()
      claimPolicies.forEach((policy, index) => {
        const root = `urn:sai:ld:access-claim:${index}`
        for (const ref of [policy, ...store.getObjects(policy, namedNode(ODRL.uid), null)]) {
          if (ref.termType === 'NamedNode') rootByPolicy.set(ref.value, root)
        }
      })
      claimPolicies.forEach((policy, index) => {
        const grant = namedNode(`urn:sai:ld:access-claim:${index}`)
        store.addQuad(grant, namedNode(LWS.access), policy)
        for (const inherited of store.getObjects(
          policy,
          namedNode(INTEROP.inheritsFromGrant),
          null
        )) {
          const mapped = rootByPolicy.get(inherited.value) ?? inherited.value
          store.addQuad(grant, namedNode(INTEROP.inheritsFromGrant), namedNode(mapped))
        }
      })
      return [...store]
    } catch (error: unknown) {
      this.logger.warn(`Ignoring an unparseable ODRL access claim: ${error}`)
      return []
    }
  }

  /**
   * Claim evaluation: the access token was issued by this server's AS after
   * verifying the ID-JAG, so the claim is the only authority. Identity fields
   * are not re-matched here; target/scope/action are checked, including
   * inheritance among policies carried by the token. No admin grant, registry
   * fallback, or public fallback applies.
   */
  private async getClaimPermissions(
    target: string,
    credentials: Credentials,
    data: Quad[]
  ): Promise<PermissionMap> {
    return this.evaluateTarget(target, data, undefined, (parent) =>
      this.getPermissions(parent, credentials)
    )
  }

  /** Evaluate one grant graph (a token claim or a public registry grant). */
  private async evaluateTarget(
    target: string,
    data: Quad[],
    identity: GrantIdentity | undefined,
    parentPermissions: (id: string) => Promise<PermissionMap>
  ): Promise<PermissionMap> {
    const targetType = await this.determineTargetType(target)
    let modes: string[] = []
    switch (targetType) {
      case TargetType.Registry:
        modes = await this.findRegistrationModes(data, target, identity)
        break
      case TargetType.Registration: {
        // An Inherited grant covers its registration too: creating a new
        // member (POST to the registration container) happens *before* the
        // parent instance links it, so the parent-instance gate of
        // `findInheritedModes` can not apply here — the grant's access modes
        // on the registration are what authorizes the append.
        const inheritedGrant = await this.findGrant(data, target, INTEROP.Inherited, identity)
        modes = [
          ...new Set([
            ...(await this.findRegistrationModes(data, target, identity)),
            ...(inheritedGrant ? await this.getAccessModes(data, inheritedGrant) : []),
          ]),
        ]
        break
      }
      case TargetType.Resource: {
        const resourceModes = await this.findResourceModes(data, target, identity)
        const registryModes = await this.findRegistrationModes(
          data,
          (await this.getRegistrationId(target)) ?? target,
          identity
        )
        const inheritedModes = await this.findInheritedModes(
          data,
          target,
          identity,
          parentPermissions
        )
        modes = [...new Set([...resourceModes, ...registryModes, ...inheritedModes])]
        break
      }
      default:
        throw new Error(`unexpected IRI: ${target}`)
    }
    return this.permissionMap(modes)
  }

  /**
   * Returns the granted and denied permissions for the given input.
   * This also generates a report describing why permissions were granted or denied.
   */
  getPermissionsWithReport(): Promise<PermissionReport> {
    throw new Error('do not use')
  }

  async getAccessModes(data: Quad[], grantId: string): Promise<string[]> {
    const store = new Store([...data])
    const modesQuery = `
    SELECT ?action WHERE {
      <${grantId}> <${LWS.access}> ?policy .
      ?policy <${ODRL.permission}> ?permission .
      ?permission <${ODRL.action}> ?action .
    }
  `
    const modesBindingsStream = await this.queryEngine.queryBindings(modesQuery, {
      sources: [store],
    })
    const modesBindings = await modesBindingsStream.toArray()
    return modesBindings
      .map((b) => b.get('action')?.value)
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
  }

  // Inherited is the same as AllFromRegistry here
  async findGrant(
    data: Quad[],
    id: string,
    scope: string,
    identity?: GrantIdentity
  ): Promise<string | undefined> {
    let registrationId = id
    const selected = scope === INTEROP.SelectedFromRegistry
    if (selected) {
      registrationId = (await this.getRegistrationId(id)) ?? id
    }
    const store = new Store([...data])
    const grantQuery = `
      SELECT * WHERE {
        ?s
          <${LWS.access}> ?policy .
        ?policy
          <${INTEROP.scopeOfGrant}> <${scope}> ;
          <${ODRL.permission}> ?permission .
        ?permission <${ODRL.target}> ?target .
        ${
          selected
            ? `?target <${ODRL.source}> <${id}> .
               ?target <${ODRL.partOf}> <${registrationId}> .`
            : `?target <${ODRL.source}> <${registrationId}> .`
        }
        ${
          identity
            ? `?permission <${ODRL.assigner}> <${identity.agent}> .
               ?permission <${ODRL.assignee}> <${identity.client}> .`
            : ''
        }
      }
    `
    const grantBindingsStream = await this.queryEngine.queryBindings(grantQuery, {
      sources: [store],
    })
    const grantBindings = await grantBindingsStream.toArray()
    // TODO: handle multiple valid grants
    return grantBindings[0]?.get('s')?.value
  }

  async findRegistrationModes(
    data: Quad[],
    registrationId: string,
    identity?: GrantIdentity
  ): Promise<string[]> {
    const grantId = await this.findGrant(data, registrationId, INTEROP.AllFromRegistry, identity)
    if (!grantId) return []
    return this.getAccessModes(data, grantId)
  }

  async findResourceModes(
    data: Quad[],
    resourceId: string,
    identity?: GrantIdentity
  ): Promise<string[]> {
    const grantId = await this.findGrant(data, resourceId, INTEROP.SelectedFromRegistry, identity)
    if (!grantId) return []
    return this.getAccessModes(data, grantId)
  }

  async findInheritedModes(
    data: Quad[],
    resourceId: string,
    identity: GrantIdentity | undefined,
    parentPermissions: (id: string) => Promise<PermissionMap>
  ): Promise<string[]> {
    const registrationId = (await this.getRegistrationId(resourceId)) ?? resourceId
    const grantId = await this.findGrant(data, registrationId, INTEROP.Inherited, identity)
    if (!grantId) return []
    const parentGrantId = await this.findObject(data, grantId, INTEROP.inheritsFromGrant)
    if (!parentGrantId) throw new Error(`parent not found for Inherited grant: ${grantId}`)
    // TODO: consider multi parent, and parents of different types
    const parentResourceId = await this.findParentResource(data, grantId, parentGrantId, resourceId)
    if (!parentResourceId) return []
    const parentResourcePermissions = await parentPermissions(parentResourceId)
    if (parentResourcePermissions[PERMISSIONS.Read]) {
      return this.getAccessModes(data, grantId)
    }
    return []
  }

  async findObject(data: Quad[], subject: string, predicate: string): Promise<string | undefined> {
    const query = `
      SELECT * WHERE {
        <${subject}>
          <${predicate}> ?o .
      }
    `
    const store = new Store([...data])
    const bindingsStream = await this.queryEngine.queryBindings(query, {
      sources: [store],
    })
    const bindings = await bindingsStream.toArray()
    return bindings[0].get('o')?.value
  }

  async findPolicyObject(
    data: Quad[],
    grantId: string,
    predicate: string
  ): Promise<string | undefined> {
    const query = `
      SELECT * WHERE {
        <${grantId}> <${LWS.access}> ?policy .
        ?policy <${predicate}> ?o .
      }
    `
    const store = new Store([...data])
    const bindingsStream = await this.queryEngine.queryBindings(query, {
      sources: [store],
    })
    const bindings = await bindingsStream.toArray()
    return bindings[0]?.get('o')?.value
  }

  async findGrantTarget(
    data: Quad[],
    grantId: string
  ): Promise<{ source?: string; partOf?: string }> {
    const query = `
      SELECT ?source ?partOf WHERE {
        <${grantId}> <${LWS.access}> ?policy .
        ?policy <${ODRL.permission}> ?permission .
        ?permission <${ODRL.target}> ?target .
        OPTIONAL { ?target <${ODRL.source}> ?source }
        OPTIONAL { ?target <${ODRL.partOf}> ?partOf }
      }
    `
    const store = new Store([...data])
    const bindingsStream = await this.queryEngine.queryBindings(query, {
      sources: [store],
    })
    const bindings = await bindingsStream.toArray()
    return {
      source: bindings[0]?.get('source')?.value,
      partOf: bindings[0]?.get('partOf')?.value,
    }
  }

  async findParentResource(
    data: Quad[],
    childGrantId: string,
    parentGrantId: string,
    resourceId: string
  ): Promise<string> {
    // find predicate
    const parentShapeTreeId = await this.findPolicyObject(
      data,
      parentGrantId,
      INTEROP.registeredShapeTree
    )
    if (!parentShapeTreeId) throw new Error(`invalid grant, missing shapeTree: ${parentGrantId}`)
    const childShapeTreeId = await this.findPolicyObject(
      data,
      childGrantId,
      INTEROP.registeredShapeTree
    )
    if (!childShapeTreeId) throw new Error(`invalid grant, missing shapeTree: ${childGrantId}`)
    const shapeTree = await loadShapeTree(parentShapeTreeId, fetch)
    const shapeTreeReference = shapeTree.references.find(
      (stRef) => stRef.shapeTree === childShapeTreeId
    )
    const predicate = shapeTreeReference.viaPredicate.value
    const endpoint = await this.resolvePodEndpoint(resourceId)
    if (!endpoint) return
    const fetcher = new SparqlEndpointFetcher()
    const bindingsStream = await fetcher.fetchBindings(
      endpoint,
      `
          SELECT * WHERE {
            GRAPH ?g {?s <${predicate}> <${resourceId}> }
          }
        `
    )
    const results = await arrayifyStream<IBindings>(bindingsStream)
    // TODO: ensure only in proper registration
    const parentId = results[0]?.['s'].value
    if (!parentId) return
    // check if in parent registration
    const parentTarget = await this.findGrantTarget(data, parentGrantId)
    // The target of a SelectedFromRegistry grant is an `odrl:Asset` whose
    // `odrl:source` is the selected instance and whose `odrl:partOf` is the
    // containing registration. Only AssetCollection targets (AllFromRegistry,
    // Inherited) have the registration as `source` too, so prefer `partOf`.
    const parentRegistrationId = parentTarget.partOf ?? parentTarget.source
    // TODO: not needed if query only in proper registration
    const actualParent = await this.getRegistrationId(parentId)
    if (actualParent !== parentRegistrationId)
      throw new Error(`something fishy - ${parentId} not in ${parentRegistrationId}`)
    return parentId
  }

  /**
   * The registration that contains a data instance. Flat data pods store the
   * parent as `lws:partOf` metadata; the path-based parent remains the
   * data-side fallback for hierarchical data pods. Registry containment is
   * metadata-only (flat members), so this is never used for registry members.
   */
  private async getRegistrationId(id: string): Promise<string | undefined> {
    return (await this.getParentFromStore(id)) ?? this.manager.getParent(id)
  }

  /** Reads `lws:partOf` from the target's metadata graph in its data pod. */
  private async getParentFromStore(id: string): Promise<string | undefined> {
    const endpoint = await this.resolvePodEndpoint(id)
    if (!endpoint) return undefined
    const fetcher = new SparqlEndpointFetcher()
    const bindingsStream = await fetcher.fetchBindings(
      endpoint,
      `SELECT ?parent WHERE { GRAPH ?g { <${id}> <${LWS.partOf}> ?parent } }`
    )
    const bindings = await arrayifyStream<IBindings>(bindingsStream)
    return bindings[0]?.parent.value
  }

  /** The RDF types of a resource, read from its data pod. */
  private async getResourceTypes(id: string): Promise<string[]> {
    const endpoint = await this.resolvePodEndpoint(id)
    if (!endpoint) return []
    const fetcher = new SparqlEndpointFetcher()
    const bindingsStream = await fetcher.fetchBindings(
      endpoint,
      `SELECT DISTINCT ?type WHERE { GRAPH ?g { <${id}> a ?type } }`
    )
    const bindings = await arrayifyStream<IBindings>(bindingsStream)
    return bindings.map((binding) => binding.type.value)
  }

  async determineTargetType(id: string): Promise<TargetType | undefined> {
    const storage = await this.manager.getStorage(id)
    if (id === storage) {
      return TargetType.Registry
    }
    const types = await this.getResourceTypes(id)
    if (types.includes(INTEROP.DataRegistration)) {
      return TargetType.Registration
    }
    // Flat storage: the registration is the `lws:partOf` parent, not the path
    // parent. Registry members are flat too, so containment is metadata-only.
    const parent = await this.getParentFromStore(id)
    if (parent === storage) {
      return TargetType.Registration
    }
    if (parent) {
      const grandParent = await this.getParentFromStore(parent)
      if (grandParent === storage) {
        return TargetType.Resource
      }
    }
    // Unknown or auxiliary resource (e.g. `.lws/...`): return Resource so the
    // permission check denies instead of throwing.
    return TargetType.Resource
  }
}
