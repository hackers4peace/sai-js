import {
  CONTEXT,
  asAccessModeTerm,
  asScopeTerm,
  expandedJsonLd,
  frameNode,
  required,
  withContext,
} from '@janeirodigital/interop-utils'
import type {
  AccessModeTerm,
  AccessProfileTerm,
  GrantClassTerm,
  ScopeOfGrantTerm,
} from '@janeirodigital/interop-utils'

import { accessContext } from './context.ts'

/** A closed token union that still accepts vocabulary outside the SAI set. */
type OpenTerm<T extends string> = T | (string & {})

export type GrantId = {
  id?: string
  type: Array<OpenTerm<GrantClassTerm>>
}

/** ODRL target object. */
export interface OdrlTarget {
  id?: string
  uid?: string
  owner?: string
  storage?: string
  /** compacted class tokens (`Asset`, `AssetCollection`, `ShapeTree`, …) */
  type: Array<OpenTerm<GrantClassTerm>>
  source: Array<string>
  /** SAI profile: the shape tree the target is scoped to. */
  registeredShapeTree?: string
  /** SAI profile: the registration of a selected instance. */
  hasDataRegistration?: string
}

/** ODRL permission. */
export interface OdrlPermission {
  id?: string
  uid?: string
  assigner: string
  assignee: string
  /** compacted action tokens (`read`, `create`, `modify`, `delete`) */
  action: Array<OpenTerm<AccessModeTerm>>
  target: OdrlTarget
}

/** ODRL policy (`Request` in requests, `Agreement` in grants). */
export interface OdrlPolicy {
  id?: string
  uid?: string
  type: Array<OpenTerm<GrantClassTerm>>
  profile: OpenTerm<AccessProfileTerm>
  permission: Array<OdrlPermission>
  scopeOfGrant?: OpenTerm<ScopeOfGrantTerm>
  inheritsFromGrant?: string
}

/**
 * The canonical access-grant read model — the wire shape of the grant document:
 * the ODRL policy/permission/target tree plus the grant-level links. Nothing
 * here is derived: the target facts consumers need (storage, owner, shape tree,
 * registration, instances) are read from the permission tree through the
 * `grant*` helpers below, so the POJO can be written back with `toJsonLd`
 * without dropping or inventing fields.
 *
 * Vocabulary values (classes, scope, profile, actions) are the context's
 * compacted tokens; IRI-valued fields (storage, source, shape tree,
 * registration, grant links) stay absolute.
 */
export type GrantData = GrantId & {
  access: Array<OdrlPolicy>
  scopeOfGrant?: OpenTerm<ScopeOfGrantTerm>
  inheritsFromGrant?: string
  hasInheritingGrant?: Array<string>
}

export type FinalGrantData = GrantData & Required<Pick<GrantData, 'id'>>

export interface GeneratedGrants {
  sourceGrants: Array<FinalGrantData>
  delegatedGrants: Array<GrantData>
}

export interface GrantTargetInput {
  scopeOfGrant: string
  /** the data owner (`interop:dataOwner` on the target) */
  owner: string
  storage: string
  hasDataRegistration: string
  hasDataInstance?: Array<string>
  registeredShapeTree?: string
  /** `AllFromAgent` target party. */
  agent?: string
}

export interface GrantPermissionInput extends GrantTargetInput {
  /** the delegator */
  assigner: string
  assignee: string
  actions: ReadonlyArray<string>
}

const urn = (): string => `urn:uuid:${crypto.randomUUID()}`

/**
 * The node shapes the framer returns — the same ODRL properties the read model
 * exposes. Everything is a wire term here; there is no separate projection.
 */
type FramedTarget = {
  id?: string
  uid?: string
  owner?: string
  storage?: string
  type?: Array<OpenTerm<GrantClassTerm>>
  source?: Array<string>
  registeredShapeTree?: string
  hasDataRegistration?: string
}

type FramedPermission = {
  id?: string
  uid?: string
  assigner?: string
  assignee?: string
  action?: Array<OpenTerm<AccessModeTerm>>
  target?: FramedTarget
}

