/**
 * The vocabulary tokens of the combined access/grant context.
 *
 * `CONTEXT` is generated from the context itself, so every term the context
 * defines is available as a const (`CONTEXT.AllFromRegistry`,
 * `CONTEXT.AccessGrant`, `CONTEXT.read`) without maintaining a second map of
 * IRIs. `CONTEXT_IRI` is the reverse lookup for writes, SPARQL text and raw
 * payload boundaries.
 *
 * The per-vocabulary objects below are typed views over `CONTEXT`: they only
 * select the terms that belong in a given position (scope, access mode, …),
 * the token/IRI values still come from the context.
 */

import { contextIndex, contextIri, contextTerm, contextTerms, pickTerms } from './context-terms.ts'
import { odrlAccessContext } from './odrl-id-jag-context.ts'

export type { ContextIndex, ContextTerm } from './context-terms.ts'

const INDEX = contextIndex(odrlAccessContext)

/** Every term of the combined access/grant context: `CONTEXT.Term === 'Term'`. */
export const CONTEXT = contextTerms(odrlAccessContext)

/** Token → absolute IRI (`CONTEXT_IRI[CONTEXT.AllFromRegistry]`). */
export const CONTEXT_IRI: Record<string, string> = INDEX.iriByTerm

/** `interop:scopeOfGrant` values. */
export const ScopeOfGrant = pickTerms(CONTEXT, [
  'All',
  'AllFromAgent',
  'AllFromRegistry',
  'AllFromRole',
  'SelectedFromRegistry',
  'Inherited',
] as const)
export type ScopeOfGrantTerm = (typeof ScopeOfGrant)[keyof typeof ScopeOfGrant]

/** `interop:accessMode` / `odrl:action` values (the SAI access actions). */
export const AccessMode = pickTerms(CONTEXT, ['read', 'modify', 'create', 'delete'] as const)
export type AccessModeTerm = (typeof AccessMode)[keyof typeof AccessMode]

/** `interop:accessNecessity` values. */
export const AccessNecessity = pickTerms(CONTEXT, ['AccessRequired', 'AccessOptional'] as const)
export type AccessNecessityTerm = (typeof AccessNecessity)[keyof typeof AccessNecessity]

/** `odrl:profile` values used by SAI grants and claims. */
export const AccessProfile = pickTerms(CONTEXT, ['AccessProfile'] as const)
export type AccessProfileTerm = (typeof AccessProfile)[keyof typeof AccessProfile]

/** Classes used on grants, policies, permissions and targets. */
export const GrantClass = pickTerms(CONTEXT, [
  'AccessGrant',
  'AdminGrant',
  'Agreement',
  'Asset',
  'AssetCollection',
  'DataRegistration',
  'SocialAgent',
  'Storage',
  'ShapeTree',
] as const)
export type GrantClassTerm = (typeof GrantClass)[keyof typeof GrantClass]

const SCOPE_TERMS = new Set<string>(Object.keys(ScopeOfGrant))
const ACCESS_MODE_TERMS = new Set<string>(Object.keys(AccessMode))
const ACCESS_NECESSITY_TERMS = new Set<string>(Object.keys(AccessNecessity))
const ACCESS_PROFILE_TERMS = new Set<string>(Object.keys(AccessProfile))
const GRANT_CLASS_TERMS = new Set<string>(Object.keys(GrantClass))

function termIn(terms: ReadonlySet<string>, value: string | undefined): string | undefined {
  const term = contextTerm(INDEX, value)
  return term !== undefined && terms.has(term) ? term : undefined
}

export const asScopeTerm = (value: string | undefined): ScopeOfGrantTerm | undefined =>
  termIn(SCOPE_TERMS, value) as ScopeOfGrantTerm | undefined

export const asAccessModeTerm = (value: string | undefined): AccessModeTerm | undefined =>
  termIn(ACCESS_MODE_TERMS, value) as AccessModeTerm | undefined

export const asAccessNecessityTerm = (value: string | undefined): AccessNecessityTerm | undefined =>
  termIn(ACCESS_NECESSITY_TERMS, value) as AccessNecessityTerm | undefined

export const asAccessProfileTerm = (value: string | undefined): AccessProfileTerm | undefined =>
  termIn(ACCESS_PROFILE_TERMS, value) as AccessProfileTerm | undefined

export const asGrantClassTerm = (value: string | undefined): GrantClassTerm | undefined =>
  termIn(GRANT_CLASS_TERMS, value) as GrantClassTerm | undefined

/** IRI of a scope token (for SPARQL text and legacy RPC boundaries). */
export const scopeIri = (value: string): string => contextIri(INDEX, value)

/** IRI of an access-mode token. */
export const accessModeIri = (value: string): string => contextIri(INDEX, value)
