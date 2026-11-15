import {
  getRegistryGrants,
  grantChainValidity,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import {
  Grant,
  type FinalGrantData,
  type GrantData,
  type OdrlPolicy,
} from '@janeirodigital/interop-data-model'
import { INTEROP, LWS } from '@janeirodigital/interop-utils'
import {
  APPLICATION_JSON,
  BadRequestHttpError,
  BasicRepresentation,
  OkResponseDescription,
  ResponseDescription,
} from '@solid/community-server'
import type { OperationHttpHandlerInput } from '@solid/community-server'

import type { SessionManager } from './SessionManager.js'
import { Temporal } from './temporal/client.js'
import { storeGrant } from './temporal/workflows/grants.js'

type HandlerOperation = OperationHttpHandlerInput['operation']

function firstDataOwner(policy: OdrlPolicy): string {
  return policy.permission[0]?.target.owner ?? ''
}

function grantFromPolicy(policy: OdrlPolicy, id: string, envelopeScope: string): FinalGrantData {
  const permission = policy.permission[0]
  const target = permission?.target
  const instances = policy.permission
    .map((candidate) => candidate.target)
    .filter((candidate) => candidate.type.includes('http://www.w3.org/ns/odrl/2/Asset'))
    .map((candidate) => candidate.source[0])
    .filter(Boolean)
  const registration = target?.type.includes(INTEROP.DataRegistration)
    ? target.source[0]
    : (target?.partOf?.[0] ?? '')
  return {
    id,
    type: [LWS.AccessGrant],
    access: [policy],
    scopeOfGrant: policy.scopeOfGrant ?? envelopeScope,
    storage: target?.storage ?? '',
    dataOwner: target?.owner ?? '',
    grantedBy: permission?.assigner ?? '',
    registeredShapeTree: policy.registeredShapeTree ?? '',
    hasDataRegistration: registration,
    ...(instances.length ? { hasDataInstance: instances } : {}),
  }
}

export interface IssueDelegationRequestInput {
  sessionManager: SessionManager
  envelopes: unknown[]
  requesterWebId: string
  /** owner encoded in `/.sai/access-requests/<owner>` */
  expectedDataOwner?: string
  operation: HandlerOperation
}

/**
 * Frozen delegation payload: a top-level array of parent-tree request
 * envelopes. Each policy becomes its own final grant; `inheritsFromGrant`
 * policy links are remapped to the minted HTTPS grant IRIs.
 *
 * The synchronous issued-grants response is the current SAI-profile
 * divergence; a later phase can switch to notification + grant read.
 */
export async function issueDelegationRequest({
  sessionManager,
  envelopes,
  requesterWebId,
  expectedDataOwner,
  operation,
}: IssueDelegationRequestInput): Promise<ResponseDescription> {
  if (envelopes.length === 0) throw new BadRequestHttpError('delegation request is empty')
  const finalGrants: FinalGrantData[] = []
  const dataOwners = new Set<string>()
  for (const raw of envelopes) {
    if (typeof raw !== 'object' || raw === null) {
      throw new BadRequestHttpError('invalid delegation envelope')
    }
    const envelope = raw as Record<string, unknown>
    const tempId = `urn:uuid:${crypto.randomUUID()}`
    const normalized = await Grant.fromJsonLd({ ...envelope, id: tempId }, tempId)
    if (!normalized.access.length) {
      throw new BadRequestHttpError('delegation envelope has no access')
    }
    const byPolicyId = new Map<string, FinalGrantData>()
    for (const policy of normalized.access) {
      const grantId = await sessionManager
        .getSession(firstDataOwner(policy))
        .then((sai) => sai.mintIdentifier(sai.registrySet.hasGrantRegistry.id))
      const grant = grantFromPolicy(policy, grantId, normalized.scopeOfGrant)
      byPolicyId.set(policy.uid ?? policy.id ?? '', grant)
      dataOwners.add(grant.dataOwner)
      finalGrants.push(grant)
    }
    // remap policy-level inheritance to the minted grant IRIs
    for (const policy of normalized.access) {
      const grant = byPolicyId.get(policy.uid ?? policy.id ?? '')
      if (!grant) continue
      if (policy.inheritsFromGrant) {
        grant.inheritsFromGrant = byPolicyId.get(policy.inheritsFromGrant)?.id
      }
    }
    for (const policy of normalized.access) {
      const grant = byPolicyId.get(policy.uid ?? policy.id ?? '')
      if (!grant) continue
      const children = normalized.access
        .filter((candidate) => candidate.inheritsFromGrant === (policy.uid ?? policy.id))
        .map((candidate) => byPolicyId.get(candidate.uid ?? candidate.id ?? '')?.id)
        .filter((id): id is string => Boolean(id))
      if (children.length) grant.hasInheritingGrant = children
    }
  }
  if (dataOwners.size !== 1) {
    throw new BadRequestHttpError('all grants must have the same dataOwner')
  }
  const [dataOwner] = [...dataOwners]
  if (expectedDataOwner && dataOwner !== expectedDataOwner) {
    throw new BadRequestHttpError('invalid dataOwner')
  }
  const sai = await sessionManager.getSession(dataOwner)
  await validateDelegable(finalGrants, requesterWebId, sai)
  await storeFinalGrants(finalGrants)
  return grantResponse(finalGrants, operation)
}

async function storeFinalGrants(finalGrants: FinalGrantData[]): Promise<void> {
  const temporal = new Temporal()
  await temporal.init()
  await temporal.client.workflow.execute(storeGrant, {
    taskQueue: 'create-grants',
    args: [finalGrants],
    workflowId: crypto.randomUUID(),
  })
}

function grantResponse(
  finalGrants: FinalGrantData[],
  operation: HandlerOperation
): ResponseDescription {
  // echo the finalised grants (not just their ids): the grantor stores them
  // as the issuer-side replica `checkEquivalence` reads
  const doc = JSON.stringify(finalGrants)
  const representation = new BasicRepresentation(doc, operation.target, APPLICATION_JSON)
  return new OkResponseDescription(representation.metadata, representation.data)
}

/**
 * Validate the whole request with the C1 chain predicate: every grant's
 * requester must be its `grantedBy`, and the grant must be valid in the
 * data owner's registry once the request's grants are added (so the
 * parent/child request validates as the post-issuance tree). Source grants
 * are not delegated through this endpoint — they are stored by the owner.
 */
async function validateDelegable(
  grants: FinalGrantData[],
  requesterWebId: string,
  sai: Awaited<ReturnType<SessionManager['getSession']>>
): Promise<void> {
  for (const grant of grants) {
    if (requesterWebId !== grant.grantedBy) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('invalid grantedBy')
    }
    if (grant.grantedBy === grant.dataOwner) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('source grants are not delegated')
    }
  }

  const transport = localSparqlTransport(sai.sparqlEndpoint)
  const existing = await getRegistryGrants(transport, sai.registrySet.hasGrantRegistry.id)
  const byId = new Map<string, GrantData>()
  for (const grant of existing) byId.set(grant.id!, grant)
  for (const grant of grants) byId.set(grant.id!, grant)

  const validity = grantChainValidity([...byId.values()])
  for (const grant of grants) {
    if (validity.get(grant.id!) !== true) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('no grant available for delegation')
    }
  }
}
