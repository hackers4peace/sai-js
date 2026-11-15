import { lwsV1Context } from './lws-v1-context.ts'
import { INTEROP, LWS, ODRL } from './namespaces.ts'
import { odrlContext } from './odrl-context.ts'
import { saiContext } from './sai-context.ts'

/**
 * Public JSON-LD context of the ODRL `access` claim carried by ID-JAGs and the
 * access tokens they are exchanged for.
 *
 * The claim uses the same ODRL/LWS/SAI terms as grants and access requests, so
 * a storage evaluates one shape everywhere. The context lives in the SAI
 * namespace and has a local bundled copy (registered in `jsonld-parser.ts`):
 * token verification must never fetch a remote context.
 *
 * Only the `access` subtree is JSON-LD. The remaining JWT claims (`sub`, `aud`,
 * `iss`, `exp`, …) are OAuth claims and must not be expanded together with it.
 */
export const ODRL_ID_JAG_CONTEXT =
  'https://www.w3.org/ns/solid/interop-context/v1/odrl-id-jag-context'

/**
 * Term definitions shared by grants/requests and the token-carried ODRL
 * `access` claim. `accessContext` and {@link odrlIdJagContext} compose the same
 * terms over the bundled LWS/ODRL/SAI contexts; keeping them here makes the
 * grant and token shapes impossible to drift apart.
 */
export const accessClaimTerms = {
  '@version': 1.1,
  type: { '@id': '@type', '@container': '@set' },
  access: { '@id': LWS.access, '@container': '@set' },
  permission: { '@id': ODRL.permission, '@container': '@set' },
  action: { '@id': ODRL.action, '@type': '@vocab', '@container': '@set' },
  target: { '@id': ODRL.target },
  source: { '@id': ODRL.source, '@type': '@id', '@container': '@set' },
  assigner: { '@id': ODRL.assigner, '@type': '@id' },
  assignee: { '@id': ODRL.assignee, '@type': '@id' },
  uid: { '@id': ODRL.uid, '@type': '@id' },
  profile: { '@id': ODRL.profile, '@type': '@id' },
  owner: { '@id': INTEROP.dataOwner, '@type': '@id' },
  storage: { '@id': LWS.storage, '@type': '@id' },
} as const

/** Body of the grant/request/access-claim JSON-LD context. */
export const odrlAccessContext = {
  ...lwsV1Context['@context'],
  ...odrlContext['@context'],
  ...saiContext['@context'],
  ...accessClaimTerms,
}

/** Bundled document for {@link ODRL_ID_JAG_CONTEXT}. */
export const odrlIdJagContext = {
  '@context': odrlAccessContext,
}
