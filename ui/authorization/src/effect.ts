import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { IRI, rpcGroup } from '@janeirodigital/sai-api-messages'
import type { Authorization, ShareAuthorization } from '@janeirodigital/sai-api-messages'
import { Effect, Layer } from 'effect'
import type { Schema } from 'effect/Schema'
import type { PushSubscription } from 'web-push'

import { getRuntimeConfig } from './runtime-config'
import { UiTracingLive } from './tracing'

// Create the client
const makeClient = Effect.gen(function* () {
  return yield* RpcClient.make(rpcGroup)
})

const AuthFetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: 'include',
    })
  )
)

// RPC transport + the web OTel provider that exports the browser spans.
// The URL is read when the layer is built (first RPC), not at import: this
// module is imported by the router before main.ts has loaded config.json, and
// reading it eagerly throws "Runtime config not loaded" (blank page).
const AuthLayer = Layer.mergeAll(
  Layer.unwrapEffect(
    Effect.sync(() =>
      RpcClient.layerProtocolHttp({
        url: `${getRuntimeConfig().backendBaseUrl}/.sai/api`,
      })
    )
  ).pipe(Layer.provide(AuthFetch), Layer.provide(RpcSerialization.layerNdjson)),
  UiTracingLive
)

export async function getWebId() {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.GetWebId({})
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function checkHandle(handle: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.CheckHandle({ handle })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function bootstrapAccount(handle: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.BootstrapAccount({ handle })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function registerPushSubscription(subscription: PushSubscription) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.RegisterPushSubscription({ subscription })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listApplications(context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListApplications({ context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listAuthorizations(grantee: string, lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListAuthorizations({
      grantee: IRI.make(grantee),
      lang,
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function getUnregisteredApplication(id: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.GetUnregisteredApplication({ id: IRI.make(id) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
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
    return yield* client.GetAuthoriaztionData({
      agentId: IRI.make(agentId),
      lang,
      context: IRI.make(context),
      ...(accessNeedGroupIri ? { accessNeedGroupIri: IRI.make(accessNeedGroupIri) } : {}),
      ...(accessRequestIri ? { accessRequestIri: IRI.make(accessRequestIri) } : {}),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function getResource(id: string, lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.GetResource({ id: IRI.make(id), lang, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listSocialAgents(lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListSocialAgents({ lang, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listRoles(lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListRoles({ lang, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listSocialAgentInvitations(lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListSocialAgentInvitations({ lang, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listDataRegistries(agentId: string, lang: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListDataRegistries({
      agentId: IRI.make(agentId),
      lang,
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function listDataInstances(
  agentId: Schema.Type<typeof IRI>,
  registrationId: Schema.Type<typeof IRI>,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ListDataInstances({
      agentId,
      registrationId,
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function requestAccessUsingApplicationNeeds(
  applicationId: string,
  agentId: string,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.RequestAccessUsingApplicationNeeds({
      applicationId: IRI.make(applicationId),
      agentId: IRI.make(agentId),
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function archiveAccessRequest(request: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ArchiveAccessRequest({
      request: IRI.make(request),
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
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
    return yield* client.CreateInvitation({ label, note, lang, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
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
    return yield* client.AcceptInvitation({
      capabilityUrl,
      label,
      note,
      lang,
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function shareResource(
  authorization: Schema.Type<typeof ShareAuthorization>,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.ShareResource({ authorization, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function authorizeApp(
  authorization: Schema.Type<typeof Authorization>,
  context: string,
  accessRequestIri?: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.AuthorizeApp({
      authorization,
      context: IRI.make(context),
      ...(accessRequestIri ? { accessRequestIri: IRI.make(accessRequestIri) } : {}),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function revokeAuthorizations(authorizations: ReadonlyArray<string>, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.RevokeAuthorizations({
      authorizations: authorizations.map((id) => IRI.make(id)),
      context: IRI.make(context),
    })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function createRole(
  label: string,
  members: ReadonlyArray<Schema.Type<typeof IRI>>,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.CreateRole({ label, members, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function updateRole(
  id: Schema.Type<typeof IRI>,
  label: string,
  members: ReadonlyArray<Schema.Type<typeof IRI>>,
  context: string
) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.UpdateRole({ id, label, members, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function deleteRole(id: Schema.Type<typeof IRI>, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.DeleteRole({ id, context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function addAdmin(webId: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.AddAdmin({ webId: IRI.make(webId), context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}

export async function removeAdmin(webId: string, context: string) {
  const program = Effect.gen(function* () {
    const client = yield* makeClient
    return yield* client.RemoveAdmin({ webId: IRI.make(webId), context: IRI.make(context) })
  }).pipe(Effect.scoped, Effect.provide(AuthLayer))
  return Effect.runPromise(program)
}
