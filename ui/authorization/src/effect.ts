import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { RpcResolver } from '@effect/rpc'
import { HttpRpcResolverNoStream } from '@effect/rpc-http'
import {
  AcceptInvitation,
  type AgentType,
  type Authorization,
  AuthorizeApp,
  BootstrapAccount,
  CheckHandle,
  CreateInvitation,
  GetAuthoriaztionData,
  GetResource,
  GetUnregisteredApplication,
  GetWebId,
  IRI,
  ListApplications,
  ListDataInstances,
  ListDataRegistries,
  ListSocialAgentInvitations,
  ListSocialAgents,
  RegisterPushSubscription,
  RequestAccessUsingApplicationNeeds,
  type ShareAuthorization,
  ShareResource,
  type UiRpcRouter,
} from '@janeirodigital/sai-api-messages'
import { Effect, Layer } from 'effect'
import type * as S from 'effect/Schema'
import type { PushSubscription } from 'web-push'
import { getRuntimeConfig } from './runtime-config'

// Create the client
const makeClient = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  return HttpRpcResolverNoStream.make<UiRpcRouter>(
    client.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl(`${getRuntimeConfig().backendBaseUrl}/.sai/api`)
      )
      // HttpClient.tapRequest(Console.log)
    )
  ).pipe(RpcResolver.toClient)
})

const AuthFetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: 'include',
    })
  )
)

const AuthLayer = FetchHttpClient.layer.pipe(Layer.provide(AuthFetch))

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

export async function listApplications() {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListApplications())
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

export async function getAuthoriaztionData(agentId: string, agentType: AgentType, lang: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new GetAuthoriaztionData({ agentId: IRI.make(agentId), agentType, lang }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function getResource(id: string, lang: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new GetResource({ id: IRI.make(id), lang }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listSocialAgents() {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListSocialAgents())
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listSocialAgentInvitations() {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListSocialAgentInvitations())
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listDataRegistries(agentId: string, lang: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ListDataRegistries({ agentId: IRI.make(agentId), lang }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listDataInstances(
  agentId: S.Schema.Type<typeof IRI>,
  registrationId: S.Schema.Type<typeof IRI>
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new ListDataInstances({ agentId: agentId, registrationId: registrationId })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function requestAccessUsingApplicationNeeds(applicationId: string, agentId: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(
      new RequestAccessUsingApplicationNeeds({
        applicationId: IRI.make(applicationId),
        agentId: IRI.make(agentId),
      })
    )
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function createInvitation(label: string, note?: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new CreateInvitation({ label, note }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function acceptInvitation(capabilityUrl: string, label: string, note?: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new AcceptInvitation({ capabilityUrl, label, note }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function shareResource(authorization: S.Schema.Type<typeof ShareAuthorization>) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new ShareResource({ authorization }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function authorizeApp(authorization: S.Schema.Type<typeof Authorization>) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client(new AuthorizeApp({ authorization }))
  }).pipe(Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}
