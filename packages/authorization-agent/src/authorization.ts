import type {
  AccessNeedGroupData,
  AuthorizationRegistryData,
  AuthorizationStructure,
  DataAuthorizationData,
  DataInstanceData,
  FinalDataAuthorizationData,
} from '@janeirodigital/interop-data-model'
// (a2) the AuthorizationStructure/DataAuthorizationStructure canonical shapes
// moved verbatim into data-model — re-exported here for source compatibility
// (see the OpenWiki `data-model/entities.md`).
export type {
  AuthorizationStructure,
  DataAuthorizationStructure,
} from '@janeirodigital/interop-data-model'
import { DataAuthorization } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  type WhatwgFetch,
  iriForContained,
  putJsonLd,
} from '@janeirodigital/interop-utils'

import {
  getDataAuthorization as getDataAuthorizationFromSparql,
  listContained,
  localSparqlTransport,
} from './sparql.ts'
import type { DataModelDependencies } from './types.ts'

// Nesting is being used to capture inheritance before IRIs are available
export type NestedDataAuthorizationData = DataAuthorizationData & {
  children?: DataAuthorizationData[]
}

interface BaseAuthorization {
  grantee: string
  hasAccessNeedGroup?: string
}

export interface GrantedAuthorization extends BaseAuthorization {
  dataAuthorizations: DataAuthorizationData[]
  granted: true
}

export interface DeniedAuthorization extends BaseAuthorization {
  dataAuthorizations?: never
  granted: false
}

export type AccessAuthorizationStructure = GrantedAuthorization | DeniedAuthorization

/**
 * Whether a data authorization grants access to the given data instance — the
 * shared scope-match rule (formerly duplicated between the session's
 * `findAgentsWithAccess` and components' `agentsWithAccessMatching`).
 */
export function matchesScope(
  authorization: DataAuthorizationData,
  resource: DataInstanceData,
  ownerWebId: string
): boolean {
  switch (authorization.scopeOfAuthorization) {
    case INTEROP.All:
      return true
    case INTEROP.AllFromAgent:
      return authorization.dataOwner === ownerWebId
    case INTEROP.AllFromRegistry:
      return authorization.hasDataRegistration === resource.dataRegistration?.id
    case INTEROP.SelectedFromRegistry:
      return (
        authorization.hasDataRegistration === resource.dataRegistration?.id &&
        (authorization.hasDataInstance ?? []).includes(resource.id)
      )
    default:
      throw new Error(
        `encountered incorrect Data Authorization with scope:${authorization.scopeOfAuthorization}`
      )
  }
}

// ──────────────────────────
// Authorization structure (domain-shaped: the components adapter maps the
// api-messages `Authorization` — scope short-names and RPC field naming — to
// this; the rules below build the NestedDataAuthorizationData)
// ──────────────────────────
/**
 * Build the nested data authorizations for a granted authorization structure:
 * the SAI rules — scope → INTEROP mapping, `dataOwner` assignment (only for
 * scopes below All/Inherited), one-level inheritance wiring via
 * `inheritsFromNeed` — formerly components `buildDataAuthorizations`.
 */
export function buildNestedDataAuthorizations(
  structure: AuthorizationStructure,
  accessNeedGroup: AccessNeedGroupData,
  grantedBy: string
): NestedDataAuthorizationData[] {
  const structuredDataAuthorizations = (structure.dataAuthorizations ?? []).map(
    (dataAuthorization) => {
      const accessNeed = accessNeedGroup.accessNeeds
        .flatMap((need) => [need, ...(need.children ?? [])])
        .find((need) => need.id === dataAuthorization.accessNeed)
      if (!accessNeed) {
        throw new Error(`missing access need: ${dataAuthorization.accessNeed}`)
      }
      const saiReady: DataAuthorizationData = {
        type: [INTEROP.DataAuthorization],
        satisfiesAccessNeed: accessNeed.id,
        grantee: structure.grantee,
        grantedBy,
        registeredShapeTree: accessNeed.registeredShapeTree,
        scopeOfAuthorization: dataAuthorization.scopeOfAuthorization,
        accessMode: accessNeed.accessMode,
      }
      if (
        saiReady.scopeOfAuthorization !== INTEROP.All &&
        saiReady.scopeOfAuthorization !== INTEROP.Inherited
      ) {
        saiReady.dataOwner = dataAuthorization.dataOwner
      }
      if (saiReady.scopeOfAuthorization === INTEROP.AllFromRegistry) {
        saiReady.hasDataRegistration = dataAuthorization.hasDataRegistration
      } else if (saiReady.scopeOfAuthorization === INTEROP.SelectedFromRegistry) {
        saiReady.hasDataRegistration = dataAuthorization.hasDataRegistration
        saiReady.hasDataInstance = dataAuthorization.hasDataInstance
      }
      return saiReady
    }
  )
  const parents: NestedDataAuthorizationData[] = []
  const children: DataAuthorizationData[] = []
  for (const structuredDataAuthorization of structuredDataAuthorizations) {
    if (structuredDataAuthorization.scopeOfAuthorization === INTEROP.Inherited) {
      children.push(structuredDataAuthorization)
    } else {
      parents.push(structuredDataAuthorization)
    }
  }
  return parents.map((parentDataAuthorization) => {
    // add children for each parent
    const inheritingDataAuthorizations = children
      .filter((childDataAuthorization) => {
        const accessNeed = accessNeedGroup.accessNeeds
          .flatMap((need) => [need, ...(need.children ?? [])])
          .find((need) => need.id === childDataAuthorization.satisfiesAccessNeed)!

        return accessNeed.inheritsFromNeed === parentDataAuthorization.satisfiesAccessNeed
      })
      .map((child) => ({ ...child, dataOwner: parentDataAuthorization.dataOwner }))
    if (inheritingDataAuthorizations.length) {
      return { ...parentDataAuthorization, children: inheritingDataAuthorizations }
    }
    return parentDataAuthorization
  })
}

