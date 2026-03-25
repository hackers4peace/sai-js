import type { DataGrantData, FinalDataGrantData } from '@janeirodigital/interop-data-model'
import { discoverAuthorizationAgent, fetchWrapper } from '@janeirodigital/interop-utils'
import {
  APPLICATION_JSON,
  BadRequestHttpError,
  BasicRepresentation,
  ForbiddenHttpError,
  OkResponseDescription,
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
    if (!credentials.agent?.webId || !credentials.client?.clientId) {
      throw new ForbiddenHttpError()
    }
    // TODO: check if WebID served by this authz agent

    const uasId = await discoverAuthorizationAgent(credentials.agent.webId, fetchWrapper(fetch))
    if (credentials.client.clientId !== uasId) {
      throw new ForbiddenHttpError()
    }

    let topGrant: DataGrantData
    try {
      topGrant = JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError(err.message)
    }

    const sai = await this.sessionManager.getSession(topGrant.dataOwner)

    // TODO: support recursive inheritance
    const inheritingGrants: FinalDataGrantData[] = [...(topGrant.hasInheritingGrant ?? [])].map(
      (grant) => ({
        ...grant,
        id: sai.registrySet.hasGrantRegistry.iriForContained(),
      })
    )

    const fetcher = new SparqlEndpointFetcher()

    for (const grant of [topGrant, ...inheritingGrants]) {
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
      const bindingsStream = await fetcher.fetchBindings(this.sparqlEndpoint, query)
      const queryResults = await arrayifyStream<IBindings>(bindingsStream)
      if (!queryResults.length) {
        // TODO: change to UnprocessableEntityHttpError
        throw new BadRequestHttpError('no grant available for delegation')
      }
    }

    // biome-ignore lint/complexity/useLiteralKeys:
    // const upstreamGrantGraph = queryResults[0]?.['g']?.value

    const grantId = sai.registrySet.hasGrantRegistry.iriForContained()
    const finalGrant = {
      ...topGrant,
      id: grantId,
      hasInheritingGrant: inheritingGrants.map((g) => ({ id: g.id })),
    } as FinalDataGrantData

    const allGrants = [finalGrant, ...inheritingGrants]

    const temporal = new Temporal()
    await temporal.init()
    // TODO: we could use start but it could lead to race conditions
    await temporal.client.workflow.execute(storeGrant, {
      taskQueue: 'create-grants',
      args: [allGrants],
      workflowId: crypto.randomUUID(),
    })
    const doc = JSON.stringify(allGrants.map((g) => g.id))
    const representation = new BasicRepresentation(doc, operation.target, APPLICATION_JSON)
    return new OkResponseDescription(representation.metadata, representation.data)
  }
}
