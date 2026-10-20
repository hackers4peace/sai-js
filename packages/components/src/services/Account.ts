import { cssKv } from '@janeirodigital/interop-utils'
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'
import postgres from 'postgres'

import type { BootstrapAccountInput } from '../temporal/activities/account.js'
import { Temporal } from '../temporal/client.js'
import { bootstrapAccount } from '../temporal/workflows/account.js'
import { agentId, issuanceUrl } from '../util/uriTemplates.js'

/**
 * The auth server's account service. `checkHandle` is a synchronous lookup;
 * `startBootstrapAccount` only derives the account's IRIs and starts the
 * account-bootstrap Temporal workflow (the worker owns the Fuseki/Garage/
 * record I/O — openwiki/architecture/storage-isolation.md), returning the WebID
 * immediately.
 */
export class AccountService {
  private sql: any

  constructor(
    private postgresConnectionString: string,
    private tableName: string,
    private issuer: string,
    private idOrigin: string,
    private docOrigin: string,
    private dataOrigin: string,
    private regOrigin: string
  ) {
    this.sql = postgres(this.postgresConnectionString)
  }

  async checkHandle(handle: string): Promise<boolean> {
    const webIdLinkKey = cssKv.webIdLinkByWebId(`https://${handle}.${this.idOrigin}`)
    const result = await this.sql`
      SELECT EXISTS(
        SELECT 1 FROM ${this.sql(this.tableName)}
        WHERE key = ${webIdLinkKey}
      )
    `
    return !result[0].exists
  }

  /**
   * Derive the account's IRIs, start the bootstrap workflow and return the
   * WebID. The workflow id is stable per account, so a duplicate RPC (a retry,
   * or a double submit) reuses the in-flight/previous execution instead of
   * bootstrapping twice.
   */
  async startBootstrapAccount(accountId: string, handle: string): Promise<string> {
    const webId = `https://${handle}.${this.idOrigin}`
    const input: BootstrapAccountInput = {
      accountId,
      handle,
      webId,
      docId: `https://${this.docOrigin}/${handle}`,
      uas: agentId(webId),
      issuance: issuanceUrl(webId),
      issuer: this.issuer,
      registrySet: `https://${this.regOrigin}/${handle}/`,
      dataRegistry: `https://${handle}.${this.dataOrigin}/`,
    }

    const temporal = new Temporal()
    await temporal.init()
    try {
      await temporal.client!.workflow.start(bootstrapAccount, {
        taskQueue: 'create-grants',
        workflowId: `account-bootstrap:${accountId}`,
        args: [input],
      })
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err
    }
    return webId
  }
}
