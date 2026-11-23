import {
  getRegistrationLinks,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { RegistrySetData } from '@janeirodigital/interop-data-model'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { INTEROP } from '@janeirodigital/interop-utils'

import type { PodEndpointStore } from '../PodEndpointStore.js'
import type { SessionManager } from '../SessionManager.js'

/** The requested context is not allowed for the signed-in user. */
export class ContextError extends Error {}

/**
 * The context's **own** pod (storage) containing the IRI, if any. Peer
 * resources are outside this allowlist, so they are read with the read-only
 * org impersonation instead.
 */
export function ownStorageOf(
  ctx: Pick<ResolvedContext, 'endpoints'>,
  iri: string
): string | undefined {
  return [...ctx.endpoints.keys()]
    .filter((pod) => iri === pod || iri.startsWith(pod))
    .toSorted((a, b) => b.length - a.length)[0]
}

/**
 * The resolved context a service operation runs in (§2.4 of
 * org-admin-feature.md). `session` is **ALWAYS the signed-in user's own
 * AuthorizationAgent** — no org session is minted (org-context-sparql.md
 * phase 3). The org context is gated on the admin marker, then targets the
 * org's registry set; owner identity for writes is `webId` (the context).
 */
export type ResolvedContext = {
  /** ALWAYS the signed-in user's own AuthorizationAgent */
  session: AuthorizationAgent
  /** target registries: own (personal) or org's (admin context) */
  registrySet: RegistrySetData
  /** owner identity for writes: context webId */
  webId: string
  /** the signed-in user's webId */
  userWebId: string
  /**
   * Owner-scoped endpoint allowlist for `webId` (`podUrl -> endpoint`) from
   * the internal account storage. Data-plane reads may only use these.
   */
  endpoints: Map<string, string>
  /**
   * LWS fetch for one storage, read-only for an admin acting in an org
   * context:
   *
   * - personal context: the user's own session fetch;
   * - the context's **own** pods: the admin's own credential, which the storage
   *   exchange turns into `scope: admin` (read-only) — never an in-process org
   *   session, which the storage would treat as the owner (`scope: owner`);
   * - a **peer** storage: read-only impersonation of the org
   *   (`SessionManager.impersonationFetch`), so the peer sees the org and only
   *   ever `odrl:read`.
   */
  storageFetch: (storage: string) => Promise<WhatwgFetch>
}

/**
 * True when the signed-in user is an admin of `orgWebId`. The admin marker
 * lives on the org's registration of the user — the reciprocal of the user's
 * own registration of the org — as a non-empty `hasAdminGrant` link (§2.2
 * asymmetry of org-admin-feature.md).
 */
async function isAdminOf(userSession: AuthorizationAgent, orgWebId: string): Promise<boolean> {
  const registration = await userSession.findSocialAgentRegistration(orgWebId)
  if (!registration?.reciprocalRegistration) {
    return false
  }
  // only the link presence matters — one link query over the mirrored reciprocal
  // on the session's internal endpoint, no registration framing
  // (see openwiki/architecture/federation.md)
  const markers = await getRegistrationLinks(
    localSparqlTransport(userSession.sparqlEndpoint),
    registration.reciprocalRegistration,
    INTEROP.hasAdminGrant
  )
  return markers.length > 0
}

/**
 * Resolve a request's `context` webId into the struct services operate on.
 *
 * - the personal context (the user's own webId) is always allowed and
 *   resolves to the user's own registry set;
 * - an organization context is allowed only when the user is an admin of
 *   that org; the org's registry set is resolved through the org's agent-id
 *   document (`Link: rel="interop:hasRegistrySet"`, served only to admins —
 *   §2.3) and **no second session is built**: the user's own AA performs
 *   operations, targeting `ctx.registrySet` and owning writes as
 *   `ctx.webId`. Org-context reads must already be SPARQL-backed (§3.0/
 *   3b) — per-resource `.acr`s never grant the admin over HTTP.
 */
export async function resolveContext(
  userSession: AuthorizationAgent,
  context: string,
  endpointStore: PodEndpointStore,
  sessionManager: SessionManager
): Promise<ResolvedContext> {
  if (context === userSession.webId) {
    return {
      session: userSession,
      registrySet: userSession.registrySet,
      webId: userSession.webId,
      userWebId: userSession.webId,
      endpoints: userSession.sparqlEndpoints,
      storageFetch: () => Promise.resolve(userSession.fetch),
    }
  }
  if (!(await isAdminOf(userSession, context))) {
    throw new ContextError(`not an admin of ${context}`)
  }
  const registrySet = await userSession.getRegistrySet(context)
  // the org's own records from the internal account storage — the org context's
  // allowlist (the admin never gets a wider set than the context's pods)
  const records = await endpointStore.findSparqlByWebId(context)
  const endpoints = new Map(records.map((record) => [record.podUrl, record.endpoint]))
  return {
    session: userSession,
    registrySet,
    webId: context,
    userWebId: userSession.webId,
    endpoints,
    storageFetch: async (storage: string): Promise<WhatwgFetch> => {
      const own = ownStorageOf({ endpoints }, storage)
      return own
        ? sessionManager.storageFetch(userSession.webId, own)
        : sessionManager.impersonationFetch(userSession.webId, context, storage)
    },
  }
}