/**
 * Build FinalDataAuthorizationData POJOs, assigning IRIs from the authorization
 * registry and wiring children via hasInheritingAuthorization.
 */
export async function generateDataAuthorizations(
  dataAuthorizations: NestedDataAuthorizationData[],
  grantedBy: string,
  authorizationRegistry: AuthorizationRegistryData,
  deps: DataModelDependencies
): Promise<FinalDataAuthorizationData[]> {
  // don't create data authorization where grantee == dataowner
  const validDataAuthorizations = dataAuthorizations.filter(
    (dataAuthorization) => dataAuthorization.dataOwner !== dataAuthorization.grantee
  )

  const result: FinalDataAuthorizationData[] = []
  for (const dataAuthorization of validDataAuthorizations) {
    const dataAuthorizationIri = iriForContained(authorizationRegistry, deps.randomUUID)
    const children: FinalDataAuthorizationData[] = []
    if (dataAuthorization.children) {
      for (const childDataAuthorization of dataAuthorization.children) {
        const childDataAuthorizationIri = iriForContained(authorizationRegistry, deps.randomUUID)
        children.push({
          ...childDataAuthorization,
          id: childDataAuthorizationIri,
          inheritsFromAuthorization: dataAuthorizationIri,
          grantedBy,
        })
      }
    }
    result.push(
      {
        ...dataAuthorization,
        id: dataAuthorizationIri,
        hasInheritingAuthorization: children.map((child) => child.id),
        grantedBy,
      },
      ...children
    )
  }
  return result
}

/**
 * Delete the grantee's data authorization resources (parents and their
 * hasInheritingAuthorization children) whose IRI is not in irisToKeep.
 * Containment is server-managed (ldp:contains), so kept authorizations stay
 * linked to the registry without any client-side link management.
 */
export async function replaceDataAuthorizationsForGrantee(
  registry: AuthorizationRegistryData,
  existingDataAuthorizations: DataAuthorizationData[],
  irisToKeep: string[],
  fetch: WhatwgFetch
): Promise<void> {
  const keep = new Set(irisToKeep)
  // children of kept parents must stay too (the kept parent still references them)
  for (const dataAuthorization of existingDataAuthorizations) {
    if (keep.has(dataAuthorization.id!)) {
      for (const child of dataAuthorization.hasInheritingAuthorization ?? []) keep.add(child)
    }
  }
  const irisToDelete = new Set(
    existingDataAuthorizations.flatMap((da) => [da.id!, ...(da.hasInheritingAuthorization ?? [])])
  ).difference(keep)
  // Change back to Promise.all after the CSS bug is fixed.
  for (const iri of irisToDelete) {
    const response = await fetch(iri, { method: 'DELETE' })
    if (!response.ok) {
      throw new Error(`failed to delete data authorization: ${response.status}`)
    }
  }
}

/**
 * Create (and store) data authorizations for an authorization structure. The
 * registry's containment (ldp:contains) is server-managed: storing a data
 * authorization via PUT adds it to the registry, and deleting the resource
 * removes it.
 *
 * - granted: builds and stores FinalDataAuthorizationData POJOs (with reuse of
 *   existing data authorizations when extendIfExists), deletes existing data
 *   authorization resources which are not reused, returns the stored list.
 * - denied: deletes all of the grantee's existing data authorization resources,
 *   returns [].
 */
/**
 * Store pre-built DataAuthorization resources at their embedded ids
 * (activity-first granting, authorization-granting.md Step 2) — find-first
 * idempotent (a retry/reconcile re-run sees the resource and skips).
 * Containment is server-managed (ldp:contains) so a PUT into the registry
 * container links the members.
 */
