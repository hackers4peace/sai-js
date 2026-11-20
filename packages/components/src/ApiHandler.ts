import { Resource, Tracer } from '@effect/opentelemetry'
import { Etag, HttpPlatform } from '@effect/platform'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { withSpan } from '@janeirodigital/interop-utils'
import { IRI, SaiService, rpcGroup, rpcHandlers } from '@janeirodigital/sai-api-messages'
import {
  BasicRepresentation,
  ForbiddenHttpError,
  InternalServerError,
  OperationHttpHandler,
  ResponseDescription,
  SOLID_HTTP,
  readableToString,
} from '@solid/community-server'
import type { CookieStore, WebIdStore } from '@solid/community-server'
import type { OperationHttpHandlerInput } from '@solid/community-server'
import { Effect, Layer } from 'effect'
import { getLoggerFor } from 'global-logger-factory'
import type { PushSubscription } from 'web-push'

import type { PodEndpointStore } from './PodEndpointStore.js'
import type { AccountService } from './services/Account.js'
import { addAdmin, removeAdmin } from './services/Admin.js'
import { getApplications, getUnregisteredApplication } from './services/ApplicationRegistry.js'
import {
  archiveAccessRequest,
  getDescriptions,
  listAuthorizations,
  recordAuthorization,
  revokeAuthorizations,
  toAuthorizationRevocationFailure,
} from './services/Authorization.js'
import { resolveContext } from './services/Context.js'
import { getDataRegistries, listDataInstances } from './services/DataRegistry.js'
import { createInvitation, getSocialAgentInvitations } from './services/InvitationRegistry.js'
import { createRole, deleteRole, getRoles, updateRole } from './services/RoleRegistry.js'
import {
  getResource,
  requestAccessUsingAccessNeeds,
  requestAccessUsingApplicationNeeds,
  shareResource,
} from './services/ShareResource.js'
import { acceptInvitation, getSocialAgents } from './services/SocialAgentRegistry.js'
import type { SessionManager } from './SessionManager'
import { temporalPluginConfig } from './tracing/otel-state.js'
import type { UiPushSubscriptionStore } from './UiPushSubscriptionStore.js'

