import {
  INTEROP,
  LWS,
  ODRL,
  ODRL_ID_JAG_CONTEXT,
  RDF,
  SHAPETREES,
  toStore,
} from '@janeirodigital/interop-utils'
import type { Term } from '@rdfjs/types'
import { BadRequestHttpError } from '@solid/community-server'
import { DataFactory } from 'n3'
import type { Store } from 'n3'

const { namedNode } = DataFactory

const GRANT_SCOPES = new Set<string>([
  INTEROP.SelectedFromRegistry,
  INTEROP.AllFromRegistry,
  INTEROP.Inherited,
  INTEROP.AllFromAgent,
])

export interface VerifiedAccessClaim {
  /** The compact JSON-LD policies exactly as they go into the token. */
  access: Array<unknown>
  /** The JSON-LD context of {@link access}. */
  context: string
  /** The single storage every target of the claim is bound to. */
  storage: string
  /** Legacy `odrl:assigner` values; ID-JAG claims no longer carry one. */
  assigners: Array<string>
  /** Every `odrl:assignee` of the claim (the token subject for an ID-JAG). */
  assignees: Array<string>
}

/** Options for {@link verifyAccessClaim}. */
export interface VerifyAccessClaimOptions {
  /** Expected assignee; an ID-JAG passes its `sub` here. */
  assignee?: string
}

function badRequest(message: string): never {
  throw new BadRequestHttpError(`Invalid ODRL access claim: ${message}`)
}

function oneIri(store: Store, subject: Term, predicate: string, what: string): string {
  const values = store.getObjects(subject, namedNode(predicate), null)
  if (values.length !== 1 || values[0].termType !== 'NamedNode') {
    badRequest(`${what} needs exactly one IRI value.`)
  }
  return values[0].value
}

function iriValues(store: Store, subject: Term, predicate: string, what: string): Array<string> {
  const values = store.getObjects(subject, namedNode(predicate), null)
  if (values.length === 0 || values.some((term) => term.termType !== 'NamedNode')) {
    badRequest(`${what} needs at least one IRI value.`)
  }
  return values.map((term) => term.value)
}

/**
 * Verifies the ODRL `access` claim of an ID-JAG / access token.
 *
 * Only the `access` subtree is expanded as JSON-LD — the surrounding JWT
 * payload contains OAuth claims that are not RDF terms. The context has to be
 * the bundled {@link ODRL_ID_JAG_CONTEXT}, so verification never fetches a
 * remote context, and the claim has to describe exactly one storage: an
 * ID-JAG is valid for one storage and carries no `resource` claim.
 *
 * @param access - Compact JSON-LD ODRL policies.
 * @param context - Top-level `@context` claim of the token.
 * @param expectedStorage - The storage a RAS is trading the grant for, when known.
 * @param options - Expected assignee, if the claim is bound to a token subject.
 */
export async function verifyAccessClaim(
  access: unknown,
  context: unknown,
  expectedStorage?: string,
  options: VerifyAccessClaimOptions = {}
): Promise<VerifiedAccessClaim> {
  if (context !== ODRL_ID_JAG_CONTEXT) {
    badRequest(`the JSON-LD context needs to be ${ODRL_ID_JAG_CONTEXT}.`)
  }
  if (!Array.isArray(access) || access.length === 0) {
    badRequest('the access claim needs to be a non-empty array of ODRL policies.')
  }

  let store: Store
  try {
    store = await toStore({ '@context': context, '@graph': access })
  } catch (error: unknown) {
    badRequest((error as Error).message)
  }

  const policyNodes = new Set(store.getSubjects(namedNode(ODRL.permission), null, null))
  if (policyNodes.size === 0) {
    badRequest('at least one ODRL policy with a permission is required.')
  }
  for (const policy of policyNodes) {
    oneIri(store, policy, ODRL.profile, 'odrl:profile')
    const scope = oneIri(store, policy, INTEROP.scopeOfGrant, 'interop:scopeOfGrant')
    if (!GRANT_SCOPES.has(scope)) {
      badRequest(`${scope} is not a supported grant scope.`)
    }
    if (store.getObjects(policy, namedNode(INTEROP.registeredShapeTree), null).length > 0) {
      badRequest('interop:registeredShapeTree belongs on the target, not the policy.')
    }
  }

  const permissions = store.getObjects(null, namedNode(ODRL.permission), null)
  const assigners = new Set<string>()
  const assignees = new Set<string>()
  const targets = new Set<string>()
  for (const permission of permissions) {
    // `odrl:assigner` is no longer part of an ID-JAG claim. Keep accepting it
    // on legacy claims, but never require it here.
    const permissionAssigners = store.getObjects(permission, namedNode(ODRL.assigner), null)
    if (permissionAssigners.length > 1) {
      badRequest('odrl:assigner needs at most one IRI value.')
    }
    for (const assigner of permissionAssigners) {
      if (assigner.termType !== 'NamedNode') {
        badRequest('odrl:assigner needs an IRI value.')
      }
      assigners.add(assigner.value)
    }
    assignees.add(oneIri(store, permission, ODRL.assignee, 'odrl:assignee'))
    iriValues(store, permission, ODRL.action, 'odrl:action')
    for (const target of iriValues(store, permission, ODRL.target, 'odrl:target')) {
      targets.add(target)
    }
  }
  if (targets.size === 0) {
    badRequest('at least one odrl:target is required.')
  }
  if (options.assignee !== undefined) {
    if (assignees.size !== 1 || !assignees.has(options.assignee)) {
      badRequest(`the claim needs to be assigned to ${options.assignee}.`)
    }
  }

  const storages = new Set<string>()
  for (const target of targets) {
    storages.add(oneIri(store, namedNode(target), LWS.storage, 'lws:storage'))
    oneIri(store, namedNode(target), INTEROP.dataOwner, 'interop:dataOwner')
    iriValues(store, namedNode(target), ODRL.source, 'odrl:source')

    const types = store
      .getObjects(namedNode(target), namedNode(RDF.type), null)
      .map((term) => term.value)
    // Every target is scoped to a shape tree, including the AllFromAgent
    // party target; a shape-tree target names it as its source instead.
    if (!types.includes(SHAPETREES.ShapeTree)) {
      oneIri(store, namedNode(target), INTEROP.registeredShapeTree, 'interop:registeredShapeTree')
    }
    // A selected instance target names its registration explicitly;
    // AssetCollection + DataRegistration targets use the source.
    if (types.includes(ODRL.Asset)) {
      oneIri(store, namedNode(target), INTEROP.hasDataRegistration, 'interop:hasDataRegistration')
    }
  }
  if (storages.size !== 1) {
    badRequest('every target needs to be bound to the same lws:storage.')
  }
  const [storage] = [...storages]
  if (expectedStorage !== undefined && storage !== expectedStorage) {
    badRequest(`the claim is for ${storage}, not the requested storage ${expectedStorage}.`)
  }

  return {
    access,
    context,
    storage,
    assigners: [...assigners],
    assignees: [...assignees],
  }
}

