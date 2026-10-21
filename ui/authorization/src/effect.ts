import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { RpcResolver } from '@effect/rpc'
import { HttpRpcResolverNoStream } from '@effect/rpc-http'
import {
  AcceptInvitation,
  AddAdmin,
  ArchiveAccessRequest,
  type Authorization,
  AuthorizeApp,
  BootstrapAccount,
  CheckHandle,
  CreateInvitation,
  CreateRole,
  DeleteRole,
  GetAuthoriaztionData,
  GetResource,
  GetUnregisteredApplication,
  GetWebId,
  IRI,
  ListApplications,
  ListAuthorizations,
  ListDataInstances,
  ListDataRegistries,
  ListRoles,
  ListSocialAgentInvitations,
  ListSocialAgents,
  RegisterPushSubscription,
  RemoveAdmin,
  RequestAccessUsingApplicationNeeds,
  RevokeAuthorizations,
  type ShareAuthorization,
  ShareResource,
  type UiRpcRouter,
  UpdateRole,
} from '@janeirodigital/sai-api-messages'
import { Effect, Layer } from 'effect'
import type * as S from 'effect/Schema'
import type { PushSubscription } from 'web-push'

import { getRuntimeConfig } from './runtime-config'
import { UiTracingLive } from './tracing'

// Create the client
const makeClient = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  const rpcClient = HttpRpcResolverNoStream.make<UiRpcRouter>(
    client.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl(`${getRuntimeConfig().backendBaseUrl}/.sai/api`)
      )
      // HttpClient.tapRequest(Console.log)
    )
  ).pipe(RpcResolver.toClient)

  // One root per UI action, named after the RPC tag. Without it the two spans
  // of the same request start their own traces: @effect/rpc's
  // `Rpc.request <Tag>` (it wraps request construction and ends before the
  // batched execution) and @effect/platform's `http.client <METHOD>` (created
  // inside the resolver). Both nest under this span, so one action is one trace.
  return ((request: { _tag: string }) =>
    (rpcClient as unknown as (r: unknown) => Effect.Effect<unknown, unknown, unknown>)(
      request
    ).pipe(Effect.withSpan(`sai.ui.${request._tag}`))) as typeof rpcClient
})

const AuthFetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: 'include',
    })
  )
)

// HttpClient for the RPC calls + the web OTel provider that exports the
// browser spans (and supplies the ids @effect/platform puts in traceparent).
const AuthLayer = Layer.mergeAll(
  FetchHttpClient.layer.pipe(Layer.provide(AuthFetch)),
  UiTracingLive
)

export async function getWebId() {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new GetWebId())
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function checkHandle(handle: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new CheckHandle({ handle }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function bootstrapAccount(handle: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new BootstrapAccount({ handle }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function registerPushSubscription(subscription: PushSubscription) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new RegisterPushSubscription({ subscription }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listApplications(context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListApplications({ context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listAuthorizations(grantee: string, lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new ListAuthorizations({ grantee: IRI.make(grantee), lang, context: IRI.make(context) })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function getUnregisteredApplication(id: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new GetUnregisteredApplication({ id: IRI.make(id) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function getAuthoriaztionData(
  agentId: string,
  lang: string,
  context: string,
  accessNeedGroupIri?: string,
  accessRequestIri?: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new GetAuthoriaztionData({
        agentId: IRI.make(agentId),
        lang,
        context: IRI.make(context),
        ...(accessNeedGroupIri ? { accessNeedGroupIri: IRI.make(accessNeedGroupIri) } : {}),
        ...(accessRequestIri ? { accessRequestIri: IRI.make(accessRequestIri) } : {}),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function getResource(id: string, lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new GetResource({ id: IRI.make(id), lang, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listSocialAgents(lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListSocialAgents({ lang, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listRoles(lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListRoles({ lang, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listSocialAgentInvitations(lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListSocialAgentInvitations({ lang, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listDataRegistries(agentId: string, lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new ListDataRegistries({ agentId: IRI.make(agentId), lang, context: IRI.make(context) })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listDataInstances(
  agentId: S.Schema.Type<typeof IRI>,
  registrationId: S.Schema.Type<typeof IRI>,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new ListDataInstances({
        agentId: agentId,
        registrationId: registrationId,
        context: IRI.make(context),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function requestAccessUsingApplicationNeeds(
  applicationId: string,
  agentId: string,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new RequestAccessUsingApplicationNeeds({
        applicationId: IRI.make(applicationId),
        agentId: IRI.make(agentId),
        context: IRI.make(context),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function archiveAccessRequest(request: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new ArchiveAccessRequest({
        request: IRI.make(request),
        context: IRI.make(context),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function createInvitation(
  label: string,
  note: string | undefined,
  lang: string,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new CreateInvitation({ label, note, lang, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function acceptInvitation(
  capabilityUrl: string,
  label: string,
  note: string | undefined,
  lang: string,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new AcceptInvitation({ capabilityUrl, label, note, lang, context: IRI.make(context) })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function shareResource(
  authorization: S.Schema.Type<typeof ShareAuthorization>,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ShareResource({ authorization, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function authorizeApp(
  authorization: S.Schema.Type<typeof Authorization>,
  context: string,
  accessRequestIri?: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new AuthorizeApp({
        authorization,
        context: IRI.make(context),
        ...(accessRequestIri ? { accessRequestIri: IRI.make(accessRequestIri) } : {}),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function revokeAuthorizations(authorizations: readonly string[], context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new RevokeAuthorizations({
        authorizations: authorizations.map((id) => IRI.make(id)),
        context: IRI.make(context),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function createRole(
  label: string,
  members: readonly S.Schema.Type<typeof IRI>[],
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new CreateRole({ label, members, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function updateRole(
  id: S.Schema.Type<typeof IRI>,
  label: string,
  members: readonly S.Schema.Type<typeof IRI>[],
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new UpdateRole({ id, label, members, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function deleteRole(id: S.Schema.Type<typeof IRI>, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new DeleteRole({ id, context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function addAdmin(webId: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new AddAdmin({ webId: IRI.make(webId), context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function removeAdmin(webId: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new RemoveAdmin({ webId: IRI.make(webId), context: IRI.make(context) }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}