type FramedPolicy = {
  id?: string
  uid?: string
  type?: Array<OpenTerm<GrantClassTerm>>
  profile?: OpenTerm<AccessProfileTerm>
  permission?: Array<FramedPermission>
  scopeOfGrant?: OpenTerm<ScopeOfGrantTerm>
  inheritsFromGrant?: string
}

type FramedGrant = {
  id: string
  type: Array<OpenTerm<GrantClassTerm>>
  access: Array<FramedPolicy>
  scopeOfGrant?: OpenTerm<ScopeOfGrantTerm>
  inheritsFromGrant?: string
  hasInheritingGrant: Array<string>
}

/**
 * The grant document's own wire terms — the `@explicit` frame list: the
 * embedded policy tree under `access`, the scope and the inheritance links.
 * The target facts (`storage`, `dataOwner`, shape tree, registration,
 * instances) live on the permission tree and are reached through the `grant*`
 * helpers, not framed onto the grant node.
 */
const GRANT_TERMS = ['access', 'scopeOfGrant', 'inheritsFromGrant', 'hasInheritingGrant'] as const

/**
 * The framed policy already has the POJO's property names; this only fills the
 * set-container defaults of the EMBEDDED nodes (permissions and targets are not
 * focus nodes of the frame, so `frameNode` does not fill their absent set
 * terms) and requires the values every permission needs.
 */
function toOdrlPolicy(framed: FramedPolicy): OdrlPolicy {
  const permission = (framed.permission ?? []).map((entry) => ({
    ...entry,
    assigner: required(entry, 'assigner'),
    assignee: required(entry, 'assignee'),
    action: entry.action ?? [],
    target: {
      ...(entry.target ?? {}),
      type: entry.target?.type ?? [],
      source: entry.target?.source ?? [],
    },
  }))
  return {
    ...framed,
    type: framed.type ?? [],
    profile: required(framed, 'profile'),
    permission,
    scopeOfGrant: asScopeTerm(framed.scopeOfGrant) ?? framed.scopeOfGrant,
  }
}

/**
 * The shape tree a target is scoped to. A shape-tree target names it as its
 * `source`; every other data target carries it explicitly.
 */
export function shapeTreeOfTarget(target: OdrlTarget | undefined): string {
  if (!target) {
    return ''
  }
  if (target.registeredShapeTree) {
    return target.registeredShapeTree
  }
  if (target.type.includes(CONTEXT.ShapeTree)) {
    return target.source[0] ?? ''
  }
  return ''
}

/**
 * The registration a target is scoped to: the `source` of a collection target,
 * the explicit field of a selected asset target.
 */
export function registrationOfTarget(target: OdrlTarget | undefined): string {
  if (!target) {
    return ''
  }
  if (target.type.includes(CONTEXT.DataRegistration)) {
    return target.source[0] ?? ''
  }
  return target.hasDataRegistration ?? ''
}

/** A grant value the model requires; throws instead of coercing to `''`. */
function must<T extends string>(value: T | undefined | '', what: string, id: string): T {
  if (value === undefined || value === '') {
    throw new Error(`grant ${id} is missing ${what}`)
  }
  return value
}

export async function fromJsonLd(doc: unknown, id: string): Promise<GrantData> {
  const expanded = await expandedJsonLd(doc as Record<string, unknown>)
  const node = (await frameNode(expanded, accessContext, id, {
    terms: GRANT_TERMS,
    overrides: { access: { '@embed': '@always' } },
  })) as unknown as FramedGrant
  const access = node.access.map(toOdrlPolicy)
  const grant: GrantData = {
    id,
    type: node.type,
    access,
    // OPTIONAL: an AdminGrant carries `scopeOfAdminGrant`, not a data scope —
    // the same reader is used for both, so an absent scope is not an error.
    scopeOfGrant: asScopeTerm(node.scopeOfGrant) ?? node.scopeOfGrant ?? access[0]?.scopeOfGrant,
    ...(node.inheritsFromGrant ? { inheritsFromGrant: node.inheritsFromGrant } : {}),
    ...(node.hasInheritingGrant ? { hasInheritingGrant: node.hasInheritingGrant } : {}),
  }
  // the reader's contract is visibility, not coercion: a grant without a
  // storage, an issuer or a data owner can be matched by nobody, so fail at the
  // read boundary instead of handing consumers empty strings
  must(grantStorage(grant), 'storage', id)
  must(grantAssigner(grant), 'grantedBy', id)
  must(grantDataOwner(grant), 'dataOwner', id)
  return grant
}