export class ApiHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  constructor(
    private readonly cookieStore: CookieStore,
    private readonly webIdStore: WebIdStore,
    private readonly uiPushSubscriptionStore: UiPushSubscriptionStore,
    private readonly sessionManager: SessionManager,
    private readonly accountService: AccountService,
    private readonly endpointStore: PodEndpointStore
  ) {
    super()
  }
  public async handle({
    operation,
    request: httpRequest,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    // Manual active RPC span: the outgoing client spans (CID / data /
    // registry / shapetrees hops) nest under it. No-op when tracing is off.
    return withSpan('sai-components', 'sai.rpc.handle', async (span) => {
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
      span.setAttribute('sai.account', accountId)
      const webIdLinks = await this.webIdStore.findLinks(accountId)
      const webId = webIdLinks[0]?.webId
      if (webId) span.setAttribute('sai.webid', webId)
      let session: AuthorizationAgent
      if (webId) {
        try {
          session = await this.sessionManager.getSession(webId)
        } catch (err) {
          console.error(err)
          throw err
        }
      }

      const requestBody = await readableToString(operation.body.data)
      if (span.isRecording()) {
        span.setAttribute('sai.rpc.request', requestBody)
      }

      const SaiServiceLive = Layer.succeed(
        SaiService,
        // @ts-ignore
        SaiService.of({
          getWebId: () => Effect.succeed(session.webId),
          checkHandle: (handle: string) =>
            Effect.promise(() => this.accountService.checkHandle(handle)),
          bootstrapAccount: (handle: string) =>
            Effect.promise(() => this.accountService.startBootstrapAccount(accountId, handle)),
          getDataRegistries: (agentId, lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getDataRegistries(ctx, agentId, lang)
            }),
          listDataInstances: (agentId, registrationId, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return listDataInstances(ctx, agentId, registrationId, 'en')
            }),
          getApplications: (context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getApplications(ctx)
            }),
          getUnregisteredApplication: (id) =>
            Effect.promise(() => getUnregisteredApplication(session, id)),
          getSocialAgents: (lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getSocialAgents(ctx, lang)
            }),
          getRoles: (lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getRoles(ctx, lang)
            }),
          createRole: (label, members, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return createRole(ctx, label, members)
            }),
          updateRole: (id, label, members, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return updateRole(ctx, id, label, members)
            }),
          deleteRole: (id, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return deleteRole(ctx, id)
            }),
          getSocialAgentInvitations: (lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getSocialAgentInvitations(ctx, lang)
            }),
          getAuthorizationData: (agentId, lang, accessNeedGroupIri, accessRequestIri, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getDescriptions(ctx, agentId, lang, accessNeedGroupIri, accessRequestIri)
            }),
          getAuthorizations: (grantee, lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return listAuthorizations(ctx, grantee, lang)
            }),
          authorizeApp: (authorization, accessRequestIri, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return recordAuthorization(ctx, authorization, accessRequestIri)
            }),
          revokeAuthorizations: (authorizations, context) =>
            Effect.tryPromise({
              try: async () => {
                const ctx = await resolveContext(
                  session,
                  context,
                  this.endpointStore,
                  this.sessionManager
                )
                const result = await revokeAuthorizations(ctx, authorizations)
                return {
                  ...(result.activityId ? { activityId: IRI.make(result.activityId) } : {}),
                  authorizations: result.authorizations.map((id) => IRI.make(id)),
                }
              },
              catch: toAuthorizationRevocationFailure,
            }),
          addAdmin: (agentWebId, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return addAdmin(ctx, agentWebId)
            }),
          removeAdmin: (agentWebId, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return removeAdmin(ctx, agentWebId)
            }),
          registerPushSubscription: (subscription: PushSubscription) =>
            Effect.promise(() =>
              this.uiPushSubscriptionStore.create(session.webId, accountId, subscription)
            ),
          getResource: (id, lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return getResource(ctx, id, lang)
            }),
          shareResource: (authorization, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return shareResource(ctx, authorization)
            }),
          requestAccessUsingApplicationNeeds: (applicationId, agentId, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return requestAccessUsingApplicationNeeds(ctx, applicationId, agentId)
            }),
          requestAccessUsingAccessNeeds: (dataOwner, hasAccessNeedGroup, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return requestAccessUsingAccessNeeds(ctx, dataOwner, hasAccessNeedGroup)
            }),
          archiveAccessRequest: (request, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return archiveAccessRequest(ctx, request)
            }),
          createInvitation: (label, note, lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return createInvitation(ctx, { label, note }, lang)
            }),
          acceptInvitation: (capabilityUrl, label, note, lang, context) =>
            Effect.promise(async () => {
              const ctx = await resolveContext(
                session,
                context,
                this.endpointStore,
                this.sessionManager
              )
              return acceptInvitation(ctx, { capabilityUrl, label, note }, lang)
            }),
        })
      )
      const headers = new Headers()
      for (const [key, value] of Object.entries(httpRequest.headers)) {
        if (value === undefined) continue
        if (
          ['host', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())
        ) {
          continue
        }
        headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      // The current UI uses the @effect/rpc NDJSON protocol. The integration
      // tests still post the old array envelope; adapt it here until they move.
      const isLegacyJson = !String(httpRequest.headers['content-type'] ?? '').includes(
        'application/ndjson'
      )
      let rpcBody = requestBody
      if (isLegacyJson) {
        const legacy = JSON.parse(requestBody) as Array<{
          request: { _tag: string } & Record<string, unknown>
          headers?: Record<string, string>
          traceId?: string
          spanId?: string
          sampled?: boolean
        }>
        rpcBody = legacy
          .map((entry, index) => {
            return `${JSON.stringify({
              _tag: 'Request',
              id: String(index),
              tag: entry.request._tag,
              payload: entry.request,
              headers: Object.entries(entry.headers ?? {}),
              traceId: entry.traceId,
              spanId: entry.spanId,
              sampled: entry.sampled,
            })}\n`
          })
          .join('')
        headers.set('content-type', 'application/ndjson')
      }
      const rpcRequest = new Request(new URL(operation.target.path, 'http://localhost'), {
        method: operation.method,
        headers,
        body: operation.method === 'GET' || operation.method === 'HEAD' ? undefined : rpcBody,
      })

      const platformLayer = Layer.mergeAll(
        HttpPlatform.layer.pipe(Layer.provide(NodeContext.layer)),
        Etag.layer,
        NodeContext.layer
      )
      const tracingLayer = temporalPluginConfig()
        ? Layer.provide(Tracer.layerGlobal, Resource.layer({ serviceName: 'sai-uas' }))
        : Layer.empty
      const rpcHandler = RpcServer.toWebHandler(rpcGroup, {
        layer: Layer.mergeAll(
          rpcHandlers.pipe(Layer.provide(SaiServiceLive)),
          RpcSerialization.layerNdjson,
          platformLayer,
          tracingLayer
        ),
        spanPrefix: 'sai.rpc',
      })

      try {
        const response = await rpcHandler.handler(rpcRequest)
        let responseText = await response.text()
        let responseType = response.headers.get('content-type') ?? 'application/json'
        if (isLegacyJson) {
          const responses = responseText
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const message = JSON.parse(line) as {
                _tag: string
                exit?: { _tag: string; value?: unknown; cause?: { message?: string } }
              }
              if (message._tag !== 'Exit') return message
              if (message.exit?._tag === 'Success') {
                return { _tag: 'Success', value: message.exit.value }
              }
              const failureMessage = message.exit?.cause?.message ?? JSON.stringify(message.exit)
              console.error('RPC failure', failureMessage)
              return {
                _tag: 'Failure',
                message: failureMessage,
              }
            })
          responseText = JSON.stringify(responses)
          responseType = 'application/json'
        }
        if (span.isRecording()) {
          span.setAttribute('sai.rpc.response', responseText)
        }
        const representation = new BasicRepresentation(responseText, operation.target, responseType)
        return new ResponseDescription(
          response.status,
          representation.metadata,
          representation.data
        )
      } finally {
        await rpcHandler.dispose()
      }
    })
  }
}
