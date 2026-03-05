import {
  BadRequestHttpError,
  NotFoundHttpError,
  OperationHttpHandler,
  ResponseDescription,
  readableToString,
} from '@solid/community-server'
import type { CredentialsExtractor, OperationHttpHandlerInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'
import type { ReciprocalWebhookStore } from './ReciprocalWebhookStore.js'
import { Temporal } from './temporal/client.js'
import { updateDelegatedGrants } from './temporal/workflows/grants.js'

export class ReciprocalWebhookHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly reciprocalWebhookStore: ReciprocalWebhookStore
  ) {
    super()
  }
  public async handle({ operation }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const channel = await this.reciprocalWebhookStore.findBySendTo(operation.target.path)
    if (!channel) {
      // TODO: unsubscribe
      throw new NotFoundHttpError()
    }

    // TODO: check if sender matches one from the channel
    //
    // const credentials = await this.credentialsExtractor.handleSafe(request)

    // only start workflow on Update
    let requestBody: { type: string }
    try {
      requestBody = JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError(err.message)
    }
    if (requestBody.type === 'Update') {
      const temporal = new Temporal()
      await temporal.init()
      await temporal.client.workflow.start(updateDelegatedGrants, {
        taskQueue: 'create-grants',
        args: [
          {
            webId: channel.webId,
            peerId: channel.peerId,
          },
        ],
        workflowId: crypto.randomUUID(),
      })
    }
    return new ResponseDescription(200)
  }
}