/** The concrete grantee of the first permission. */
export function grantGrantee(grant: Pick<GrantData, 'access'>): string | undefined {
  return grant.access[0]?.permission[0]?.assignee
}

/** Every action across the grant's permissions (deduped, tokens). */
export function grantAccessModes(grant: Pick<GrantData, 'access'>): Array<string> {
  return [
    ...new Set(
      grant.access.flatMap((policy) =>
        policy.permission.flatMap((permission) =>
          permission.action.map((action) => asAccessModeTerm(action) ?? action)
        )
      )
    ),
  ]
}

/** Every target across the grant's permissions. */
export function grantTargets(grant: Pick<GrantData, 'access'>): Array<OdrlTarget> {
  return grant.access.flatMap((policy) => policy.permission.map((permission) => permission.target))
}

/**
 * The shape tree the grant is scoped to: the first target that names one. Empty
 * when the grant is not shape-tree-scoped (registry-set and data-registry admin
 * grants target storage).
 */
export function grantShapeTree(grant: Pick<GrantData, 'access'>): string {
  return grantTargets(grant).map(shapeTreeOfTarget).find(Boolean) ?? ''
}

/**
 * The data registration the grant is scoped to: a `DataRegistration` target's
 * source, else the first target carrying an explicit registration. Empty when
 * the grant is not registration-scoped (a shape-tree target).
 */
export function grantRegistration(grant: Pick<GrantData, 'access'>): string {
  const targets = grantTargets(grant)
  const registrationTarget = targets.find((target) =>
    target.type.includes(CONTEXT.DataRegistration)
  )
  return (
    registrationOfTarget(registrationTarget) ||
    (targets.map(registrationOfTarget).find(Boolean) ?? '')
  )
}

/** The selected instances the grant targets (asset targets), in permission order. */
export function grantDataInstances(grant: Pick<GrantData, 'access'>): Array<string> {
  return grantTargets(grant)
    .filter(
      (target) =>
        target.type.includes(CONTEXT.Asset) && !target.type.includes(CONTEXT.DataRegistration)
    )
    .flatMap((target) => (target.source[0] ? [target.source[0]] : []))
}

/** The grant's data storage (first target). */
export function grantStorage(grant: Pick<GrantData, 'access'>): string {
  return grant.access[0]?.permission[0]?.target.storage ?? ''
}

/** The grant's data owner (first target owner). */
export function grantDataOwner(grant: Pick<GrantData, 'access'>): string {
  return grant.access[0]?.permission[0]?.target.owner ?? ''
}

/** The grant's delegator (first permission assigner). */
export function grantAssigner(grant: Pick<GrantData, 'access'>): string {
  return grant.access[0]?.permission[0]?.assigner ?? ''
}

function targetFor(
  input: GrantTargetInput,
  scope: ScopeOfGrantTerm,
  instance?: string
): OdrlTarget {
  const id = urn()
  switch (scope) {
    case CONTEXT.SelectedFromRegistry:
      return {
        id,
        uid: id,
        owner: input.owner,
        storage: input.storage,
        type: [CONTEXT.Asset],
        source: instance ? [instance] : [...(input.hasDataInstance ?? [])],
        ...(input.registeredShapeTree ? { registeredShapeTree: input.registeredShapeTree } : {}),
        ...(input.hasDataRegistration ? { hasDataRegistration: input.hasDataRegistration } : {}),
      }
    case CONTEXT.AllFromRegistry:
    case CONTEXT.Inherited:
      return {
        id,
        uid: id,
        owner: input.owner,
        storage: input.storage,
        type: [CONTEXT.AssetCollection, CONTEXT.DataRegistration],
        source: [input.hasDataRegistration],
        ...(input.registeredShapeTree ? { registeredShapeTree: input.registeredShapeTree } : {}),
      }
    case CONTEXT.AllFromAgent:
      return {
        id,
        uid: id,
        owner: input.owner,
        storage: input.storage,
        type: [CONTEXT.SocialAgent],
        source: [input.agent ?? ''],
        ...(input.registeredShapeTree ? { registeredShapeTree: input.registeredShapeTree } : {}),
      }
    default:
      throw new Error(`Unknown scope: ${input.scopeOfGrant}`)
  }
}

