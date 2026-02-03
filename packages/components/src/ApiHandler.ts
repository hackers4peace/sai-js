import { RpcRouter } from '@effect/rpc'
import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { SaiService, router } from '@janeirodigital/sai-api-messages'
import {
  BasicRepresentation,
  ForbiddenHttpError,
  InternalServerError,
  OkResponseDescription,
  OperationHttpHandler,
  SOLID_HTTP,
  readableToString,
} from '@solid/community-server'
import type { CookieStore, WebIdStore } from '@solid/community-server'
import type { OperationHttpHandlerInput, ResponseDescription } from '@solid/community-server'
import { Effect, Layer } from 'effect'
import { getLoggerFor } from 'global-logger-factory'
import type { PushSubscription } from 'web-push'
import type { SessionManager } from './SessionManager'
import type { UiPushSubscriptionStore } from './UiPushSubscriptionStore.js'
import type { AccountService } from './services/Account.js'
import {
  acceptInvitation,
  createInvitation,
  getApplications,
  getSocialAgentInvitations,
  getSocialAgents,
  getUnregisteredApplication,
} from './services/AgentRegistry.js'
import { getDescriptions, recordAuthorization } from './services/Authorization.js'
import { getDataRegistries, listDataInstances } from './services/DataRegistry.js'
import {
  getResource,
  requestAccessUsingApplicationNeeds,
  shareResource,
} from './services/ShareResource.js'

export class ApiHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  constructor(
    private readonly cookieStore: CookieStore,
    private readonly webIdStore: WebIdStore,
    private readonly uiPushSubscriptionStore: UiPushSubscriptionStore,
    private readonly sessionManager: SessionManager,
    private readonly accountService: AccountService
  ) {
    super()
  }
  public async handle({ operation }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    // Determine account
    const cookie = operation.body.metadata.get(SOLID_HTTP.terms.accountCookie)?.value
    if (!cookie) {
      throw new ForbiddenHttpError()
    }
    const accountId = await this.cookieStore.get(cookie)
    if (!accountId) {
      // TODO: find better error
      throw new InternalServerError('no accountId')
    }
    const webIdLinks = await this.webIdStore.findLinks(accountId)
    const webId = webIdLinks[0]?.webId
    let session: AuthorizationAgent
    if (webId) {
      try {
        session = await this.sessionManager.getSession(webId)
      } catch (err) {
        console.error(err)
        throw err
      }
    }

    const SaiServiceLive = Layer.succeed(
      SaiService,
      // @ts-ignore
      SaiService.of({
        getWebId: () => Effect.succeed(session.webId),
        checkHandle: (handle: string) =>
          Effect.promise(() => this.accountService.checkHandle(handle)),
        bootstrapAccount: (handle: string) =>
          Effect.promise(() => this.accountService.bootstrapAccount(accountId, handle)),
        getDataRegistries: (agentId, lang) =>
          Effect.promise(() => getDataRegistries(session, agentId, lang)),
        listDataInstances: (agentId, registrationId) =>
          Effect.promise(() => listDataInstances(session, agentId, registrationId)),
        getApplications: () => Effect.promise(() => getApplications(session)),
        getUnregisteredApplication: (id) =>
          Effect.promise(() => getUnregisteredApplication(session, id)),
        getSocialAgents: () => Effect.promise(() => getSocialAgents(session)),
        getSocialAgentInvitations: () => Effect.promise(() => getSocialAgentInvitations(session)),
        getAuthorizationData: (agentId, agentType, lang) =>
          Effect.promise(() => getDescriptions(session, agentId, agentType, lang)),
        authorizeApp: (authorization) =>
          Effect.promise(() => recordAuthorization(session, authorization)),
        registerPushSubscription: (subscription: PushSubscription) =>
          Effect.promise(() =>
            this.uiPushSubscriptionStore.create(session.webId, accountId, subscription)
          ),
        getResource: (id, lang) => Effect.promise(() => getResource(session, id, lang)),
        shareResource: (authorization) =>
          Effect.promise(() => shareResource(session, authorization)),
        requestAccessUsingApplicationNeeds: (applicationId, agentId) =>
          Effect.promise(() => requestAccessUsingApplicationNeeds(session, applicationId, agentId)),
        createInvitation: (label, note) =>
          Effect.promise(() => createInvitation(session, { label, note })),
        acceptInvitation: (capabilityUrl, label, note) =>
          Effect.promise(() => acceptInvitation(session, { capabilityUrl, label, note })),
      })
    )
    const rpcHandler = RpcRouter.toHandlerNoStream(router)

    const requestBody = JSON.parse(await readableToString(operation.body.data))
    const program = Effect.gen(function* () {
      return yield* rpcHandler(requestBody)
    }).pipe(Effect.provide(SaiServiceLive))
    const payload = await Effect.runPromise(program)

    const doc = JSON.stringify(payload)
    const representation = new BasicRepresentation(doc, operation.target, 'application/json')
    return new OkResponseDescription(representation.metadata, representation.data)
  }
}
