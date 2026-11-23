import { dataInstanceIrisForGrant } from '@janeirodigital/interop-authorization-agent'
import { loadDataInstance } from '@janeirodigital/interop-authorization-agent'
import type { GrantData } from '@janeirodigital/interop-data-model'
import {
  DataRegistration as DataRegistrationModel,
  Grant,
  ShapeTree,
  labelFromNode,
} from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)
const loadDataRegistration = loader(DataRegistrationModel.fromJsonLd)

import { loader, lwsStorageRoot, pickLanguage } from '@janeirodigital/interop-utils'
import {
  DataInstance,
  DataRegistration,
  DataRegistry as DataRegistrySchema,
  IRI,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import { peerInstanceIris, peerInstanceNode } from './peerData.js'
import {
  getDataRegistration as getDataRegistrationFromSparql,
  contextPod,
  getReciprocalGrants,
  listContained,
  sparqlTransportFor,
  sparqlTransportForPod,
} from './queries/org.js'
import {
  findSocialAgentRegistrationInContext,
  listSocialAgentRegistrations,
} from './SocialAgentRegistry.js'

const buildDataRegistry = async (
  registry: { id: string },
  descriptionsLang: string,
  ctx: ResolvedContext
) => {
  // the data registry's container + registration graphs live in the data pod's
  // own dataset, not the registry pod's — the registry transport would list
  // nothing (the per-pod split). Resolve the pod-specific endpoint through the
  // context allowlist (personal: session, org: `/sparql-admin?pod=`).
  const transport = sparqlTransportForPod(ctx, registry.id)
  const iris = await listContained(transport, registry.id)
  const registrations: S.Schema.Type<typeof DataRegistration>[] = []
  for (const iri of iris) {
    const registration = await getDataRegistrationFromSparql(transport, iri)
    const shapeTree = await loadShapeTree(registration.registeredShapeTree, ctx.session.fetch)
    const shapeTreeDescription = descriptionsLang
      ? await ShapeTree.getDescription(shapeTree, descriptionsLang, ctx.session.fetch)
      : undefined
    registrations.push(
      DataRegistration.make({
        id: IRI.make(registration.id),
        shapeTree: registration.registeredShapeTree,
        dataRegistry: registry.id,
        count: (registration.contains ?? []).length,
        label: pickLanguage(shapeTreeDescription?.label, descriptionsLang),
      })
    )
  }
  return DataRegistrySchema.make({
    id: IRI.make(registry.id),
    // the registry label is its storage root, resolved through the LWS
    // storage description; a pod that does not advertise one falls back to the
    // registry IRI (label only — nothing is stored with it)
    label: (await lwsStorageRoot(registry.id, ctx.session.fetch)) ?? registry.id,
    registrations,
  })
}

const buildDataRegistryForGrant = async (
  registryIri: string,
  accessGrants: GrantData[],
  descriptionsLang: string,
  ctx: ResolvedContext
) => {
  const seen = new Set<string>()
  const registrations: S.Schema.Type<typeof DataRegistration>[] = []
  for (const accessGrant of accessGrants) {
    if (seen.has(accessGrant.hasDataRegistration)) {
      continue
    }
    seen.add(accessGrant.hasDataRegistration)
    const shapeTree = await loadShapeTree(accessGrant.registeredShapeTree, ctx.session.fetch)
    const shapeTreeDescription = descriptionsLang
      ? await ShapeTree.getDescription(shapeTree, descriptionsLang, ctx.session.fetch)
      : undefined
    registrations.push(
      DataRegistration.make({
        id: IRI.make(accessGrant.hasDataRegistration),
        shapeTree: accessGrant.registeredShapeTree,
        dataRegistry: registryIri,
        label: pickLanguage(shapeTreeDescription?.label, descriptionsLang),
      })
    )
  }
  return DataRegistrySchema.make({
    id: IRI.make(registryIri),
    label: registryIri,
    registrations,
  })
}

function indexFromGrants(accessGrants: GrantData[]): Record<string, GrantData[]> {
  return accessGrants.reduce(
    (acc, accessGrant) => {
      const regIri = Grant.dataRegistryIri(accessGrant)
      if (!acc[regIri]) {
        acc[regIri] = [] as GrantData[]
      }
      acc[regIri].push(accessGrant)
      return acc
    },
    {} as Record<string, GrantData[]>
  )
}

/**
 * The access grants linked from a mirrored reciprocal registration — two queries
 * per registration (link set + all linked bodies) instead of the previous
 * 1 + N. Both contexts go through
 * `sparqlTransportFor`: personal → internal endpoint, org → `/sparql-admin`;
 * peer `.acr`s never grant the admin.
 */
async function reciprocalGrants(ctx: ResolvedContext, reciprocalIri: string): Promise<GrantData[]> {
  return getReciprocalGrants(sparqlTransportFor(ctx), reciprocalIri)
}

/**
 * The access grants the context has for `agentId` (peer branch): the reciprocal
 * of the context's registration of `agentId`, then its linked grants.
 *
 * Fallback scan (kept deliberately — it is load-bearing for delegated chains):
 * a grant naming `agentId` as `dataOwner` can arrive through *another* peer's
 * reciprocal (an onward delegated grant), when the context has no registration
 * of `agentId` at all. Only that per-registration batching was optimised.
 */
async function accessGrantIndexForAgent(
  ctx: ResolvedContext,
  agentId: string
): Promise<Record<string, GrantData[]>> {
  const socialAgentRegistration = await findSocialAgentRegistrationInContext(ctx, agentId)
  const directGrants = socialAgentRegistration?.reciprocalRegistration
    ? await reciprocalGrants(ctx, socialAgentRegistration.reciprocalRegistration)
    : []

  const directIndex = indexFromGrants(directGrants)
  if (Object.keys(directIndex).length > 0) {
    return directIndex
  }

  // fallback: scan every context registration's reciprocal grants for `dataOwner === agentId`
  const scanned: GrantData[] = []
  for (const registration of await listSocialAgentRegistrations(ctx)) {
    if (!registration.reciprocalRegistration) {
      continue
    }
    const grants = await reciprocalGrants(ctx, registration.reciprocalRegistration)
    scanned.push(...grants.filter((grant) => grant.dataOwner === agentId))
  }
  return indexFromGrants(scanned)
}

export const getDataRegistries = async (
  ctx: ResolvedContext,
  agentId: string,
  descriptionsLang: string
) => {
  if (agentId === ctx.webId) {
    return Promise.all(
      ctx.registrySet.hasDataRegistry.map((registry) =>
        buildDataRegistry(registry, descriptionsLang, ctx)
      )
    )
  }
  const accessGrantIndex = await accessGrantIndexForAgent(ctx, agentId)
  return Promise.all(
    Object.entries(accessGrantIndex).map(([registryIri, accessGrants]) =>
      buildDataRegistryForGrant(registryIri, accessGrants, descriptionsLang, ctx)
    )
  )
}

export const listDataInstances = async (
  ctx: ResolvedContext,
  agentId: string,
  registrationId: string,
  descriptionsLang = 'en'
) => {
  const dataInstances = []
  if (agentId === ctx.webId) {
    if (ctx.webId === ctx.userWebId) {
      const dataRegistration = await loadDataRegistration(registrationId, ctx.session.fetch)
      for (const dataInstanceIri of dataRegistration.contains) {
        const dataInstance = await loadDataInstance(
          dataInstanceIri,
          ctx.session.fetch,
          undefined,
          descriptionsLang,
          dataRegistration.id
        )
        dataInstances.push(
          DataInstance.make({
            id: IRI.make(dataInstance.id),
            label: dataInstance.label,
          })
        )
      }
    } else {
      // org context — the admin's session holds no grants on the org's data
      // pod (isolation): membership comes from the context plane
      // (`/sparql-admin?pod=`) and the instance content is read with the
      // admin's own credential, which the org's storage exchange turns into
      // the read-only `scope: admin` — the same read `GetResource` makes
      // (`orgContextDataInstance`).
      const podUrl = contextPod(ctx, registrationId)
      if (!podUrl) {
        throw new Error(`data registration ${registrationId} is outside the context`)
      }
      const transport = sparqlTransportForPod(ctx, podUrl)
      const dataRegistration = await getDataRegistrationFromSparql(transport, registrationId)
      const shapeTree = await loadShapeTree(dataRegistration.registeredShapeTree, ctx.session.fetch)
      for (const dataInstanceIri of dataRegistration.contains ?? []) {
        const node = await peerInstanceNode(ctx, podUrl, dataInstanceIri, shapeTree)
        dataInstances.push(
          DataInstance.make({
            id: IRI.make(dataInstanceIri),
            label: labelFromNode(node),
          })
        )
      }
    }
  } else {
    const socialAgentRegistration = await findSocialAgentRegistrationInContext(ctx, agentId)
    // §2.4 known issue: peer *instance content* stays HTTP and 403s for
    // non-owners; the reciprocal/grant list here resolves via SPARQL
    // (personal: internal endpoint, org: `/sparql-admin`).
    const transport = sparqlTransportFor(ctx)
    const direct = socialAgentRegistration?.reciprocalRegistration
      ? await reciprocalGrants(ctx, socialAgentRegistration.reciprocalRegistration)
      : []
    const accessGrants: GrantData[] = direct.length
      ? direct
      : Object.values(await accessGrantIndexForAgent(ctx, agentId)).flat()
    if (!accessGrants.length) {
      throw new Error(`missing social agent registration: ${agentId}`)
    }
    const seenInstances = new Set<string>()
    for (const accessGrant of accessGrants) {
      if (accessGrant.hasDataRegistration !== registrationId) {
        continue
      }
      if (ctx.webId === ctx.userWebId) {
        for await (const instanceId of dataInstanceIrisForGrant(
          accessGrant,
          transport,
          ctx.session.fetch
        )) {
          if (seenInstances.has(instanceId)) {
            continue
          }
          seenInstances.add(instanceId)
          const dataInstance = await loadDataInstance(
            instanceId,
            ctx.session.fetch,
            accessGrant.registeredShapeTree,
            descriptionsLang
          )
          dataInstances.push(
            DataInstance.make({
              id: IRI.make(dataInstance.id),
              label: dataInstance.label,
            })
          )
        }
      } else {
        // org context — the admin's session derefs no peer document (403);
        // the context's storage fetch performs the read-only org impersonation
        // for the grant's storage. Shape trees are public (admin-session fetch).
        const shapeTree = await loadShapeTree(accessGrant.registeredShapeTree, ctx.session.fetch)
        for await (const instanceId of peerInstanceIris(ctx, accessGrant)) {
          if (seenInstances.has(instanceId)) {
            continue
          }
          seenInstances.add(instanceId)
          const node = await peerInstanceNode(ctx, accessGrant.storage, instanceId, shapeTree)
          dataInstances.push(
            DataInstance.make({
              id: IRI.make(instanceId),
              label: labelFromNode(node),
            })
          )
        }
      }
    }
  }

  return dataInstances
}
