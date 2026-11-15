import { INTEROP, LWS, ODRL, ODRL_ID_JAG_CONTEXT, toStore } from '@janeirodigital/interop-utils'
import type { Term } from '@rdfjs/types'
import { BadRequestHttpError } from '@solid/community-server'
import { DataFactory, type Store } from 'n3'

const { namedNode } = DataFactory

const GRANT_SCOPES = new Set<string>([
  INTEROP.SelectedFromRegistry,
  INTEROP.AllFromRegistry,
  INTEROP.Inherited,
  INTEROP.AllFromAgent,
])

export interface VerifiedAccessClaim {
  /** The compact JSON-LD policies exactly as they go into the token. */
  access: unknown[]
  /** The JSON-LD context of {@link access}. */
  context: string
  /** The single storage every target of the claim is bound to. */
  storage: string
  /** Every `odrl:assigner` of the claim (normally one: the requester). */
  assigners: string[]
  /** Every `odrl:assignee` of the claim (normally one: the client/actor). */
  assignees: string[]
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

function iriValues(store: Store, subject: Term, predicate: string, what: string): string[] {
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
 */
export async function verifyAccessClaim(
  access: unknown,
  context: unknown,
  expectedStorage?: string
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
    if (!GRANT_SCOPES.has(scope)) badRequest(`${scope} is not a supported grant scope.`)
  }

  const permissions = store.getObjects(null, namedNode(ODRL.permission), null)
  const assigners = new Set<string>()
  const assignees = new Set<string>()
  const targets = new Set<string>()
  for (const permission of permissions) {
    assigners.add(oneIri(store, permission, ODRL.assigner, 'odrl:assigner'))
    assignees.add(oneIri(store, permission, ODRL.assignee, 'odrl:assignee'))
    iriValues(store, permission, ODRL.action, 'odrl:action')
    for (const target of iriValues(store, permission, ODRL.target, 'odrl:target')) {
      targets.add(target)
    }
  }
  if (targets.size === 0) badRequest('at least one odrl:target is required.')

  const storages = new Set<string>()
  for (const target of targets) {
    storages.add(oneIri(store, namedNode(target), LWS.storage, 'lws:storage'))
    oneIri(store, namedNode(target), INTEROP.dataOwner, 'interop:dataOwner')
    iriValues(store, namedNode(target), ODRL.source, 'odrl:source')
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
