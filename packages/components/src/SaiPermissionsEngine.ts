import { QueryEngine } from '@comunica/query-sparql-rdfjs'
import { ShapeTree } from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)

import {
  ACCESS_ACTIONS,
  INTEROP,
  LWS,
  ODRL,
  discoverAuthorizationAgent,
  loader,
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
import { Store } from 'n3'

import type { PodEndpointStore } from './PodEndpointStore.js'
import type { SaiAuthorizationManager } from './SaiAuthorizationManager.js'

enum TargetType {
  Registry = 'Registry',
  Registration = 'Registration',
  Resource = 'Resource',
}

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
    // check if reqested by User Authorization Server
    let uasId: string | undefined
    if (credentials.agent && credentials.client) {
      try {
        uasId = await discoverAuthorizationAgent(credentials.agent, fetch)
      } catch (err) {
        this.logger.error(`UAS discovery failed for: ${credentials.agent}; ${err}`)
      }
    }
    const uas = uasId && uasId === credentials.client

    // TODO: does it need spread or just fix in typings
    const authorizationData = [...(await this.manager.getAuthorizationData(target))]
    const targetType = await this.determineTargetType(target)
    let modes: string[] = []
    switch (targetType) {
      case TargetType.Registry:
        // admins hold a Read-only DataRegistry-scoped AdminGrant per storage
        // (R1 / step 2.8 of org-admin-feature.md) — lets them list/read the
        // org's data registries; structural registries stay on ACP
        modes = await this.findAdminModes(authorizationData, credentials)
        break
      case TargetType.Registration: {
        // An Inherited grant covers its registration too: creating a new
        // member (POST to the registration container) happens *before* the
        // parent instance links it, so the parent-instance gate of
        // `findInheritedModes` can not apply here — the grant's access modes
        // on the registration are what authorizes the append.
        const inheritedGrant = await this.findGrant(
          authorizationData,
          target,
          credentials,
          INTEROP.Inherited,
          uas
        )
        modes = [
          ...new Set([
            ...(await this.findRegistrationModes(authorizationData, target, credentials, uas)),
            ...(inheritedGrant ? await this.getAccessModes(authorizationData, inheritedGrant) : []),
            ...(await this.findAdminModes(authorizationData, credentials)),
          ]),
        ]
        break
      }
      case TargetType.Resource:
        // could happen read on all and write on selected
        {
          const resourceModes = await this.findResourceModes(
            authorizationData,
            target,
            credentials,
            uas
          )
          const registryModes = await this.findRegistrationModes(
            authorizationData,
            (await this.getRegistrationId(target)) ?? target,
            credentials,
            uas
          )
          const inheritedModes = await this.findInheritedModes(
            authorizationData,
            target,
            credentials,
            uas
          )
          modes = [
            ...new Set([
              ...resourceModes,
              ...registryModes,
              ...inheritedModes,
              ...(await this.findAdminModes(authorizationData, credentials)),
            ]),
          ]
        }
        break
      default:
        throw new Error(`unexpected IRI: ${target}`)
    }
    return {
      [PERMISSIONS.Create]: modes.includes(ACCESS_ACTIONS.create),
      // TODO: figure out why it is requested on Create
      [PERMISSIONS.Append]: modes.includes(ACCESS_ACTIONS.create),
      [PERMISSIONS.Read]: modes.includes(ACCESS_ACTIONS.read),
      [PERMISSIONS.Modify]: modes.includes(ACCESS_ACTIONS.modify),
      [PERMISSIONS.Delete]: modes.includes(ACCESS_ACTIONS.delete),
    }
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

  /**
   * The requester's Read-only DataRegistry-scoped AdminGrant for the target's
   * storage (R1 / step 2.8 of org-admin-feature.md). `authorizationData` is
   * already filtered by `getAuthorizationData` to grants with `storage` = the
   * target's storage, so matching `AdminGrant` + policy assignee +
   * `scopeOfAdminGrant DataRegistry` here identifies an admin of *this*
   * storage. Returns the grant's `access[].action`s (Read-only in the seed —
   * the design keeps admins read-only through the data service; structural
   * registries stay on ACP).
   */
  async findAdminModes(data: Quad[], credentials: Credentials): Promise<string[]> {
    const agent = credentials.agent
    if (!agent) return []
    const store = new Store([...data])
    const adminGrantQuery = `
      SELECT * WHERE {
        ?s
          a <${INTEROP.AdminGrant}> ;
          <${INTEROP.scopeOfAdminGrant}> <${INTEROP.DataRegistry}> ;
          <${LWS.access}> ?policy .
        ?policy <${ODRL.permission}> ?permission .
        ?permission <${ODRL.assignee}> <${agent}> .
      }
    `
    const bindingsStream = await this.queryEngine.queryBindings(adminGrantQuery, {
      sources: [store],
    })
    const bindings = await bindingsStream.toArray()
    const adminGrantId = bindings[0]?.get('s')?.value
    if (!adminGrantId) return []
    return this.getAccessModes(data, adminGrantId)
  }

  // Inherited is the same as AllFromRegistry here
  async findGrant(
    data: Quad[],
    id: string,
    credentials: Credentials,
    scope: string,
    uas: boolean
  ): Promise<string | undefined> {
    let registrationId = id
    const selected = scope === INTEROP.SelectedFromRegistry
    if (selected) {
      registrationId = (await this.getRegistrationId(id)) ?? id
    }
    let { agent, client } = credentials
    if (!agent || !client) {
      agent = ACP.PublicAgent
      client = ACP.PublicClient
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
          uas
            ? `?permission <${ODRL.assignee}> <${agent}> .`
            : `
            ?permission <${INTEROP.requester}> <${agent}> .
            ?permission <${ODRL.assignee}> <${client}> .
          `
        }
      }
    `
    const grantBindingsStream = await this.queryEngine.queryBindings(grantQuery, {
      sources: [store],
    })
    const grantBindings = await grantBindingsStream.toArray()
    // TODO: handle multiple valid grants
    const grantId = grantBindings[0]?.get('s')?.value
    if (grantId) return grantId
    // if not found try without credentials
    if (credentials.agent && credentials.client) return this.findGrant(data, id, {}, scope, false)
  }
  async findRegistrationModes(
    data: Quad[],
    registrationId: string,
    credentials: Credentials,
    uas: boolean
  ): Promise<string[]> {
    const grantId = await this.findGrant(
      data,
      registrationId,
      credentials,
      INTEROP.AllFromRegistry,
      uas
    )
    if (!grantId) return []
    return this.getAccessModes(data, grantId)
  }

  async findResourceModes(
    data: Quad[],
    resourceId: string,
    credentials: Credentials,
    uas: boolean
  ): Promise<string[]> {
    const grantId = await this.findGrant(
      data,
      resourceId,
      credentials,
      INTEROP.SelectedFromRegistry,
      uas
    )
    if (!grantId) return []
    return this.getAccessModes(data, grantId)
  }

  async findInheritedModes(
    data: Quad[],
    resourceId: string,
    credentials: Credentials,
    uas: boolean
  ): Promise<string[]> {
    const registrationId = (await this.getRegistrationId(resourceId)) ?? resourceId
    const grantId = await this.findGrant(data, registrationId, credentials, INTEROP.Inherited, uas)
    if (!grantId) return []
    const parentGrantId = await this.findObject(data, grantId, INTEROP.inheritsFromGrant)
    if (!parentGrantId) throw new Error(`parent not found for Inherited grant: ${grantId}`)
    // TODO: consider multi parent, and parents of different types
    const parentResourceId = await this.findParentResource(data, grantId, parentGrantId, resourceId)
    if (!parentResourceId) return []
    const parentResourcePermissions = await this.getPermissions(parentResourceId, credentials)
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
