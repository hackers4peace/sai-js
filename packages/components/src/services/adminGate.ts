import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import {
  type SocialAgentRegistrationData,
  getAdminGrantIris,
} from '@janeirodigital/interop-data-model'
import { ForbiddenHttpError } from '@solid/community-server'
import type { CredentialsExtractor, HttpRequest } from '@solid/community-server'

import type { SessionManager } from '../SessionManager.js'

/**
 * Resolve the org webId from the base64url-encoded last path segment — the
 * `/sparql-admin` pattern (also the `AgentIdHandler` one).
 * Query/fragment are stripped first: with `OriginalUrlExtractor`'s
 * `includeQueryString` (default) `operation.target.path` carries them.
 */
export function orgWebIdFromPath(targetPath: string): string {
  const pathname = targetPath.split(/[?#]/u, 1)[0]
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (!segment) {
    throw new ForbiddenHttpError('missing org webId in path')
  }
  return Buffer.from(segment, 'base64url').toString('utf8')
}

/**
 * The admin gate of the admin-gated endpoint (`AdminSparqlHandler`): the
 * caller must be an **admin** of `orgWebId` — the
 * org's social-agent registration of the caller carries a non-empty
 * `hasAdminGrant` marker (403 otherwise); an unknown org is
 * indistinguishable from "not an admin" of it.
 *
 * Returns the **org's** session, used to read the org's registry dataset.
 * Peer data no longer goes through an org session: the admin's own UAS obtains
 * a read-only ID-JAG as the org (`SessionManager.impersonationFetch`).
 */
export async function requireOrgAdmin(
  sessionManager: SessionManager,
  credentialsExtractor: CredentialsExtractor,
  request: HttpRequest,
  orgWebId: string
): Promise<AuthorizationAgent> {
  const credentials = await credentialsExtractor.handleSafe(request)
  if (!credentials.agent) {
    throw new ForbiddenHttpError('this endpoint requires credentials')
  }
  let orgSession: AuthorizationAgent
  let registration: SocialAgentRegistrationData | undefined
  try {
    orgSession = await sessionManager.getSession(orgWebId)
    registration = await orgSession.findSocialAgentRegistration(credentials.agent.webId)
  } catch {
    // An unknown org must be indistinguishable from "not an admin" of it.
    throw new ForbiddenHttpError(`not an admin of ${orgWebId}`)
  }
  if (!registration || getAdminGrantIris(registration).length === 0) {
    throw new ForbiddenHttpError(`not an admin of ${orgWebId}`)
  }
  return orgSession
}
