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

import { loader, pickLanguage, storageIri } from '@janeirodigital/interop-utils'
import {
  DataInstance,
  DataRegistration,
  DataRegistry as DataRegistrySchema,
  IRI,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'

import type { ResolvedContext } from './Context.js'
import { peerInstanceIris, peerInstanceNode } from './peerProxy.js'
import {
  getDataRegistration as getDataRegistrationFromSparql,
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
    label: await storageIri(registry, ctx.session.fetch),
    registrations,
  })
}

const buildDataRegistryForGrant = async (
  registryIri: string,
  dataGrants: GrantData[],
  descriptionsLang: string,
  ctx: ResolvedContext
) => {
  const seen = new Set<string>()
  const registrations: S.Schema.Type<typeof DataRegistration>[] = []
  for (const dataGrant of dataGrants) {
    if (seen.has(dataGrant.hasDataRegistration)) continue
    seen.add(dataGrant.hasDataRegistration)
    const shapeTree = await loadShapeTree(dataGrant.registeredShapeTree, ctx.session.fetch)
    const shapeTreeDescription = descriptionsLang
      ? await ShapeTree.getDescription(shapeTree, descriptionsLang, ctx.session.fetch)
      : undefined
    registrations.push(
      DataRegistration.make({
        id: IRI.make(dataGrant.hasDataRegistration),
        shapeTree: dataGrant.registeredShapeTree,
        dataRegistry: registryIri,
        label: pickLanguage(shapeTreeDescription?.label, descriptionsLang),
      })
    )
  }
  return DataRegistrySchema.make({
    id: IRI.make(registryIri),
    label: dataGrants[0].hasStorage,
    registrations,
  })
}

function indexFromGrants(dataGrants: GrantData[]): Record<string, GrantData[]> {
  return dataGrants.reduce(
    (acc, dataGrant) => {
      const regIri = Grant.dataRegistryIri(dataGrant)
      if (!acc[regIri]) acc[regIri] = [] as GrantData[]
      acc[regIri].push(dataGrant)
      return acc
    },
    {} as Record<string, GrantData[]>
  )
}

/**
 * The data grants linked from a mirrored reciprocal registration — two queries
 * per registration (link set + all linked bodies) instead of the previous
 * 1 + N. Both contexts go through
 * `sparqlTransportFor`: personal → internal endpoint, org → `/sparql-admin`;
 * peer `.acr`s never grant the admin.
 */
async function reciprocalGrants(ctx: ResolvedContext, reciprocalIri: string): Promise<GrantData[]> {
  return getReciprocalGrants(sparqlTransportFor(ctx), reciprocalIri)
}

/**
 * The data grants the context has for `agentId` (peer branch): the reciprocal
 * of the context's registration of `agentId`, then its linked grants.
 *
 * Fallback scan (kept deliberately — it is load-bearing for delegated chains):
 * a grant naming `agentId` as `dataOwner` can arrive through *another* peer's
 * reciprocal (an onward delegated grant), when the context has no registration
 * of `agentId` at all. Only that per-registration batching was optimised.
 */
async function dataGrantIndexForAgent(
  ctx: ResolvedContext,
  agentId: string
): Promise<Record<string, GrantData[]>> {
  const socialAgentRegistration = await findSocialAgentRegistrationInContext(ctx, agentId)
  const directGrants = socialAgentRegistration?.reciprocalRegistration
    ? await reciprocalGrants(ctx, socialAgentRegistration.reciprocalRegistration)
    : []

  const directIndex = indexFromGrants(directGrants)
  if (Object.keys(directIndex).length > 0) return directIndex

  // fallback: scan every context registration's reciprocal grants for `dataOwner === agentId`
  const scanned: GrantData[] = []
  for (const registration of await listSocialAgentRegistrations(ctx)) {
    if (!registration.reciprocalRegistration) continue
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
  const dataGrantIndex = await dataGrantIndexForAgent(ctx, agentId)
  return Promise.all(
    Object.entries(dataGrantIndex).map(([registryIri, dataGrants]) =>
      buildDataRegistryForGrant(registryIri, dataGrants, descriptionsLang, ctx)
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
    const dataRegistration = await loadDataRegistration(registrationId, ctx.session.fetch)
    for (const dataInstanceIri of dataRegistration.contains) {
      const dataInstance = await loadDataInstance(
        dataInstanceIri,
        ctx.session.fetch,
        undefined,
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
    const socialAgentRegistration = await findSocialAgentRegistrationInContext(ctx, agentId)
    // §2.4 known issue: peer *instance content* stays HTTP and 403s for
    // non-owners; the reciprocal/grant list here resolves via SPARQL
    // (personal: internal endpoint, org: `/sparql-admin`).
    const transport = sparqlTransportFor(ctx)
    const direct = socialAgentRegistration?.reciprocalRegistration
      ? await reciprocalGrants(ctx, socialAgentRegistration.reciprocalRegistration)
      : []
    const dataGrants: GrantData[] = direct.length
      ? direct
      : Object.values(await dataGrantIndexForAgent(ctx, agentId)).flat()
    if (!dataGrants.length) {
      throw new Error(`missing social agent registration: ${agentId}`)
    }
    const seenInstances = new Set<string>()
    for (const dataGrant of dataGrants) {
      if (dataGrant.hasDataRegistration !== registrationId) continue
      if (ctx.webId === ctx.userWebId) {
        for await (const instanceId of dataInstanceIrisForGrant(
          dataGrant,
          transport,
          ctx.session.fetch
        )) {
          if (seenInstances.has(instanceId)) continue
          seenInstances.add(instanceId)
          const dataInstance = await loadDataInstance(
            instanceId,
            ctx.session.fetch,
            dataGrant.registeredShapeTree,
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
        // org context — the admin's session derefs no peer document
        // (403); the org's server fetches peer docs with the org's session
        // via /proxy-admin. Shape trees are public (admin-session fetch).
        const shapeTree = await loadShapeTree(dataGrant.registeredShapeTree, ctx.session.fetch)
        for await (const instanceId of peerInstanceIris(ctx, dataGrant)) {
          if (seenInstances.has(instanceId)) continue
          seenInstances.add(instanceId)
          const node = await peerInstanceNode(ctx, instanceId, shapeTree)
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
