import { RpcRouter } from '@effect/rpc'
import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { IRI, SaiService, router } from '@janeirodigital/sai-api-messages'
import {
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api'
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
import { withEffectTracing } from './tracing/effect-tracer.js'
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
  public async handle({ operation }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    // Manual active RPC span: the outgoing client spans (CID / data /
    // registry / shapetrees hops) nest under it. No-op when tracing is off.
    return trace.getTracer('sai-components').startActiveSpan('sai.rpc.handle', async (span) => {
      try {
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

        const requestBody = JSON.parse(await readableToString(operation.body.data))
        // capture the full incoming RPC payload (all request envelopes) on
        // this span — same shape as the request snippets in the dynamic
        // views (docs/temporal.c4); recording-only guard keeps the stringify
        // cost off non-sampled runs, and it sits BEFORE the envelope
        // trace-rewrite below so it reflects the wire request as received
        if (span.isRecording()) {
          span.setAttribute('sai.rpc.request', JSON.stringify(requestBody))
        }
        // make the @effect/rpc envelope carry the REAL trace: RpcRouter uses
        // req.traceId/req.spanId as the Effect span's explicit ExternalSpan
        // parent — the envelope placeholders would collapse every Effect span
        // into one pseudo-trace. Rewrite from the active OTel span
        // (sai.rpc.handle) when tracing is recording.
        const rpcSpan = trace.getSpan(otelContext.active())
        if (rpcSpan && isSpanContextValid(rpcSpan.spanContext())) {
          const rpcContext = rpcSpan.spanContext()
          for (const entry of requestBody) {
            entry.traceId = rpcContext.traceId
            entry.spanId = rpcContext.spanId
            entry.sampled = true
          }
        }
        const rpcMethod = requestBody[0]?.request?._tag
        if (rpcMethod) span.setAttribute('sai.rpc.method', rpcMethod)

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
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getDataRegistries(ctx, agentId, lang)
              }),
            listDataInstances: (agentId, registrationId, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return listDataInstances(ctx, agentId, registrationId, 'en')
              }),
            getApplications: (context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getApplications(ctx)
              }),
            getUnregisteredApplication: (id) =>
              Effect.promise(() => getUnregisteredApplication(session, id)),
            getSocialAgents: (lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getSocialAgents(ctx, lang)
              }),
            getRoles: (lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getRoles(ctx, lang)
              }),
            createRole: (label, members, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return createRole(ctx, label, members)
              }),
            updateRole: (id, label, members, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return updateRole(ctx, id, label, members)
              }),
            deleteRole: (id, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return deleteRole(ctx, id)
              }),
            getSocialAgentInvitations: (lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getSocialAgentInvitations(ctx, lang)
              }),
            getAuthorizationData: (agentId, lang, accessNeedGroupIri, accessRequestIri, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getDescriptions(ctx, agentId, lang, accessNeedGroupIri, accessRequestIri)
              }),
            getAuthorizations: (grantee, lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return listAuthorizations(ctx, grantee, lang)
              }),
            authorizeApp: (authorization, accessRequestIri, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return recordAuthorization(ctx, authorization, accessRequestIri)
              }),
            revokeAuthorizations: (authorizations, context) =>
              Effect.tryPromise({
                try: async () => {
                  const ctx = await resolveContext(session, context, this.endpointStore)
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
                const ctx = await resolveContext(session, context, this.endpointStore)
                return addAdmin(ctx, agentWebId)
              }),
            removeAdmin: (agentWebId, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return removeAdmin(ctx, agentWebId)
              }),
            registerPushSubscription: (subscription: PushSubscription) =>
              Effect.promise(() =>
                this.uiPushSubscriptionStore.create(session.webId, accountId, subscription)
              ),
            getResource: (id, lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return getResource(ctx, id, lang)
              }),
            shareResource: (authorization, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return shareResource(ctx, authorization)
              }),
            requestAccessUsingApplicationNeeds: (applicationId, agentId, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return requestAccessUsingApplicationNeeds(ctx, applicationId, agentId)
              }),
            requestAccessUsingAccessNeeds: (dataOwner, hasAccessNeedGroup, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return requestAccessUsingAccessNeeds(ctx, dataOwner, hasAccessNeedGroup)
              }),
            archiveAccessRequest: (request, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return archiveAccessRequest(ctx, request)
              }),
            createInvitation: (label, note, lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return createInvitation(ctx, { label, note }, lang)
              }),
            acceptInvitation: (capabilityUrl, label, note, lang, context) =>
              Effect.promise(async () => {
                const ctx = await resolveContext(session, context, this.endpointStore)
                return acceptInvitation(ctx, { capabilityUrl, label, note }, lang)
              }),
          })
        )
        const rpcHandler = RpcRouter.toHandlerNoStream(router)

        const program = Effect.gen(function* () {
          return yield* rpcHandler(requestBody)
        }).pipe(Effect.provide(SaiServiceLive))
        const payload = await Effect.runPromise(withEffectTracing(program, 'sai-uas'))
        // capture the RPC response / return value on the same span (the
        // @effect/rpc response envelope: {_tag: 'Success'|'Failure', …})
        if (span.isRecording()) {
          span.setAttribute('sai.rpc.response', JSON.stringify(payload))
        }

        const doc = JSON.stringify(payload)
        const representation = new BasicRepresentation(doc, operation.target, 'application/json')
        span.end()
        return new OkResponseDescription(representation.metadata, representation.data)
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
        throw err
      }
    })
  }
}
