import {
  DataRegistration,
  Grant,
  ShapeTree,
  childIris,
  frameDataInstance,
  grantDataInstances,
  grantRegistration,
  grantShapeTree,
} from '@janeirodigital/interop-data-model'
import type { ApplicationRegistrationData, GrantData } from '@janeirodigital/interop-data-model'
const loadGrant = loader(Grant.fromJsonLd)
const loadShapeTree = loader(ShapeTree.fromJsonLd)
const loadDataRegistration = loader(DataRegistration.fromJsonLd)

import { CONTEXT, asScopeTerm, loader } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

/**
 * Whether the application registration has any access grants.
 */
export function getGranted(data: ApplicationRegistrationData): boolean {
  return (data.hasDataGrant ?? []).length > 0
}

/**
 * Fetch all access grants of this application registration.
 */
export async function getAccessGrants(
  data: ApplicationRegistrationData,
  fetch: WhatwgFetch
): Promise<Array<GrantData>> {
  return Promise.all((data.hasDataGrant ?? []).map((id) => loadGrant(id, fetch)))
}

/**
 * Iterate over the ids of the data instances described by this grant.
 * Dispatches based on scopeOfGrant.
 *
 * Application-only domain logic: the former data-model copy was removed and
 * components switched to an authorization-agent SPARQL-backed enumeration, so
 * this is the single home of the iterator.
 */
export async function* getDataInstanceIterator(
  grant: GrantData,
  fetch: WhatwgFetch
): AsyncIterable<string> {
  switch (asScopeTerm(grant.scopeOfGrant)) {
    case CONTEXT.AllFromRegistry: {
      const registration = await loadDataRegistration(grantRegistration(grant), fetch)
      for (const id of registration.contains) {
        yield id
      }
      break
    }
    case CONTEXT.SelectedFromRegistry: {
      for (const id of grantDataInstances(grant)) {
        yield id
      }
      break
    }
    case CONTEXT.Inherited: {
      const parentGrant = await loadGrant(grant.inheritsFromGrant!, fetch)
      for await (const parentId of getDataInstanceIterator(parentGrant, fetch)) {
        yield* await getChildInstanceIris(parentGrant, parentId, grantShapeTree(grant), fetch)
      }
      break
    }
    default:
      throw new Error(`Unknown scope: ${grant.scopeOfGrant}`)
  }
}

/**
 * Child instance ids referenced by a parent instance for a shape tree, via
 * the parent shape tree's reference predicate.
 */
async function getChildInstanceIris(
  parentGrant: GrantData,
  parentId: string,
  childShapeTree: string,
  fetch: WhatwgFetch
): Promise<Array<string>> {
  const parentShapeTree = await loadShapeTree(grantShapeTree(parentGrant), fetch)
  const node = await frameDataInstance(parentId, fetch, parentShapeTree)
  return childIris(node, parentShapeTree, childShapeTree)
}
