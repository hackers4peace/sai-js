import {
  CONTEXT,
  INTEROP,
  LWS,
  ODRL,
  asAccessModeTerm,
  discoverAuthorizationAgent,
} from '@janeirodigital/interop-utils'
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint'

import type { VerifiedAccessClaim } from './access-claim.js'
import { verifyAccessClaim } from './access-claim.js'
import type { AccessClaimValidator } from './DelegatedAccessClaimValidator.js'
import type { PodEndpointStore } from './PodEndpointStore.js'
import { agentId } from './util/uriTemplates.js'

/**
 * Raised when an admin-impersonation request is not authorized. The token
 * handler maps it to `invalid_grant` (the request is well formed, the caller
 * just has no authority for it).
 */
export class AdminImpersonationDenied extends Error {
  public static isInstance(error: unknown): error is AdminImpersonationDenied {
    return error instanceof AdminImpersonationDenied
  }
}

/** One read-only admin impersonation request at an organization's UAS. */
export interface AdminImpersonationInput {
  /** The organization whose authority is invoked (its UAS receives the request). */
  org: string
  /** The authenticated admin (the `sub` of the incoming ID-JAG). */
  subject: string
  /** The admin's client; must be the admin's own authorization agent. */
  client: string
  /** The peer storage the read is for. */
  storage: string
}

/** What the ID-JAG handler needs from an admin-impersonation authority. */
export interface AdminImpersonationRequestAuthority {
  /**
   * Returns the organization's access claim for one peer storage, already
   * narrowed to `odrl:read`, or throws {@link AdminImpersonationDenied}.
   */
  authorize(input: AdminImpersonationInput): Promise<VerifiedAccessClaim>
}

/** The `odrl:action` values of one compact ODRL policy. */
function claimActions(policy: unknown): Array<string> {
  const action = (policy as { action?: unknown }).action
  return (Array.isArray(action) ? action : [action]).filter(
    (value): value is string => typeof value === 'string'
  )
}

/**
 * Read-only admin impersonation (org context): an admin of an organization may
 * have that organization's UAS issue an ID-JAG **as the organization**, for one
 * peer storage and only with the `read` action.
 *
 * The authority is the organization's own `interop:AdminGrant` with
 * `interop:scopeOfAdminGrant interop:DataRegistry` — the same predicate the
 * storage exchange uses for `scope: admin`, including the own-UAS client
 * binding — read from the organization's registry dataset. The claim is derived
 * from the **organization's** grants (its registry plus reciprocal mirrors) and
 * then narrowed, so a peer grant that also allows `modify` cannot widen the
 * admin.
 *
 * The organization's own storages are rejected: there the storage's exchange
 * would mint `scope: owner` (all modes), so org-own reads keep using the admin's
 * own token with `scope: admin`.
 *
 * It runs on the **auth** server, so it only depends on the pod endpoint
 * registry (internal SPARQL endpoints) and the claim validator — no storage
 * policy-engine stack.
 */
export class AdminImpersonationAuthority implements AdminImpersonationRequestAuthority {
  private readonly agents = new Map<string, Promise<string | undefined>>()
  private readonly adminChecks = new Map<string, Promise<boolean>>()
  private readonly fetcher = new SparqlEndpointFetcher()

  public constructor(
    private readonly endpointStore: PodEndpointStore,
    private readonly claimValidator?: AccessClaimValidator
  ) {}

  /** Discovers the subject's authorization agent; overridable in tests. */
  protected async discoverAgent(webId: string): Promise<string | undefined> {
    return discoverAuthorizationAgent(webId, fetch)
  }

  /** Whether the org's registry holds a DataRegistry AdminGrant for the subject. */
  protected async hasDataRegistryAdmin(endpoint: string, subject: string): Promise<boolean> {
    return this.fetcher.fetchAsk(
      endpoint,
      `
      ASK {
        GRAPH ?g {
          ?grant <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${INTEROP.AdminGrant}> ;
                 <${INTEROP.scopeOfAdminGrant}> <${INTEROP.DataRegistry}> ;
                 <${LWS.access}> ?policy .
          ?policy <${ODRL.permission}> ?permission .
          ?permission <${ODRL.assignee}> <${subject}> .
        }
      }
    `
    )
  }

  public async authorize(input: AdminImpersonationInput): Promise<VerifiedAccessClaim> {
    const records = await this.endpointStore.findSparqlByWebId(input.org)
    if (records.length === 0) {
      throw new AdminImpersonationDenied(`${input.org} is not served by this authorization server.`)
    }
    // An org's own storage would be exchanged as `scope: owner` (all modes).
    if (records.some((record) => isSameStorage(record.podUrl, input.storage))) {
      throw new AdminImpersonationDenied(
        `${input.storage} is an own storage of ${input.org}; use the admin's own scope instead.`
      )
    }
    if ((await this.agentOf(input.subject)) !== input.client) {
      throw new AdminImpersonationDenied(
        'Admin impersonation requires the admin’s own authorization agent as client.'
      )
    }
    if (!(await this.isDataRegistryAdmin(input.org, records, input.subject))) {
      throw new AdminImpersonationDenied(`${input.subject} is not an admin of ${input.org}.`)
    }

    const claim = await this.claimValidator?.find?.({
      subject: input.org,
      client: agentId(input.org),
      storage: input.storage,
      // The org's ID-JAG is exchanged for a storage access token that serves
      // the admin's reads in that storage.
      forStorage: true,
    })
    if (!claim) {
      throw new AdminImpersonationDenied(`${input.org} holds no access grant for ${input.storage}.`)
    }
    return this.narrowToRead(claim)
  }

  private isDataRegistryAdmin(
    org: string,
    records: Array<{ podUrl: string; endpoint: string }>,
    subject: string
  ): Promise<boolean> {
    const key = `${org}\n${subject}`
    const cached = this.adminChecks.get(key)
    if (cached !== undefined) {
      return cached
    }
    const check = (async (): Promise<boolean> => {
      for (const record of records) {
        try {
          if (await this.hasDataRegistryAdmin(record.endpoint, subject)) {
            return true
          }
        } catch {
          // a store outage on one pod is not an admin grant
        }
      }
      return false
    })()
    this.adminChecks.set(key, check)
    return check
  }

  /** Keep the claim's target/scope and drop every action but `read`. */
  private async narrowToRead(claim: VerifiedAccessClaim): Promise<VerifiedAccessClaim> {
    if (
      !claim.access.every((policy) =>
        claimActions(policy).some((action) => asAccessModeTerm(action) === CONTEXT.read)
      )
    ) {
      throw new AdminImpersonationDenied(
        `${claim.storage} is not readable with ${claim.assignees.join(', ')}.`
      )
    }
    const narrowed = claim.access.map((policy) => ({
      ...(policy as Record<string, unknown>),
      action: [CONTEXT.read],
    }))
    return verifyAccessClaim(narrowed, claim.context, claim.storage)
  }

  private agentOf(subject: string): Promise<string | undefined> {
    const cached = this.agents.get(subject)
    if (cached !== undefined) {
      return cached
    }
    const discovery = this.discoverAgent(subject).catch(() => undefined)
    this.agents.set(subject, discovery)
    return discovery
  }
}

/** Same storage, with or without a trailing slash. */
function isSameStorage(a: string, b: string): boolean {
  return withoutTrailingSlash(a) === withoutTrailingSlash(b)
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
