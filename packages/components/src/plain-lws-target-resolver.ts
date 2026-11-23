import {
  type AuthorizationAgent,
  loadDataInstance,
} from '@janeirodigital/interop-authorization-agent'
import { DataRegistration } from '@janeirodigital/interop-data-model'
import { INTEROP, loader } from '@janeirodigital/interop-utils'
import { BadRequestHttpError } from '@solid/community-server'

import { targetHasType } from './need-based-access-request.js'
import type {
  PlainLwsResolvedTarget,
  PlainLwsTarget,
  PlainLwsTargetResolver,
} from './plain-lws-access-request.js'

const loadDataRegistration = loader(DataRegistration.fromJsonLd)

const ODRL_ASSET = 'http://www.w3.org/ns/odrl/2/Asset'
const ODRL_ASSET_COLLECTION = 'http://www.w3.org/ns/odrl/2/AssetCollection'
const SHAPE_TREE = 'https://www.w3.org/ns/shapetrees#ShapeTree'

async function resolveInstances(
  sai: AuthorizationAgent,
  target: PlainLwsTarget
): Promise<Array<PlainLwsResolvedTarget>> {
  if (target.partOf && target.partOf.length > 1) {
    throw new BadRequestHttpError('an Asset target must name at most one data registration')
  }
  const byRegistration = new Map<string, PlainLwsResolvedTarget>()
  for (const instance of target.source) {
    let data: Awaited<ReturnType<typeof loadDataInstance>>
    try {
      data = await loadDataInstance(instance, sai.fetch, undefined, undefined, target.partOf?.[0])
    } catch (error) {
      throw new BadRequestHttpError(
        `cannot resolve data instance ${instance}: ${(error as Error).message}`
      )
    }
    const registration = data.dataRegistration
    if (!registration) {
      throw new BadRequestHttpError(`data instance ${instance} has no data registration`)
    }
    if (target.partOf?.[0] && target.partOf[0] !== registration.id) {
      throw new BadRequestHttpError(
        `data instance ${instance} is not contained in ${target.partOf[0]}`
      )
    }
    if (
      target.partOf?.[0] &&
      registration.contains.length > 0 &&
      !registration.contains.includes(instance)
    ) {
      throw new BadRequestHttpError(
        `data instance ${instance} is not contained in ${target.partOf[0]}`
      )
    }
    const existing = byRegistration.get(registration.id)
    if (existing) {
      existing.hasDataInstance!.push(instance)
    } else {
      byRegistration.set(registration.id, {
        registeredShapeTree: data.shapeTreeIri,
        hasDataRegistration: registration.id,
        hasDataInstance: [instance],
      })
    }
  }
  return [...byRegistration.values()]
}

async function resolveRegistrations(
  sai: AuthorizationAgent,
  target: PlainLwsTarget
): Promise<Array<PlainLwsResolvedTarget>> {
  const resolved: Array<PlainLwsResolvedTarget> = []
  for (const registrationIri of target.source) {
    let registration: Awaited<ReturnType<typeof loadDataRegistration>>
    try {
      registration = await loadDataRegistration(registrationIri, sai.fetch)
    } catch (error) {
      throw new BadRequestHttpError(
        `cannot resolve data registration ${registrationIri}: ${(error as Error).message}`
      )
    }
    if (!registration.registeredShapeTree) {
      throw new BadRequestHttpError(
        `target ${registrationIri} is not a data registration with a shape tree`
      )
    }
    resolved.push({
      registeredShapeTree: registration.registeredShapeTree,
      hasDataRegistration: registration.id,
    })
  }
  return resolved
}

/**
 * Resolve the plain LWS ODRL target to the SAI need scope using the owner's
 * data view:
 *
 * - `Asset` → each `source` instance's registration + shape tree,
 * - `AssetCollection` + `DataRegistration` → the registration's shape tree,
 * - `AssetCollection` + `ShapeTree` → the shape tree.
 *
 * Container/storage targets cannot be mapped to a shape tree and are rejected;
 * the SAI request profile requires per-resource or registration scope.
 */
export function plainLwsTargetResolver(sai: AuthorizationAgent): PlainLwsTargetResolver {
  return async (target) => {
    if (targetHasType(target.type, 'Asset', ODRL_ASSET)) {
      return resolveInstances(sai, target)
    }
    if (targetHasType(target.type, 'AssetCollection', ODRL_ASSET_COLLECTION)) {
      if (targetHasType(target.type, 'DataRegistration', INTEROP.DataRegistration)) {
        return resolveRegistrations(sai, target)
      }
      if (targetHasType(target.type, 'ShapeTree', SHAPE_TREE)) {
        return target.source.map((shapeTree) => ({ registeredShapeTree: shapeTree }))
      }
      throw new BadRequestHttpError(
        'cannot derive a shape tree from a container/storage target; use Asset, AssetCollection+DataRegistration, or AssetCollection+ShapeTree'
      )
    }
    throw new BadRequestHttpError('plain LWS access target must be an Asset or an AssetCollection')
  }
}