export async function storeDataAuthorizations(
  dataAuthorizations: FinalDataAuthorizationData[],
  deps: DataModelDependencies
): Promise<void> {
  // Re-link children to parents BEFORE storage (the activity-first write
  // path, authorization-granting.md): the FRAMED activity drops the
  // parent's `@reverse` `hasInheritingAuthorization` (embedded nodes cannot
  // resolve reverse terms — activity-registry.test.ts documents the loss),
  // so the parents arrive without their child list. The CHILD's forward
  // `inheritsFromAuthorization` survives and is the re-link source — the
  // "re-links them in the store" the write path always intended.
  const childrenByParent = new Map<string, FinalDataAuthorizationData[]>()
  for (const dataAuthorization of dataAuthorizations) {
    if (!dataAuthorization.inheritsFromAuthorization) continue
    const siblings = childrenByParent.get(dataAuthorization.inheritsFromAuthorization) ?? []
    siblings.push(dataAuthorization)
    childrenByParent.set(dataAuthorization.inheritsFromAuthorization, siblings)
  }
  for (const dataAuthorization of dataAuthorizations) {
    const children = childrenByParent.get(dataAuthorization.id)
    if (children && dataAuthorization.hasInheritingAuthorization?.length === 0) {
      dataAuthorization.hasInheritingAuthorization = children.map((child) => child.id)
    }
  }
  for (const dataAuthorization of dataAuthorizations) {
    const existing = await deps.fetch(dataAuthorization.id, { method: 'HEAD' })
    if (existing.status === 200) continue
    await putJsonLd(
      dataAuthorization.id,
      deps.fetch,
      DataAuthorization.toJsonLd(dataAuthorization),
      { 'If-None-Match': '*' }
    )
  }
}

export async function generateAuthorization(
  authorization: AccessAuthorizationStructure,
  grantedBy: string,
  authorizationRegistry: AuthorizationRegistryData,
  deps: DataModelDependencies,
  extendIfExists: boolean,
  /** Internal SPARQL endpoint of the session recording the authorization. */
  sparqlEndpoint: string
): Promise<FinalDataAuthorizationData[]> {
  if (extendIfExists && !authorization.granted) {
    throw new Error('Previous denied authorizations can not be extended')
  }

  // the grantee's existing data authorizations via the shared SPARQL listing
  // (same query as the org-context "who has access" read) instead of the
  // HTTP sweep; AdminAuthorizations in the same container are framed
  // tolerantly and filtered out by type
  const transport = localSparqlTransport(sparqlEndpoint)
  const containedIris = await listContained(transport, authorizationRegistry.id)
  const contained = await Promise.all(
    containedIris.map((iri) => getDataAuthorizationFromSparql(transport, iri))
  )
  const existingDataAuthorizations = contained
    .filter((da) => da.type.includes(INTEROP.DataAuthorization))
    .filter((da) => da.grantee === authorization.grantee)

  // TODO: agent has and access authorization, with data authorization (SelectedFromRegistry) which does not include this data instance
  // do we need to check access modes? (if same extend data authorization, if different create a new one)
  const dataAuthorizationsToReuse: string[] = []
  if (extendIfExists && authorization.granted) {
    // start with reusing all existing data authorizations
    dataAuthorizationsToReuse.push(...existingDataAuthorizations.map((da) => da.id!))

    // TODO: case when new doesn't have inheriting but matching had inheriting data grant, create additional data authorization instead of replacing
    // check if some of existing data authorizations overlap for a registry
    for (const existingDataAuthorization of existingDataAuthorizations) {
      const matchingDataAuthorization = authorization.dataAuthorizations.find(
        (da) => existingDataAuthorization.hasDataRegistration === da.hasDataRegistration
      )
      if (matchingDataAuthorization) {
        // TODO: should we handle it differently
        if (matchingDataAuthorization.scopeOfAuthorization !== INTEROP.SelectedFromRegistry)
          throw new Error(`unexpected scope: ${matchingDataAuthorization.scopeOfAuthorization}`)

        // copy over selected instances from existing data authorization
        // TODO: check for duplicates (make it a set?)
        matchingDataAuthorization.hasDataInstance = [
          ...(matchingDataAuthorization.hasDataInstance ?? []),
          ...(existingDataAuthorization.hasDataInstance ?? []),
        ]

        // exclude from data authorization to reuse
        const irisToExclude = [
          existingDataAuthorization.id!,
          ...(existingDataAuthorization.hasInheritingAuthorization ?? []),
        ]
        for (const iri of irisToExclude) {
          const index = dataAuthorizationsToReuse.indexOf(iri)
          if (index !== -1) dataAuthorizationsToReuse.splice(index, 1)
        }
      }
    }
  }

  let dataAuthorizations: FinalDataAuthorizationData[] = []
  if (authorization.granted) {
    dataAuthorizations = await generateDataAuthorizations(
      authorization.dataAuthorizations,
      grantedBy,
      authorizationRegistry,
      deps
    )

    // store data authorizations — raw JSON-LD PUT (expanded form, see putJsonLd)
    for (const dataAuthorization of dataAuthorizations) {
      await putJsonLd(
        dataAuthorization.id,
        deps.fetch,
        DataAuthorization.toJsonLd(dataAuthorization),
        { 'If-None-Match': '*' }
      )
    }

    // delete the grantee's existing data authorization resources which are not reused
    await replaceDataAuthorizationsForGrantee(
      authorizationRegistry,
      existingDataAuthorizations,
      dataAuthorizationsToReuse,
      deps.fetch
    )
  } else {
    // denied authorization: delete all of the grantee's existing data authorization resources
    await replaceDataAuthorizationsForGrantee(
      authorizationRegistry,
      existingDataAuthorizations,
      [],
      deps.fetch
    )
  }

  return dataAuthorizations
}
