import type { DataGrantData, FinalDataGrantData } from '@janeirodigital/interop-data-model'
import {
  BadRequestHttpError,
  CreatedResponseDescription,
  ForbiddenHttpError,
  OperationHttpHandler,
  arrayifyStream,
  readableToString,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { type IBindings, SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { getLoggerFor } from 'global-logger-factory'
import type { SessionManager } from './SessionManager'
import { Temporal } from './temporal/client.js'
import { storeGrant } from './temporal/workflows/grants.js'
import { INTEROP } from './vocabularies.js'

export class GrantIssuanceHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager,
    private readonly sparqlEndpoint: string
  ) {
    super()
  }
  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const credentials = await this.credentialsExtractor.handleSafe(request)
    // TODO: check clientId if authorization agent
    if (!credentials.agent?.webId) {
      throw new ForbiddenHttpError()
    }

    // TODO: extract and reuse this routing logic
    const regex = /[^/]+$/
    const encoded = operation.target.path.match(regex)[0]
    const ownerId = Buffer.from(encoded, 'base64url').toString('utf8')
    const sai = await this.sessionManager.getSession(ownerId)

    let grant: DataGrantData
    try {
      grant = JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError(err.message)
    }
    // TODO: validate payload
    if (credentials.agent.webId !== grant.grantedBy) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('invalid grantedBy')
    }
    // find grant that can be delegated
    // TODO: handle multiple grants for the same registration, especially with inheritance
    const accessModes = grant.accessMode.map((m) => `<${m}>`).join(' ')

    const requiredInstances = grant.hasDataInstance?.length
      ? grant.hasDataInstance.map((i) => `<${i}>`).join(' ')
      : ''

    const selectedScopeConstraint = requiredInstances
      ? `
            FILTER NOT EXISTS {
              VALUES ?required { ${requiredInstances} }
              FILTER NOT EXISTS {
                ?s <${INTEROP.hasDataInstance}> ?required .
              }
            }
        `
      : ''

    const scopeBlock =
      grant.scopeOfGrant === INTEROP.SelectedFromRegistry
        ? `
          {
            ?s <${INTEROP.scopeOfGrant}> <${INTEROP.AllFromRegistry}> .
          }
          UNION
          {
            ?s <${INTEROP.scopeOfGrant}> <${INTEROP.SelectedFromRegistry}> .
            ${selectedScopeConstraint}
          }
        `
        : `
          ?s <${INTEROP.scopeOfGrant}> <${grant.scopeOfGrant}> .
        `

    const query = `
    SELECT * WHERE {
      GRAPH ?g {
        ?s
          <${INTEROP.dataOwner}> <${grant.dataOwner}>;
          <${INTEROP.grantee}> <${grant.grantedBy}>;
          <${INTEROP.registeredShapeTree}> <${grant.registeredShapeTree}>;
          <${INTEROP.hasStorage}> <${grant.hasStorage}>;
          <${INTEROP.hasDataRegistration}> <${grant.hasDataRegistration}>;
          <${INTEROP.accessMode}> ?mode .

        VALUES ?mode { ${accessModes} }

        ${scopeBlock}
      }
    }
    `
    const fetcher = new SparqlEndpointFetcher()
    const bindingsStream = await fetcher.fetchBindings(this.sparqlEndpoint, query)
    const queryResults = await arrayifyStream<IBindings>(bindingsStream)
    if (!queryResults.length) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('no grant available for delegation')
    }
    // biome-ignore lint/complexity/useLiteralKeys:
    const upstreamGrantGraph = queryResults[0]?.['g']?.value

    const grantId = sai.registrySet.hasGrantRegistry.iriForContained()
    const temporal = new Temporal()
    await temporal.init()
    // TODO: we could use start but it could lead to race conditions
    await temporal.client.workflow.execute(storeGrant, {
      taskQueue: 'create-grants',
      args: [{ ...grant, id: grantId } as FinalDataGrantData],
      workflowId: crypto.randomUUID(),
    })
    return new CreatedResponseDescription({ path: grantId })
  }
}
