---
type: architecture
title: RPC contract and service layer
description: The @effect/rpc contract, the ApiHandler entrypoint, the peer layer diagram, personal-versus-org context resolution (owner identity is the org), and what each component service owns.
tags: [rpc, effect, services, architecture, typescript]
sources:
  - id: openwiki-source-39263cf4b989bfbe674c72c0
    resource: repo://packages/api-messages/src/effect.ts
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-92862eeddb750415b0a0a89f
    resource: repo://packages/components/src/ApiHandler.ts
  - id: openwiki-source-3e8f48f62968e08a27cd3572
    resource: repo://packages/components/src/services/Account.ts
  - id: openwiki-source-9f9c5f051cdee5032dfd735b
    resource: repo://packages/components/src/services/Authorization.ts
  - id: openwiki-source-452244fad48fe4fdb39195dd
    resource: repo://packages/components/src/services/Context.ts
  - id: openwiki-source-20e9ce588a1e0e4469c2c993
    resource: repo://packages/components/src/services/RoleRegistry.ts
generated: { by: "pi", at: "2026-10-22T04:35:20.186Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-22T04:35:20.186Z
---

# RPC contract and service layer

The UI talks to the SAI backend through a single `@effect/rpc` endpoint. The
wire contract lives in `packages/api-messages` and is shared verbatim by the
browser client and the server; the server side (`packages/components`) routes
each request through a thin handler into a per-domain service.

## Layers

One peer (one account/authorization agent + UI) is a set of cooperating state
machines, layered top to bottom:

```
UI (Vue/Pinia) — personal context (own webId) or an org context (administered org)
  │  RPC (JSON over POST /.sai/api, cookie-authed)   │  events (GET /.sai/events, NDJSON)
  ▼                                                   ▼
ApiHandler (RPC router)                          EventsHandler (stream)
  │  resolveContext → the user's own AA session    ▲  subscribes under the signed-in webId
  ▼                                                   │
Services (Authorization, ShareResource, RoleRegistry, …)
  │  validation reads + PUT activity (into the org's Activity Registry in an org context)
  ▼
Activity Registry (append-only outbox)
  ▼  container Add → WebhookChannel2023
ActivityWebhookHandler ──▶ ActivityEvents (bus, keyed by webId)
  │  owner channel: dispatch workflow; admin channel: forward-only
  ▼
Temporal workflows ──▶ completion activity ──▶ events stream ──▶ UI refetch
```

The RPC contract lives in `packages/api-messages` (effect Schema + `@effect/rpc`
router); `ApiHandler` resolves identity from the account cookie and executes the
router against the service layer through a `SaiService` context.

## The contract (`api-messages`)

`packages/api-messages/src/effect.ts` declares every operation as an
`S.TaggedRequest` (`GetWebId`, `CheckHandle`, `BootstrapAccount`,
`AuthorizeApp`, `ShareResource`, `AddAdmin`, `ListAuthorizations`,
`RevokeAuthorizations`, …) with effect Schema payload and
success types. Most declare `failure: S.Never`; `RevokeAuthorizations` declares
the typed `AuthorizationRevocationFailure` union (`empty-selection`,
`not-a-data-authorization`, `mixed-grantee`, `unauthorized`) and returns an
optional `activityId` plus the expanded authorization IRIs. The service surface
is the `SaiService`
`Context.Tag` interface, and the exported `router` is
`RpcRouter.make(...)` mapping each tagged request to a method that pulls
`SaiService` from the Effect context. Output IRIs are unbranded `S.String` on
the wire; `IRI` is a `S.brand('IRI')` used for internal typing only. Names use
`id` (not `iri`), and a `Message` suffix marks RPC projections wherever a name
would collide with the data-model type. The `AuthorizeApp` request returns an
`AuthorizationGrantedMessage` as its success type.

## The entrypoint (`ApiHandler`)

`ApiHandler` is a CSS `OperationHttpHandler` bound to `POST /.sai/api`. It
reads the `css-account` cookie, resolves the account via `cookieStore`, finds
the linked webId via `webIdStore`, and obtains the user's `AuthorizationAgent`
session from `sessionManager`. It then parses the RPC envelope, rewrites the
envelope `traceId/spanId` from the active OpenTelemetry span, builds a
`SaiServiceLive = Layer.succeed(SaiService, ...)` where each method resolves
the request context and delegates to a service function, and finally runs
`RpcRouter.toHandlerNoStream(router)` inside `Effect.provide`.

Its constructor now takes a **`PodEndpointStore`** (not a raw SPARQL endpoint):
every `resolveContext` call receives it, so the service layer resolves per-pod
endpoints rather than a single shared store (see
[Per-pod storage and isolation](../architecture/storage-isolation.md)). The
authorization RPCs follow the same path: `getAuthorizations` calls
`listAuthorizations(ctx, grantee, lang)`, and `revokeAuthorizations` wraps
`revokeAuthorizations(ctx, authorizations)` in `Effect.tryPromise` with
`toAuthorizationRevocationFailure` as the typed catch. The account paths were
renamed accordingly: `bootstrapAccount` calls
`accountService.startBootstrapAccount`, and `addAdmin`/`removeAdmin` take an
`agentWebId`.

## Context resolution (personal vs org)

`services/Context.ts` owns `ResolvedContext`. The invariant is that the session
is **always the signed-in user's own AuthorizationAgent** — no org session is
minted. If `context === userSession.webId`, it resolves to the user's own
registry set. Otherwise `isAdminOf` must pass (the org's reciprocal
registration of the user carries a non-empty `hasAdminGrant`), after which the
org's registry set is resolved through the org's agent-id document and writes
are owned by `ctx.webId` as the org. Failure throws `ContextError`.

The admin check is a single link query over the mirrored reciprocal
(`getRegistrationLinks(..., hasAdminGrant)` on the session's internal endpoint),
not a framed registration read — and it is fail-closed: a registration without a
reciprocal link or a replica that is missing/absent reads as "not an admin"
rather than erroring.

In an org context the **owner identity is the org** (not the admin): every
record is written with the org as data owner / `grantedBy` / ACR
`fullOwnerAccess` / activity `webId` — the admin only *authenticates*. Sessions
are short-lived (per request / per Temporal activity) and hold a webId-keyed
registry-set map: the user's own is eager-loaded, every org's is lazy-resolved
on demand, so there is no cross-request cache to invalidate.

`resolveContext(userSession, context, endpointStore)` also returns an
**`endpoints` allowlist** (`podUrl -> endpoint`): the personal context reuses
`userSession.sparqlEndpoints`, while an org context reads the org's own records
via `endpointStore.findSparqlByWebId(context)`, so the admin never gets a wider
endpoint set than the context's pods. Downstream data-plane reads use this map
(through `sparqlTransportForPod`) instead of a shared endpoint.

The org-context read and proxy endpoints this resolution selects are documented
in [Org-context data plane](org-context.md).

## Services

Each file under `packages/components/src/services/` owns one domain:

- `Account` — handle uniqueness (`checkHandle`) plus `startBootstrapAccount`,
  which derives the account IRIs, starts the `bootstrapAccount` Temporal
  workflow on the `create-grants` queue, and returns the WebID immediately
  (account provisioning is asynchronous; see
  [Per-pod storage and isolation](../architecture/storage-isolation.md)).
- `ApplicationRegistry` — application listings and unregistered-app profiles.
- `SocialAgentRegistry` — social agent listing, profiles, `acceptInvitation`
  (records an activity-first `InvitationAccepted` in the acceptor's registry
  and returns `{ accepted: true, activityId }`; the acceptor's own
  `acceptInvitation` workflow performs the capabilityUrl POST).
- `RoleRegistry` — role CRUD (`createRole`, `updateRole`, `deleteRole`).
- `InvitationRegistry` — invitation listing and `createInvitation`.
- `DataRegistry` — data registries and data-instance listing.
- `Authorization` — descriptions, `listAuthorizations` (context-scoped read of
the grantee's authorizations with shape-tree labels), `recordAuthorization`
(writes the activity with the `satisfiesAccessRequest` back-link that closes the
owner-side request span), `revokeAuthorizations` (validates the selection,
expands the inheritance closure, writes one `AuthorizationRevoked` activity),
and `archiveAccessRequest` (writes a terminal `AccessRequestArchived`; an
unknown or already-resolved snapshot is a no-op returning `archived: false`).
- `ShareResource` — `shareResource`, `requestAccessUsing*`, access matching.
- `Admin` — `addAdmin`/`removeAdmin` with a last-admin guard.
- `peerProxy`/`peerFetch`/`ReciprocalMirror` — org-context peer reads and the
  server-side reciprocal mirror.
- `adminGate` — `requireOrgAdmin` guard shared by the admin-only endpoints.

Writes are **activity-first**: the service validates and appends one activity
to the Activity Registry, then returns a pending ack; a Temporal workflow
materializes the resource and completes it (see
[Activity outbox and events pipeline](../services/activity-lifecycle.md)).
Activity-first acks echo the triggering activity IRI as `activityId`; the UI
stores it and binds the stream event by exact id (the uniform claim anchor).

## Related pages

- [Authorization revocation and grant projections](../architecture/authorization-revocation.md)
  — the producer, carrier, workflow, and boundary behind the authorization RPCs.