/** Build one ODRL `Agreement` policy (one permission per selected resource). */
export function grantAccess(input: GrantPermissionInput): Array<OdrlPolicy> {
  const scope = asScopeTerm(input.scopeOfGrant)
  if (!scope) {
    throw new Error(`Unknown scope: ${input.scopeOfGrant}`)
  }
  if (!input.registeredShapeTree) {
    throw new Error(`scope ${input.scopeOfGrant} requires a registeredShapeTree`)
  }
  if (scope === CONTEXT.SelectedFromRegistry && !input.hasDataRegistration) {
    throw new Error('SelectedFromRegistry requires a hasDataRegistration')
  }
  const actions = input.actions.map((action) => asAccessModeTerm(action) ?? action)
  const policyId = urn()
  const permissions: Array<OdrlPermission> = []
  if (scope === CONTEXT.SelectedFromRegistry) {
    for (const instance of input.hasDataInstance ?? []) {
      const permissionId = urn()
      permissions.push({
        id: permissionId,
        uid: permissionId,
        assigner: input.assigner,
        assignee: input.assignee,
        action: [...actions],
        target: targetFor(input, scope, instance),
      })
    }
  } else {
    const permissionId = urn()
    permissions.push({
      id: permissionId,
      uid: permissionId,
      assigner: input.assigner,
      assignee: input.assignee,
      action: [...actions],
      target: targetFor(input, scope),
    })
  }
  return [
    {
      id: policyId,
      uid: policyId,
      type: [CONTEXT.Agreement],
      profile: CONTEXT.AccessProfile,
      permission: permissions,
      scopeOfGrant: scope,
    },
  ]
}

/**
 * The serializable terms of each grant node. The read model is the wire shape,
 * so the write path is a `pick` of these per level plus the two normalizations
 * a builder may not have applied: the `AccessGrant` envelope class and `uid`
 * defaulting to `id`.
 */
const GRANT_WIRE_TERMS = ['id', 'scopeOfGrant', 'inheritsFromGrant', 'hasInheritingGrant'] as const
const POLICY_WIRE_TERMS = ['id', 'type', 'profile', 'scopeOfGrant', 'inheritsFromGrant'] as const
const PERMISSION_WIRE_TERMS = ['id', 'assigner', 'assignee', 'action'] as const
const TARGET_WIRE_TERMS = [
  'id',
  'owner',
  'storage',
  'type',
  'source',
  'registeredShapeTree',
  'hasDataRegistration',
] as const

/** The present wire terms only — an absent field is omitted, never `undefined`. */
function pick<T extends object, K extends keyof T>(source: T, keys: ReadonlyArray<K>): Pick<T, K> {
  const picked = {} as Pick<T, K>
  for (const key of keys) {
    if (source[key] !== undefined) {
      picked[key] = source[key]
    }
  }
  return picked
}

/** Write a grant as the frozen ODRL/LWS/SAI shape. */
export function toJsonLd(grant: FinalGrantData): Record<string, unknown> {
  return withContext(accessContext, {
    ...pick(grant, GRANT_WIRE_TERMS),
    type: [...new Set([CONTEXT.AccessGrant, ...grant.type])],
    access: grant.access.map((policy) => ({
      ...pick(policy, POLICY_WIRE_TERMS),
      uid: policy.uid ?? policy.id,
      type: [...new Set(policy.type)],
      permission: policy.permission.map((permission) => ({
        ...pick(permission, PERMISSION_WIRE_TERMS),
        uid: permission.uid ?? permission.id,
        target: {
          ...pick(permission.target, TARGET_WIRE_TERMS),
          uid: permission.target.uid ?? permission.target.id,
        },
      })),
    })),
  })
}

export function dataRegistryIri(grant: GrantData): string {
  return grantStorage(grant)
}