/** Fields that identify the hidden delegation edge rather than the permission. */
const freshId = (): string => `urn:uuid:${crypto.randomUUID()}`

const HIDDEN_CLAIM_FIELDS = new Set([
  'id',
  'uid',
  'act',
  'requester',
  'inheritsFromGrant',
  'hasInheritingGrant',
])

/**
 * Remove grant/node identifiers and hidden claim fields from a claim subtree.
 * Used by the impersonation hop: the final token must not expose the hidden
 * delegatee or resolvable grant references.
 */
function sanitizeClaimNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeClaimNode)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (HIDDEN_CLAIM_FIELDS.has(key)) {
      continue
    }
    result[key] = sanitizeClaimNode(nested)
  }
  return result
}

function cloneClaimNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneClaimNode)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      cloneClaimNode(nested),
    ])
  )
}

/**
 * Remove every `assigner` and make the claim assigned to `assignee`, keeping
 * the grant/node identifiers. Used for the first ID-JAG, where the claim is
 * still the grant-derived policy but the wire shape must not expose an
 * assigner.
 */
export function setAccessClaimAssignee(access: Array<unknown>, assignee: string): Array<unknown> {
  return access.map((raw) => {
    const policy = cloneClaimNode(raw) as Record<string, unknown>
    delete policy.assigner
    policy.assignee = assignee
    if (Array.isArray(policy.permission)) {
      policy.permission = policy.permission.map((rawPermission) => {
        const permission = rawPermission as Record<string, unknown>
        delete permission.assigner
        permission.assignee = assignee
        return permission
      })
    }
    return policy
  })
}

/**
 * Re-issue an ODRL access claim under the visible subject: the claim has no
 * `assigner` and its `assignee` is the outgoing token subject. Permission,
 * target, action, and scope stay unchanged. External grant ids and any `act`
 * chain are dropped; internal parent/child links between claim policies are
 * remapped to the fresh policy ids (C2 strict hiding).
 */
export function rewriteAccessClaim(access: Array<unknown>, assignee: string): Array<unknown> {
  // Parent/child links inside the claim reference the parent policy's local
  // id/uid. Allocate the fresh ids first so a child can be remapped to its
  // parent without exposing the hidden grant IRIs.
  const entries = access.map((raw) => {
    const policy = raw as Record<string, unknown>
    const inherited = Array.isArray(policy.inheritsFromGrant)
      ? policy.inheritsFromGrant
      : policy.inheritsFromGrant
        ? [policy.inheritsFromGrant]
        : []
    return {
      raw,
      newId: freshId(),
      refs: [policy.uid, policy.id].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      ),
      inherited: inherited.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      ),
    }
  })
  const byRef = new Map<string, string>()
  for (const entry of entries) {
    for (const ref of entry.refs) {
      byRef.set(ref, entry.newId)
    }
  }

  return entries.map(({ raw, newId, inherited }) => {
    const policy = sanitizeClaimNode(raw) as Record<string, unknown>
    // Keep the policy-level convenience target/action out of the re-issued
    // claim; the permission is the graph the policy engine evaluates. Fresh
    // ids replace the hidden grant ids (targets must stay IRI nodes).
    delete policy.target
    delete policy.action
    delete policy.assigner
    policy.id = newId
    policy.uid = newId
    policy.assignee = assignee
    const remapped = inherited
      .map((ref) => byRef.get(ref))
      .filter((ref): ref is string => typeof ref === 'string')
    if (remapped.length === 1) {
      policy.inheritsFromGrant = remapped[0]
    } else if (remapped.length > 1) {
      policy.inheritsFromGrant = remapped
    }
    if (Array.isArray(policy.permission)) {
      policy.permission = policy.permission.map((rawPermission) => {
        const permission = sanitizeClaimNode(rawPermission) as Record<string, unknown>
        permission.id = freshId()
        permission.uid = permission.id
        delete permission.assigner
        permission.assignee = assignee
        if (permission.target && typeof permission.target === 'object') {
          const target = permission.target as Record<string, unknown>
          target.id = freshId()
          target.uid = target.id
        }
        return permission
      })
    }
    return policy
  })
}
