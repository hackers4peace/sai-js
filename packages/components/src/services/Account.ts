import {
  dataRegistryTemplate,
  registrySetTemplate,
  webIdTemplate,
} from '@janeirodigital/interop-data-model'
import postgres from 'postgres'
import { agentId } from '../util/uriTemplates.js'

export class AccountService {
  private sql: any

  constructor(
    private sparqlEndpoint: string,
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
    const webIdLinkKey = `accounts/index/webIdLink/webId/https%3A%2F%2F${handle}.id.docker`
    const result = await this.sql`
      SELECT EXISTS(
        SELECT 1 FROM ${this.sql(this.tableName)}
        WHERE key = ${webIdLinkKey}
      )
    `
    return !result[0].exists
  }

  async bootstrapAccount(accountId: string, handle: string): Promise<string> {
    const webId = `https://${handle}.${this.idOrigin}`
    const docId = `https://${this.docOrigin}/${handle}`
    const uas = agentId(webId)
    const dataRegistry = `https://${handle}.${this.dataOrigin}/`
    const registrySet = `https://${this.regOrigin}/${handle}/`
    // TODO: add ACR
    const trigDataset = `
      ${webIdTemplate({ id: webId, document: docId, issuer: this.issuer, uas, registry: registrySet })}
      ${dataRegistryTemplate({ id: dataRegistry })}
      ${registrySetTemplate({ id: registrySet, webId, uas, dataRegistry })}
    `
    const response = await fetch(this.sparqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/trig',
      },
      body: trigDataset,
    })
    if (!response.ok) throw new Error('failed POSTing dataset to the quadstore')
    const key = `accounts/data/${accountId}`
    const rows = await this
      .sql`SELECT value FROM ${this.sql(this.tableName)} WHERE key = ${String(key)}`
    if (rows.length === 0) return undefined
    const accountData = JSON.parse(rows[0].value)
    const ids = {
      pod: crypto.randomUUID(),
      owner: crypto.randomUUID(),
      webId: crypto.randomUUID(),
    }
    accountData['**pod**'] = {
      [ids.pod]: {
        baseUrl: dataRegistry,
        accountId,
        id: ids.pod,
        '**owner**': {
          [ids.owner]: {
            webId,
            visible: true,
            podId: ids.pod,
            id: ids.owner,
          },
        },
      },
    }
    accountData['**webIdLink**'] = {
      [ids.webId]: {
        webId,
        accountId,
        id: ids.webId,
      },
    }
    // TODO: separate update from instert
    const record = {
      [key]: accountData,
      [`accounts/index/webIdLink/${ids.webId}`]: [accountId],
      [`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`]: [accountId],
      [`accounts/index/owner/${ids.owner}`]: [accountId],
      [`accounts/index/pod/${ids.pod}`]: [accountId],
      [`accounts/index/pod/baseUrl/${encodeURIComponent(dataRegistry)}`]: [accountId],
    }
    const entries = Object.entries(record).map(([key, value]) => ({
      key,
      value: JSON.stringify(value),
    }))
    await this.sql`
      INSERT INTO ${this.sql(this.tableName)} ${this.sql(entries as any)}
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `
    return webId
  }
}
