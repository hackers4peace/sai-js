import type { GrantData } from '@janeirodigital/interop-data-model'

/**
 * Pure grant-tree equivalence for `checkEquivalence`
 * (openwiki/architecture/grant-reuse.md).
 *
 * A grant's identity is its **subtree**: a parent and all of its descendants
 * are equivalent only as a whole — a child is never reused under a new parent.
 * The compared fields are the semantic `GrantData` fields; ids and the derived
 * /structural links (`inheritsFromGrant`, `hasInheritingGrant`) are not
 * compared, the tree walk compares the structure instead. `delegationOfGrant`
 * no longer exists (chain validity is match-based).
 *
 * No I/O here: callers load the grant bodies (own grant registry, issuer-side
 * replica) and pass them in. Missing bodies must be filtered out by the caller
 * (fail-closed: an incomplete existing tree simply never matches).
 */

const SCALAR_FIELDS = [
  'grantedBy',
  'dataOwner',
  'registeredShapeTree',
  'hasDataRegistration',
  'storage',
  'scopeOfGrant',
] as const

const SET_FIELDS = ['hasDataInstance'] as const

/** A grant plus its descendants (one level in generation today, recursive for future n-depth). */
export interface GrantTree {
  grant: GrantData
  children: Array<GrantTree>
}

export interface GrantNodePair {
  generated: GrantData
  existing: GrantData
}

export interface GrantTreePair {
  generated: GrantTree
  existing: GrantTree
  /** flattened correspondence, parent first, then every descendant */
  nodes: Array<GrantNodePair>
}

function sameSet(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined
): boolean {
  const left = new Set(a ?? [])
  const right = new Set(b ?? [])
  if (left.size !== right.size) {
    return false
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }
  return true
}

/**
 * Normalize the LWS access policies into comparable strings: assigner,
 * assignee, target owner, the action set, the target type and the target value
 * set. The policy order and the action/value order do not matter.
 */
function accessShape(grant: GrantData): Array<string> {
  return grant.access
    .flatMap((policy) => policy.permission)
    .map((permission) =>
      [
        permission.assigner,
        permission.assignee,
        permission.target.owner ?? '',
        [...new Set(permission.action)].toSorted().join(','),
        [...new Set(permission.target.type)].toSorted().join(','),
        [...new Set(permission.target.source)].toSorted().join(','),
      ].join('\u0000')
    )
    .toSorted()
}

/**
 * Semantic-field equality for one grant (no tree walk). Set-valued fields are
 * compared as sets, so order and duplicates do not matter; an absent optional
 * set equals an empty one.
 */
export function grantFieldsEqual(a: GrantData, b: GrantData): boolean {
  for (const field of SCALAR_FIELDS) {
    if (a[field] !== b[field]) {
      return false
    }
  }
  for (const field of SET_FIELDS) {
    if (!sameSet(a[field], b[field])) {
      return false
    }
  }
  return sameSet(accessShape(a), accessShape(b))
}

function declaredChildIds(grant: GrantData): Array<string> {
  return (grant.hasInheritingGrant ?? []).filter(
    (child): child is string => typeof child === 'string'
  )
}

/**
 * A flat tree is usable only when its declared children
 * (`hasInheritingGrant`) are all present — same ids, same count — recursively.
 * A linked-but-missing body therefore fails closed (the parent never matches)
 * instead of looking childless.
 */
function isComplete(tree: GrantTree): boolean {
  const declared = new Set(declaredChildIds(tree.grant))
  if (declared.size !== tree.children.length) {
    return false
  }
  for (const child of tree.children) {
    if (!child.grant.id || !declared.has(child.grant.id)) {
      return false
    }
  }
  return tree.children.every(isComplete)
}

/**
 * Build trees from a flat grant list linked by `id` + `inheritsFromGrant`
 * (generated source grants, existing grant bodies). Incomplete trees (declared
 * children whose bodies are missing) and orphaned children (parent body
 * missing) are omitted — they can never be reused.
 */
export function grantTrees(grants: Array<GrantData>): Array<GrantTree> {
  const byId = new Map<string, GrantTree>()
  for (const grant of grants) {
    if (grant.id && !byId.has(grant.id)) {
      byId.set(grant.id, { grant, children: [] })
    }
  }
  const roots: Array<GrantTree> = []
  for (const tree of byId.values()) {
    const parentId = tree.grant.inheritsFromGrant
    if (!parentId) {
      roots.push(tree)
      continue
    }
    // an orphan child (parent body absent) is deliberately not promoted to a root
    byId.get(parentId)?.children.push(tree)
  }
  return roots.filter(isComplete)
}

function embeddedGrantTree(grant: GrantData): GrantTree {
  // delegated generation embeds child grant objects (no ids yet); the
  // `string[]` type is a wire convenience, so only object children build the tree
  const embedded = (grant.hasInheritingGrant ?? []) as Array<unknown>
  return {
    grant,
    children: embedded
      .filter((child): child is GrantData => typeof child === 'object' && child !== null)
      .map((child) => embeddedGrantTree(child)),
  }
}

/**
 * Build trees from generated delegated grants, whose children ride the parent
 * as embedded objects (recursive, so n-depth nests work unchanged).
 */
export function delegatedGrantTrees(grants: Array<GrantData>): Array<GrantTree> {
  return grants.map((grant) => embeddedGrantTree(grant))
}

/**
 * Recursively pair a generated tree with an existing one. Returns the flat
 * node correspondence (parent first) or `undefined` when the trees differ.
 * Children are matched as a set: equivalent children are interchangeable.
 */
function pairNodes(generated: GrantTree, existing: GrantTree): Array<GrantNodePair> | undefined {
  if (!grantFieldsEqual(generated.grant, existing.grant)) {
    return undefined
  }
  if (generated.children.length !== existing.children.length) {
    return undefined
  }

  const used = new Set<number>()
  const nodes: Array<GrantNodePair> = [{ generated: generated.grant, existing: existing.grant }]
  for (const generatedChild of generated.children) {
    let matched = false
    for (let index = 0; index < existing.children.length; index += 1) {
      if (used.has(index)) {
        continue
      }
      const childPairs = pairNodes(generatedChild, existing.children[index])
      if (!childPairs) {
        continue
      }
      used.add(index)
      nodes.push(...childPairs)
      matched = true
      break
    }
    if (!matched) {
      return undefined
    }
  }
  return nodes
}

/** Whether a generated tree can be satisfied by an existing tree as a whole. */
export function treesEqual(generated: GrantTree, existing: GrantTree): boolean {
  return pairNodes(generated, existing) !== undefined
}

/**
 * Greedy one-to-one pairing of generated trees with existing trees. Unmatched
 * generated trees are simply absent from the result (they will be regenerated);
 * each existing tree is claimed at most once.
 */
export function pairTrees(
  generated: Array<GrantTree>,
  existing: Array<GrantTree>
): Array<GrantTreePair> {
  const used = new Set<number>()
  const pairs: Array<GrantTreePair> = []
  for (const generatedTree of generated) {
    for (let index = 0; index < existing.length; index += 1) {
      if (used.has(index)) {
        continue
      }
      const nodes = pairNodes(generatedTree, existing[index])
      if (!nodes) {
        continue
      }
      used.add(index)
      pairs.push({ generated: generatedTree, existing: existing[index], nodes })
      break
    }
  }
  return pairs
}
