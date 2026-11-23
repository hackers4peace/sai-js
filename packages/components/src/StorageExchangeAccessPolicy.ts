import { INTEROP, LWS, ODRL, RDF, discoverAuthorizationAgent } from '@janeirodigital/interop-utils'
import { SpanStatusCode } from '@opentelemetry/api'
import type { PodStore, StorageLocationStrategy } from '@solid/community-server'
import { LwsExchangeAccessDeniedError, LwsTokenExchangePolicy } from '@solid/community-server'
import type { LwsTokenExchangePolicyInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'
import { DataFactory, Store } from 'n3'

import type { SaiAuthorizationManager } from './SaiAuthorizationManager.js'
import { sharedTracer } from './tracing/otel-state.js'

// oxlint-disable-next-line typescript/unbound-method -- n3's DataFactory methods never read `this`
const { namedNode } = DataFactory

/** Discovers the subject's authorization agent (its UAS). */
export type AuthorizationAgentDiscovery = (webId: string) => Promise<string | undefined>

/**
 * The data-storage exchange policy (C6): a claimless ID-JAG exchange gets a
 * storage `scope` only for
 *
 * - the **owner** of the requested storage, with the subject's own
 *   authorization agent (UAS) as client (`scope: owner`, all modes), or
 * - the holder of a `DataRegistry`-scoped `AdminGrant` for that storage, again
 *   with the subject's own UAS as client (`scope: admin`, read-only).
 *
 * Any other claimless exchange is denied with `invalid_grant`. A present ODRL
 * access claim never reaches this policy: the claim is the authority and the
 * handler does not mint a scope next to it.
 *
 * The policy runs at exchange time only, so revocation is eventual and bounded
 * by the access-token lifetime (D26). It never re-reads grants at request time.
 */
export class StorageExchangeAccessPolicy extends LwsTokenExchangePolicy {
  private readonly logger = getLoggerFor(this)
  private readonly agents = new Map<string, Promise<string | undefined>>()

  public constructor(
    private readonly podStore: PodStore,
    private readonly storageStrategy: StorageLocationStrategy,
    private readonly manager: SaiAuthorizationManager
  ) {
    super()
  }

  /** Discovers the subject's authorization agent; overridable in tests. */
  protected async discoverAgent(webId: string): Promise<string | undefined> {
    return discoverAuthorizationAgent(webId, fetch)
  }

  public async determineScope(
    input: LwsTokenExchangePolicyInput
  ): Promise<Array<string> | undefined> {
    // The decision is the storage AS's authorization event: record the input,
    // the minted scope and a denial so the token chain is observable end to end.
    const span = sharedTracer('sai-lws').startSpan('sai.lws.exchange-scope')
    span.setAttributes({
      'sai.lws.resource': input.resource,
      'sai.lws.subject_id': input.subject,
      'sai.lws.client_id': input.client,
      'sai.lws.subject_issuer': input.issuer,
    })
    try {
      let storage: string
      try {
        storage = (await this.storageStrategy.getStorageIdentifier({ path: input.resource })).path
      } catch {
        throw new LwsExchangeAccessDeniedError(`${input.resource} is not a storage.`)
      }
      span.setAttribute('sai.lws.storage', storage)

      // The owner's own UAS is the only client that receives the owner scope; an
      // owner using an app client needs a normal access claim.
      if (await this.isOwner(storage, input.subject, input.client)) {
        span.setAttribute('sai.lws.scope', 'owner')
        return ['owner']
      }
      if (await this.isAdmin(input.resource, input.subject, input.client)) {
        span.setAttribute('sai.lws.scope', 'admin')
        return ['admin']
      }
      throw new LwsExchangeAccessDeniedError(
        `No access claim, owner, or admin authority for ${input.resource}.`
      )
    } catch (error: unknown) {
      span.setAttribute('sai.lws.denied', true)
      span.setAttribute('sai.lws.denied_reason', (error as Error).message)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
      throw error
    } finally {
      span.end()
    }
  }

  private async isOwner(storage: string, subject: string, client: string): Promise<boolean> {
    const pod = await this.podStore.findByBaseUrl(storage)
    if (!pod) {
      return false
    }
    const owners = await this.podStore.getOwners(pod.id)
    if (!owners.some((owner) => owner.webId === subject)) {
      return false
    }
    return (await this.agentOf(subject)) === client
  }

  private async isAdmin(storage: string, subject: string, client: string): Promise<boolean> {
    if ((await this.agentOf(subject)) !== client) {
      return false
    }
    let data: Awaited<ReturnType<SaiAuthorizationManager['getAuthorizationData']>>
    try {
      data = await this.manager.getAuthorizationData(storage)
    } catch (error: unknown) {
      // A store outage is a denial, not a claimless grant.
      this.logger.warn(`could not read admin grants for ${storage}: ${(error as Error).message}`)
      return false
    }
    if (!data) {
      return false
    }
    const store = new Store(Array.isArray(data) ? data : [...data])
    const assignee = namedNode(subject)
    for (const grant of store.getSubjects(
      namedNode(RDF.type),
      namedNode(INTEROP.AdminGrant),
      null
    )) {
      if (
        store.countQuads(
          grant,
          namedNode(INTEROP.scopeOfAdminGrant),
          namedNode(INTEROP.DataRegistry),
          null
        ) === 0
      ) {
        continue
      }
      for (const policy of store.getObjects(grant, namedNode(LWS.access), null)) {
        for (const permission of store.getObjects(policy, namedNode(ODRL.permission), null)) {
          if (store.countQuads(permission, namedNode(ODRL.assignee), assignee, null) > 0) {
            return true
          }
        }
      }
    }
    return false
  }

  private agentOf(subject: string): Promise<string | undefined> {
    const cached = this.agents.get(subject)
    if (cached) {
      return cached
    }
    const discovery = this.discoverAgent(subject).catch((error: unknown) => {
      this.logger.warn(`UAS discovery failed for ${subject}: ${(error as Error).message}`)
      return undefined
    })
    this.agents.set(subject, discovery)
    return discovery
  }
}
