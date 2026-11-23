import {
  INTEROP,
  LWS,
  ODRL,
  SHAPETREES,
  expandedJsonLd,
  frameNode,
  withContext,
} from '@janeirodigital/interop-utils'

import { accessContext } from './context.ts'

export type GrantId = {
  id?: string
  type: Array<string>
}

/** ODRL target object. */
export interface OdrlTarget {
  id?: string
  uid?: string
  owner?: string
  storage?: string
  type: Array<string>
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
  action: Array<string>
  target: OdrlTarget
}

/** ODRL policy (`Request` in requests, `Agreement` in grants). */
export interface OdrlPolicy {
  id?: string
  uid?: string
  type: Array<string>
  profile: string
  permission: Array<OdrlPermission>
  scopeOfGrant?: string
  inheritsFromGrant?: string
  /** Derived from the first permission (compatibility convenience). */
  assignee?: string
  action?: Array<string>
  target?: OdrlTarget
}

/**
 * The canonical access-grant read model. The wire truth is the ODRL
 * policy/permission/target graph; the flat fields below are derived
 * convenience values for existing consumers and are never serialized.
 */
export type GrantData = GrantId & {
  access: Array<OdrlPolicy>
  scopeOfGrant: string
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

const asArray = <T>(value: T | Array<T> | undefined): Array<T> =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

const PREFIX_IRI: Record<string, string> = {
  interop: 'http://www.w3.org/ns/solid/interop#',
  st: 'http://www.w3.org/ns/shapetrees#',
  odrl: 'http://www.w3.org/ns/odrl/2/',
  lws: 'https://www.w3.org/ns/lws#',
}

function resolveIri(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (Array.isArray(value)) {
    return resolveIri(value[0])
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return resolveIri(record['@id'] ?? record.id ?? record.value)
  }
  if (typeof value !== 'string') {
    return undefined
  }
  if (/^(https?:|urn:)/.test(value)) {
    return value
  }
  const [prefix, ...rest] = value.split(':')
  if (rest.length && PREFIX_IRI[prefix]) {
    return PREFIX_IRI[prefix] + rest.join(':')
  }
  const term = (accessContext as Record<string, unknown>)[value]
  if (typeof term === 'string') {
    return term === value ? value : resolveIri(term)
  }
  if (term && typeof term === 'object') {
    const id = (term as Record<string, unknown>)['@id']
    if (typeof id === 'string') {
      return id
    }
  }
  return value
}

function normalizeTarget(node: Record<string, unknown>): OdrlTarget {
  return {
    id: node.id as string | undefined,
    uid: node.uid as string | undefined,
    owner: resolveIri(node.owner),
    storage: resolveIri(node.storage),
    type: asArray(node.type as string | Array<string> | undefined).map((value) =>
      resolveIri(value)!
    ),
    source: asArray(node.source as string | Array<string> | undefined).map((value) =>
      resolveIri(value)!
    ),
    ...(node.registeredShapeTree
      ? {
          registeredShapeTree: resolveIri(node.registeredShapeTree),
        }
      : {}),
    ...(node.hasDataRegistration
      ? {
          hasDataRegistration: resolveIri(node.hasDataRegistration),
        }
      : {}),
  }
}

function normalizePermission(node: Record<string, unknown>): OdrlPermission {
  return {
    id: node.id as string | undefined,
    uid: node.uid as string | undefined,
    assigner: resolveIri(node.assigner)!,
    assignee: resolveIri(node.assignee)!,
    action: asArray(node.action as string | Array<string> | undefined).map((value) =>
      resolveIri(value)!
    ),
    target: normalizeTarget((node.target as Record<string, unknown>) ?? {}),
  }
}

function normalizePolicy(node: Record<string, unknown>): OdrlPolicy {
  const permission = asArray(node.permission as Array<Record<string, unknown>> | undefined).map(
    normalizePermission
  )
  const first = permission[0]
  return {
    id: node.id as string | undefined,
    uid: node.uid as string | undefined,
    type: asArray(node.type as string | Array<string> | undefined).map((value) =>
      resolveIri(value)!
    ),
    profile: resolveIri(node.profile)!,
    permission,
    scopeOfGrant: resolveIri(node.scopeOfGrant),
    inheritsFromGrant: resolveIri(node.inheritsFromGrant),
    ...(first?.assignee ? { assignee: first.assignee } : {}),
    ...(first?.action.length ? { action: [...first.action] } : {}),
    ...(first?.target ? { target: first.target } : {}),
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
  if (target.type.includes(SHAPETREES.ShapeTree)) {
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
  if (target.type.includes(INTEROP.DataRegistration)) {
    return target.source[0] ?? ''
  }
  return target.hasDataRegistration ?? ''
}

function deriveFields(
  node: Record<string, unknown>,
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
    .find((candidate) => candidate.type.includes(INTEROP.DataRegistration))
  const assetTargets = permissions.flatMap(({ target: candidate }) =>
    candidate.type.includes(ODRL.Asset) && !candidate.type.includes(INTEROP.DataRegistration)
      ? [candidate]
      : []
  )
  return {
    storage: target?.storage ?? (node.storage as string | undefined) ?? '',
    grantedBy: first?.assigner ?? (node.grantedBy as string | undefined) ?? '',
    dataOwner: first?.target.owner ?? (node.dataOwner as string | undefined) ?? '',
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
  })) as Record<string, unknown>
  const access = asArray(node.access as Array<Record<string, unknown>> | undefined)
    .filter(Boolean)
    .map(normalizePolicy)
  return {
    id,
    type: asArray(node.type as string | Array<string> | undefined).map((value) =>
      resolveIri(value)!
    ),
    access,
    scopeOfGrant: resolveIri(node.scopeOfGrant) ?? access[0]?.scopeOfGrant ?? '',
    ...(node.inheritsFromGrant ? { inheritsFromGrant: resolveIri(node.inheritsFromGrant)! } : {}),
    ...(node.hasInheritingGrant
      ? { hasInheritingGrant: asArray(node.hasInheritingGrant as string | Array<string>) }
      : {}),
    ...deriveFields(node, access),
  }
}

/** The concrete grantee of the first permission. */
export function grantGrantee(grant: Pick<GrantData, 'access'>): string | undefined {
  return grant.access[0]?.permission[0]?.assignee
}

/** Every action across the grant's permissions (deduped). */
export function grantAccessModes(grant: Pick<GrantData, 'access'>): Array<string> {
  return [...new Set(grant.access.flatMap((policy) => policy.permission.flatMap((p) => p.action)))]
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

function targetFor(input: GrantTargetInput, instance?: string): OdrlTarget {
  const id = urn()
  switch (input.scopeOfGrant) {
    case INTEROP.SelectedFromRegistry:
      return {
        id,
        uid: id,
        owner: input.owner,
        storage: input.storage,
        type: [ODRL.Asset],
        source: instance ? [instance] : [...(input.hasDataInstance ?? [])],
        ...(input.registeredShapeTree ? { registeredShapeTree: input.registeredShapeTree } : {}),
        ...(input.hasDataRegistration ? { hasDataRegistration: input.hasDataRegistration } : {}),
      }
    case INTEROP.AllFromRegistry:
    case INTEROP.Inherited:
      return {
        id,
        uid: id,
        owner: input.owner,
        storage: input.storage,
        type: [ODRL.AssetCollection, INTEROP.DataRegistration],
        source: [input.hasDataRegistration],
        ...(input.registeredShapeTree ? { registeredShapeTree: input.registeredShapeTree } : {}),
      }
    case INTEROP.AllFromAgent:
      return {
        id,
        uid: id,
        owner: input.owner,
        storage: input.storage,
        type: [INTEROP.SocialAgent],
        source: [input.agent ?? ''],
        ...(input.registeredShapeTree ? { registeredShapeTree: input.registeredShapeTree } : {}),
      }
    default:
      throw new Error(`Unknown scope: ${input.scopeOfGrant}`)
  }
}

/** Build one ODRL `Agreement` policy (one permission per selected resource). */
export function grantAccess(input: GrantPermissionInput): Array<OdrlPolicy> {
  if (!input.registeredShapeTree) {
    throw new Error(`scope ${input.scopeOfGrant} requires a registeredShapeTree`)
  }
  if (input.scopeOfGrant === INTEROP.SelectedFromRegistry && !input.hasDataRegistration) {
    throw new Error('SelectedFromRegistry requires a hasDataRegistration')
  }
  const policyId = urn()
  const permissions: Array<OdrlPermission> = []
  if (input.scopeOfGrant === INTEROP.SelectedFromRegistry) {
    for (const instance of input.hasDataInstance ?? []) {
      const permissionId = urn()
      permissions.push({
        id: permissionId,
        uid: permissionId,
        assigner: input.assigner,
        assignee: input.assignee,
        action: [...input.actions],
        target: targetFor(input, instance),
      })
    }
  } else {
    const permissionId = urn()
    permissions.push({
      id: permissionId,
      uid: permissionId,
      assigner: input.assigner,
      assignee: input.assignee,
      action: [...input.actions],
      target: targetFor(input),
    })
  }
  return [
    {
      id: policyId,
      uid: policyId,
      type: [ODRL.Agreement],
      profile: INTEROP.AccessProfile,
      permission: permissions,
      scopeOfGrant: input.scopeOfGrant,
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
    type: [...new Set([LWS.AccessGrant, ...(grant.type ?? [])])],
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
