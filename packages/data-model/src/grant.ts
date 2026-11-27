import {
  CONTEXT,
  asAccessModeTerm,
  asScopeTerm,
  expandedJsonLd,
  frameNode,
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
  /** Derived from the first permission (compatibility convenience). */
  assignee?: string
  action?: Array<OpenTerm<AccessModeTerm>>
  target?: OdrlTarget
}

/**
 * The canonical access-grant read model. The wire truth is the ODRL
 * policy/permission/target graph; the flat fields below are derived
 * convenience values for existing consumers and are never serialized.
 *
 * Vocabulary values (classes, scope, profile, actions) are the context's
 * compacted tokens; IRI-valued fields (storage, source, shape tree,
 * registration, grant links) stay absolute.
 */
export type GrantData = GrantId & {
  access: Array<OdrlPolicy>
  scopeOfGrant: OpenTerm<ScopeOfGrantTerm> | ''
  inheritsFromGrant?: string
  hasInheritingGrant?: Array<string>

  // Derived convenience fields (not serialized).
  storage: string
  grantedBy: string
  dataOwner: string
  registeredShapeTree: string
  hasDataRegistration: string
  hasDataInstance?: Array<string>
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
 * The wire shape of a framed grant. These are the same ODRL properties the
 * POJO exposes; only the policy-level convenience fields (`assignee`, `action`,
 * `target`) are derived, not framed.
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
  type?: Array<OpenTerm<GrantClassTerm>>
  access?: Array<FramedPolicy>
  scopeOfGrant?: OpenTerm<ScopeOfGrantTerm>
  inheritsFromGrant?: string
  hasInheritingGrant?: Array<string>
  storage?: string
  grantedBy?: string
  dataOwner?: string
  registeredShapeTree?: string
  hasDataRegistration?: string
  hasDataInstance?: Array<string>
}

/**
 * The framed policy already has the POJO's property names; this only fills the
 * set-container defaults and lifts the first permission to the policy-level
 * convenience fields (`assignee`, `action`, `target`).
 */
function toOdrlPolicy(framed: FramedPolicy): OdrlPolicy {
  const permission = (framed.permission ?? []).map((entry) => ({
    ...entry,
    assigner: entry.assigner ?? '',
    assignee: entry.assignee ?? '',
    action: entry.action ?? [],
    target: {
      ...(entry.target ?? {}),
      type: entry.target?.type ?? [],
      source: entry.target?.source ?? [],
    },
  }))
  const first = permission[0]
  return {
    ...framed,
    type: framed.type ?? [],
    profile: framed.profile ?? '',
    permission,
    scopeOfGrant: asScopeTerm(framed.scopeOfGrant) ?? framed.scopeOfGrant,
    ...(first ? { assignee: first.assignee, action: [...first.action], target: first.target } : {}),
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

function deriveFields(
  node: FramedGrant,
  access: Array<OdrlPolicy>
): Pick<
  GrantData,
  | 'storage'
  | 'grantedBy'
  | 'dataOwner'
  | 'registeredShapeTree'
  | 'hasDataRegistration'
  | 'hasDataInstance'
> {
  const permissions = access.flatMap((policy) => policy.permission)
  const first = permissions[0]
  const target = first?.target
  const registrationTarget = permissions
    .map((permission) => permission.target)
    .find((candidate) => candidate.type.includes(CONTEXT.DataRegistration))
  const assetTargets = permissions.flatMap(({ target: candidate }) =>
    candidate.type.includes(CONTEXT.Asset) && !candidate.type.includes(CONTEXT.DataRegistration)
      ? [candidate]
      : []
  )
  return {
    storage: target?.storage ?? node.storage ?? '',
    grantedBy: first?.assigner ?? node.grantedBy ?? '',
    dataOwner: first?.target.owner ?? node.dataOwner ?? '',
    registeredShapeTree:
      permissions.map((permission) => shapeTreeOfTarget(permission.target)).find(Boolean) ?? '',
    hasDataRegistration:
      registrationOfTarget(registrationTarget) ||
      (permissions.map((permission) => registrationOfTarget(permission.target)).find(Boolean) ??
        ''),
    ...(assetTargets.length
      ? {
          hasDataInstance: assetTargets.flatMap((candidate) =>
            candidate.source[0] ? [candidate.source[0]] : []
          ),
        }
      : {}),
  }
}

export async function fromJsonLd(doc: unknown, id: string): Promise<GrantData> {
  const expanded = await expandedJsonLd(doc as Record<string, unknown>)
  const node = (await frameNode(expanded, accessContext, id, {
    access: { '@embed': '@always' },
  })) as unknown as FramedGrant
  const access = (node.access ?? []).map(toOdrlPolicy)
  return {
    id,
    type: node.type ?? [],
    access,
    scopeOfGrant:
      asScopeTerm(node.scopeOfGrant) ?? node.scopeOfGrant ?? access[0]?.scopeOfGrant ?? '',
    ...(node.inheritsFromGrant ? { inheritsFromGrant: node.inheritsFromGrant } : {}),
    ...(node.hasInheritingGrant ? { hasInheritingGrant: node.hasInheritingGrant } : {}),
    ...deriveFields(node, access),
  }
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
      ...(permissions[0]
        ? {
            assignee: permissions[0].assignee,
            action: [...permissions[0].action],
            target: permissions[0].target,
          }
        : {}),
    },
  ]
}

/** Write a grant as the frozen ODRL/LWS/SAI shape. */
export function toJsonLd(grant: FinalGrantData): Record<string, unknown> {
  return withContext(accessContext, {
    id: grant.id,
    type: [...new Set([CONTEXT.AccessGrant, ...(grant.type ?? [])])],
    scopeOfGrant: grant.scopeOfGrant,
    access: grant.access.map((policy) => ({
      id: policy.id,
      uid: policy.uid ?? policy.id,
      type: [...new Set(policy.type)],
      profile: policy.profile,
      ...(policy.scopeOfGrant ? { scopeOfGrant: policy.scopeOfGrant } : {}),
      permission: policy.permission.map((permission) => ({
        id: permission.id,
        uid: permission.uid ?? permission.id,
        assigner: permission.assigner,
        assignee: permission.assignee,
        action: permission.action,
        target: {
          id: permission.target.id,
          uid: permission.target.uid ?? permission.target.id,
          ...(permission.target.owner ? { owner: permission.target.owner } : {}),
          ...(permission.target.storage ? { storage: permission.target.storage } : {}),
          type: permission.target.type,
          source: permission.target.source,
          ...(permission.target.registeredShapeTree
            ? { registeredShapeTree: permission.target.registeredShapeTree }
            : {}),
          ...(permission.target.hasDataRegistration
            ? { hasDataRegistration: permission.target.hasDataRegistration }
            : {}),
        },
      })),
      ...(policy.inheritsFromGrant ? { inheritsFromGrant: policy.inheritsFromGrant } : {}),
    })),
    ...(grant.inheritsFromGrant ? { inheritsFromGrant: grant.inheritsFromGrant } : {}),
    ...(grant.hasInheritingGrant ? { hasInheritingGrant: grant.hasInheritingGrant } : {}),
  })
}

export function dataRegistryIri(grant: GrantData): string {
  return grantStorage(grant)
}
