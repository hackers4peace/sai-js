import type { DataGrantData } from '@janeirodigital/interop-data-model'
import {
  BadRequestHttpError,
  CreatedResponseDescription,
  ForbiddenHttpError,
  OperationHttpHandler,
  readableToString,
} from '@solid/community-server'
import type {
  CredentialsExtractor,
  OperationHttpHandlerInput,
  ResponseDescription,
} from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'
import type { SessionManager } from './SessionManager'
import { Temporal } from './temporal/client.js'
import { storeGrant } from './temporal/workflows/grants.js'

export class GrantIssuanceHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager
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

    let requestBody: { type: string }
    try {
      requestBody = JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError(err.message)
    }
    // TODO: validate payload
    // credentials.agent.webid === requestBody.grantedBy
    const grantId = sai.registrySet.hasGrantRegistry.iriForContained()
    const temporal = new Temporal()
    await temporal.init()
    // TODO: we could use start but it could lead to race conditions
    await temporal.client.workflow.execute(storeGrant, {
      taskQueue: 'create-grants',
      args: [
        {
          iri: grantId,
          data: requestBody as unknown as DataGrantData,
        },
      ],
      workflowId: crypto.randomUUID(),
    })
    return new CreatedResponseDescription({ path: grantId })
  }
}
