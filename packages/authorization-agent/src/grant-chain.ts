import type { GrantData } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'

/**
 * Grant chain validity — the C1 predicate (revocation workstream).
 *
 * Grants are projections of authorizations. A grant is **valid** iff it is a
 * source/root grant (`grantedBy === dataOwner`) or it is covered by a valid
 * upstream grant:
 *
 *   up.grantee === down.grantedBy
 *   up.dataOwner === down.dataOwner
 *   up.registeredShapeTree === down.registeredShapeTree
 *   up.hasDataRegistration === down.hasDataRegistration
 *   up.hasStorage === down.hasStorage
 *   up.scopeOfGrant covers down.scopeOfGrant
 *   up.accessMode ⊇ down.accessMode
 *   up.creatorAccessMode ⊇ down.creatorAccessMode
 *   (for down SelectedFromRegistry) up.hasDataInstance ⊇ down.hasDataInstance
 *   ∧ up itself valid
 *
 * A grant with `inheritsFromGrant` is a same-request child: it is valid iff
 * its parent is valid and the identity/storage fields match. The parent is the
 * structural lifecycle link, not the scope/match authority: a source child is
 * valid through it, while a delegated child additionally needs its own valid
 * match-based upstream (the source grant for its shape tree/registration).
 *
 * Validity is **rooted reachability**: a cycle with no source grant never
 * becomes valid. The implementation is a monotonic fixed point (false → true)
 * rather than a DFS with per-path memoisation, so a grant that is reachable
 * from both a cycle and a valid root resolves correctly.
 *
 * This module is pure (no I/O). Callers load the grant registry (see
 * `getRegistryGrants` in `sparql.ts`) and pass the bodies in.
 */

const SCOPE_ORDER: Record<string, number> = {
  [INTEROP.All]: 4,
  [INTEROP.AllFromAgent]: 3,
  [INTEROP.AllFromRole]: 3,
  [INTEROP.AllFromRegistry]: 2,
  [INTEROP.SelectedFromRegistry]: 1,
  [INTEROP.Inherited]: 0,
}

/**
 * The upstream-lookup key: a candidate must match dataOwner + grantee +
 * shape tree + registration + storage; scope/mode/instance coverage is checked
 * after the lookup.
 */
function upstreamKey(dataOwner: string, grantee: string, grant: GrantData): string {
  return `${dataOwner}\u0000${grantee}\u0000${grant.registeredShapeTree}\u0000${grant.hasDataRegistration}\u0000${grant.hasStorage}`
}

/**
 * Whether an upstream grant's scope covers a downstream grant's scope.
 * `All ⊃ AllFromAgent/AllFromRole ⊃ AllFromRegistry ⊃ SelectedFromRegistry`;
 * `Inherited` is a child scope covered by a same-registration `AllFromRegistry`
 * (or a broader scope), but it never covers a non-inherited scope.
 */
export function scopeCovers(upstream: string, downstream: string): boolean {
  if (upstream === downstream) return true
  if (upstream === INTEROP.All) return true
  const up = SCOPE_ORDER[upstream]
  const down = SCOPE_ORDER[downstream]
  if (up === undefined || down === undefined) return false

  if (downstream === INTEROP.Inherited) {
    // a child grant is a subset of its parent's registration; a same-shape
    // AllFromRegistry source grant covers it, a SelectedFromRegistry set does
    // not (we cannot prove the child instances are in the selection)
    return up >= SCOPE_ORDER[INTEROP.AllFromRegistry]
  }
  if (upstream === INTEROP.Inherited) return false
  // AllFromAgent / AllFromRole are broader than a single registration; the
  // caller enforces the same dataOwner, so they cover this owner's grants.
  return up > down
}

/**
 * Every downstream mode must be granted upstream. A grant with no access modes
 * is not delegable (it would confer nothing; the old SPARQL `VALUES ?mode`
 * check also rejected it).
 */
export function accessModesCover(
  upstream: readonly string[] | undefined,
  downstream: readonly string[] | undefined
): boolean {
  const required = downstream ?? []
  if (required.length === 0) return false
  const available = new Set(upstream ?? [])
  return required.every((mode) => available.has(mode))
}

/** `creatorAccessMode` must not be expanded by delegation (absent = empty). */
export function creatorModesCover(
  upstream: readonly string[] | undefined,
  downstream: readonly string[] | undefined
): boolean {
  const required = downstream ?? []
  if (required.length === 0) return true
  const available = new Set(upstream ?? [])
  return required.every((mode) => available.has(mode))
}

/** For a selected downstream scope, the upstream must include the instances. */
export function instancesCover(upstream: GrantData, downstream: GrantData): boolean {
  if (downstream.scopeOfGrant !== INTEROP.SelectedFromRegistry) return true
  if (
    upstream.scopeOfGrant === INTEROP.All ||
    upstream.scopeOfGrant === INTEROP.AllFromAgent ||
    upstream.scopeOfGrant === INTEROP.AllFromRole ||
    upstream.scopeOfGrant === INTEROP.AllFromRegistry
  ) {
    return true
  }
  if (upstream.scopeOfGrant !== INTEROP.SelectedFromRegistry) return false
  const available = new Set(upstream.hasDataInstance ?? [])
  return (downstream.hasDataInstance ?? []).every((instance) => available.has(instance))
}

/**
 * Whether `upstream` can be the match-based upstream of `downstream`
 * (`downstream.grantee`/`grantedBy` orientation, same data owner/registration/
 * storage and coverage). Does NOT check the upstream's own validity.
 */
export function grantCovers(upstream: GrantData, downstream: GrantData): boolean {
  return (
    upstream.dataOwner === downstream.dataOwner &&
    upstream.grantee === downstream.grantedBy &&
    upstream.registeredShapeTree === downstream.registeredShapeTree &&
    upstream.hasDataRegistration === downstream.hasDataRegistration &&
    upstream.hasStorage === downstream.hasStorage &&
    scopeCovers(upstream.scopeOfGrant, downstream.scopeOfGrant) &&
    accessModesCover(upstream.accessMode, downstream.accessMode) &&
    creatorModesCover(upstream.creatorAccessMode, downstream.creatorAccessMode) &&
    instancesCover(upstream, downstream)
  )
}

/**
 * A same-request child is covered by its parent (shape/registration differ).
 * The parent is the **lifecycle** link, not the authority for the child's
 * scope/modes: the child has its own source/upstream grant for its shape tree.
 * Requiring the parent's modes to cover the child's would reject a legitimate
 * child whose shape tree was granted a different mode set.
 */
export function parentCoversChild(parent: GrantData, child: GrantData): boolean {
  return (
    child.scopeOfGrant === INTEROP.Inherited &&
    parent.dataOwner === child.dataOwner &&
    parent.grantedBy === child.grantedBy &&
    parent.grantee === child.grantee &&
    parent.hasStorage === child.hasStorage
  )
}

/**
 * Validity for every grant in the chain. Grants whose IDs are in `removed` are
 * treated as absent (including `inheritsFromGrant` children). The result maps
 * every grant id to `true`/`false`; a grant not in the map (no id) is invalid.
 */
export function grantChainValidity(
  grants: readonly GrantData[],
  removed: Iterable<string> = []
): Map<string, boolean> {
  const removedSet = new Set(removed)
  const byId = new Map<string, GrantData>()
  for (const grant of grants) {
    if (grant.id) byId.set(grant.id, grant)
  }

  const valid = new Map<string, boolean>()
  for (const [id, grant] of byId) {
    // roots start valid; children (even source children) and delegated grants
    // start invalid and become valid through the fixed point
    valid.set(
      id,
      !removedSet.has(id) && !grant.inheritsFromGrant && grant.grantedBy === grant.dataOwner
    )
  }

  // upstream lookup index: a candidate must match dataOwner + grantee +
  // shape tree + registration + storage; the remaining checks are scope/mode/
  // instance coverage. Without the index every grant would scan the whole
  // registry on every fixed-point iteration.
  const upstreamIndex = new Map<string, GrantData[]>()
  for (const grant of byId.values()) {
    const key = upstreamKey(grant.dataOwner, grant.grantee, grant)
    const list = upstreamIndex.get(key) ?? []
    list.push(grant)
    upstreamIndex.set(key, list)
  }
  const candidatesFor = (grant: GrantData): GrantData[] =>
    upstreamIndex.get(upstreamKey(grant.dataOwner, grant.grantedBy, grant)) ?? []

  let changed = true
  while (changed) {
    changed = false
    for (const [id, grant] of byId) {
      if (valid.get(id) || removedSet.has(id)) continue

      let next = false
      if (grant.inheritsFromGrant) {
        const parent = byId.get(grant.inheritsFromGrant)
        const parentValid =
          !!parent && valid.get(parent.id!) === true && parentCoversChild(parent, grant)
        if (parentValid) {
          if (grant.grantedBy === grant.dataOwner) {
            // a source child is valid while its structural parent is valid;
            // its own shape tree/modes are the owner's grant
            next = true
          } else {
            // a delegated child also needs its own valid upstream (the source
            // grant for its shape tree/registration)
            for (const candidate of candidatesFor(grant)) {
              if (candidate.id === id) continue
              if (valid.get(candidate.id!) !== true) continue
              if (grantCovers(candidate, grant)) {
                next = true
                break
              }
            }
          }
        }
      } else if (grant.grantedBy !== grant.dataOwner) {
        for (const candidate of candidatesFor(grant)) {
          if (candidate.id === id) continue
          if (valid.get(candidate.id!) !== true) continue
          if (grantCovers(candidate, grant)) {
            next = true
            break
          }
        }
      }
      // a source grant with no inheritsFromGrant was initialized valid; no
      // other grant can make it valid here
      if (next) {
        valid.set(id, true)
        changed = true
      }
    }
  }

  return valid
}

/**
 * The revocation closure: the removed grants plus every grant that was valid
 * **before** the removal and is invalid **after** it, plus all
 * `inheritsFromGrant` descendants of that set. Grants that were already
 * invalid before the operation are not swept up (they are unrelated to this
 * revocation and are the sweep's business); this keeps pre-existing invalid
 * grants — e.g. public-client grants with no chain upstream — out of every
 * revocation. A grant with an alternative valid upstream stays valid and is
 * not removed (replacement re-anchoring).
 */
export function invalidGrantsAfterRemoval(
  grants: readonly GrantData[],
  removed: Iterable<string> = []
): GrantData[] {
  const removedSet = new Set(removed)
  const validBefore = grantChainValidity(grants)
  const validAfter = grantChainValidity(grants, removedSet)

  const invalid = new Set<string>()
  for (const grant of grants) {
    if (!grant.id) continue
    if (removedSet.has(grant.id)) {
      invalid.add(grant.id)
      continue
    }
    if (validBefore.get(grant.id) === true && validAfter.get(grant.id) !== true) {
      invalid.add(grant.id)
    }
  }

  // same-request children of a removed/invalidated grant die with it, even
  // when they were already invalid on their own
  let changed = true
  while (changed) {
    changed = false
    for (const grant of grants) {
      if (!grant.id || invalid.has(grant.id)) continue
      if (grant.inheritsFromGrant && invalid.has(grant.inheritsFromGrant)) {
        invalid.add(grant.id)
        changed = true
      }
    }
  }

  return grants.filter((grant) => !grant.id || invalid.has(grant.id))
}

/** Single-grant convenience for callers that already have the chain. */
export function isGrantValid(
  grant: GrantData,
  grants: readonly GrantData[],
  removed: Iterable<string> = []
): boolean {
  if (!grant.id) return false
  return grantChainValidity(grants, removed).get(grant.id) === true
}
