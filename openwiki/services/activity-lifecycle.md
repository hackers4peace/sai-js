---
type: architecture
title: Activity outbox and events pipeline
description: The append-only Activity Registry outbox and its pending/done state machine, the producer and consumer (workflow) tables, the Solid Notifications webhook delivery, ActivityWebhookHandler routing, the ActivityEvents bus, the embedded DataAuthorizationData POJO carrier, and the reconcileActivities backstop.
tags: [activities, webhook, events, solid-notifications, architecture]
sources:
  - id: openwiki-source-82daddf07d8ad3efedbe52d2
    resource: repo://packages/authorization-agent/src/activity-registry.ts
  - id: openwiki-source-c154d0515a7154469b1f503c
    resource: repo://packages/components/config/http/notifications/ndjson.json
  - id: openwiki-source-a9275a0e3a23f49eea3d9b3f
    resource: repo://packages/components/src/ActivityEvents.ts
  - id: openwiki-source-c18acf0c50387f2e5ea026d1
    resource: repo://packages/components/src/ActivityWebhookHandler.ts
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-a9727c97c08565f7dac9c147
    resource: repo://packages/components/src/EventsHandler.ts
  - id: openwiki-source-d8a4328f642d2e3760ef7fcd
    resource: repo://packages/components/src/NdjsonNotification.ts
  - id: openwiki-source-b51f04210bf90c2ec8824400
    resource: repo://packages/components/src/ReciprocalWebhookHandler.ts
  - id: openwiki-source-9f9c5f051cdee5032dfd735b
    resource: repo://packages/components/src/services/Authorization.ts
  - id: openwiki-source-ec9b01d4f49d308517fdc575
    resource: repo://packages/components/src/services/ShareResource.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
  - id: openwiki-source-40eb9f7315a1082fe32671da
    resource: repo://packages/data-model/src/activities.ts
  - id: openwiki-source-ffa35cc9379c0d10f59dfee0
    resource: repo://packages/utils/src/notifications.ts
generated: { by: "pi", at: "2026-10-22T04:35:20.186Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-22T04:35:20.186Z
---

# Activity outbox and events pipeline

The SAI service layer is **activity-first**: RPC handlers validate input and
append one typed `Activity` to a per-webId **Activity Registry** outbox, then
return a pending acknowledgement. Solid Notifications (subscribed through the
in-repo `subscribeToNotificationChannel` helper, which replaced the
`@solid-notifications/*` packages) delivers the container `Add` to a webhook;
`ActivityWebhookHandler` decodes it and either starts a Temporal workflow (owner
channel) or only forwards it (observer/admin channel). Workflows finish by
writing a minimal `ActivityCompleted` resource, which is forwarded as `done`.

## The state machine

The Activity Registry is an append-only log; state is never mutated — a
transition is a new log entry. There are exactly two derived states:

- **`pending`** — a change activity (any class other than `ActivityCompleted`)
  with no completion referencing it.
- **`done`** — an `ActivityCompleted` whose `target` is the activity IRI exists.

Both transitions are container `Add`s on the same pre-seeded webhook channel
(one signal source; no per-activity subscriptions, polling, or replay). **`done`
is authoritative without a prior `pending`** — the change `Add` may be missed
while connected, so correlation is via the completion's `target`, not ordering.
A permanently failing workflow leaves the activity `pending` forever (there is
no dead-letter state); `reconcileActivities` is the reprocessing backstop.

**Terminal resolution classes have no completion.** `AuthorizationDenied`,
`AccessRequestGranted`, and `AccessRequestArchived` are outcomes in themselves —
nothing materializes after them, so no workflow runs and no `ActivityCompleted`
is written. `events.ts` reacts to their rows at any status, and
`reconcileActivities` treats them as terminal (no dispatch, no completion).

## The activity union

`ActivityData` is the typed discriminant union of one member per activity RDF
class (`InvitationAccepted`, `AuthorizationGranted`, `DelegatedGrantsUpdated`,
`ActivityCompleted`, …), and `isActivityClass(activity, cls)` checks membership
in the class tuple. The wire form is **flat**: each interface is named after its
RDF class, `type` is the class tuple (`['Activity', '<Class>', <as:*>]`), and
fields are plain IRIs/literals inline — there is no nested `payload` blob and no
`{ id, type }` ref object stored in a SPARQL-queried registry (typed `XId` refs
exist only in Temporal inputs). Every activity also carries `actor` (`as:actor`).
The comment on the union codifies the extension seam: adding a class means
extending the union plus the vocab/context entry, and updating the handler,
`reconcileActivities`, and the UI `events.ts` row.

## Activity object carrier

Granting activities embed the term-covered `DataAuthorizationData` POJOs
directly on the activity `object` at **pre-minted ids** — there is no separate
RPC structure crossing the wire (the carrier decision that settled the RPC
term gap). `recordAuthorization` pre-mints the data authorizations and embeds
them as `AuthorizationGranted.object: DataAuthorizationData[]`, and
`shareResource` does the same with the `buildShareDataAuthorizations` output.

## Access-request resolution spans

A need-based access request is tracked as a **span** across two activities: the
request activity opens it (`NeedBasedAccessRequestSent` on the requester's
registry, a `urn:uuid` snapshot; `NeedBasedAccessRequestReceived` on the
owner's registry at the owner-minted request id), and a resolution activity
closes it:

| Resolution class | Registry | Producer | Outcome |
| --- | --- | --- | --- |
| `AccessRequestGranted` | requester's | `detectGrantedRequests` (a fire-and-forget child started at the end of `updateDelegatedGrants`) | a grant for the request was detected → open request closed |
| `AccessRequestArchived` | requester's | `archiveAccessRequest` RPC (user closes a still-open request) | user archived → open request closed |
| `AuthorizationGranted` / `AuthorizationDenied` | owner's | `recordAuthorization`, carrying a `satisfiesAccessRequest` back-link | owner-side span closed |

All resolutions are immutable and addressable forever, so an open-request list is
derivable at any time and an archive can target a stable id. The `SocialAgent`
projection exposes `accessRequestsSent` and `accessRequestsReceived` as
collections (not single flags), and the detector matches open sent requests
against the requester's received grants, writing one `AccessRequestGranted` per
match.

## Domain event catalogue

Producers write one typed Activity into the registry set the request operates
in (the **org's** Activity Registry in an org context).
`ActivityWebhookHandler` forwards every `Add` to the events bus and then
dispatches on the class:

| Activity class | Producer | Consumer / outcome |
| --- | --- | --- |
| `InvitationCreated` | `InvitationRegistry.createInvitation` (activity-only; the RPC mints the invitation id) | `createInvitation` on `create-grants` — PUTs the invitation, generates the capabilityUrl, completes |
| `InvitationAccepted` | `SocialAgentRegistry.acceptInvitation` | `acceptInvitation` on `reciprocal-registration` — POSTs the capabilityUrl, builds the acceptor registration + reciprocal, subscribes, completes |
| `AgentRegistrationAdded` | `InvitationHandler` (inviter's registry) | `establishReciprocal` on `reciprocal-registration` — builds both registrations/reciprocals, subscribes the reciprocal webhook, completes |
| `AuthorizationGranted` | `Authorization.recordAuthorization` (grant), `ShareResource.shareResource` | `processAuthorizationGranted` parent → per-grantee `processGranteeAuthorization` children on `create-grants` (one activity for all grantees) |
| `AuthorizationDenied` | `Authorization.recordAuthorization` (decline) | **terminal / forward-only** — no workflow; the reconcile sweep closes the row |
| `AuthorizationRevoked` | `Authorization.revokeAuthorizations` (the `RevokeAuthorizations` RPC) | `processAuthorizationRevoked` on `create-grants` — one run per activity (no consumer): deletes the carried DataAuthorizations, expands a role grantee, reconciles each affected grantee's grant projections, completes. See [Authorization revocation and grant projections](../architecture/authorization-revocation.md) |
| `RoleCreated` | `RoleRegistry.createRole` (activity-only) | `createRole` on `create-grants` — PUTs the role at the minted id, completes |
| `RoleMembershipChanged` | `RoleRegistry.updateRole` | `processRoleMembershipChange` on `create-grants` |
| `RoleDeleted` | `RoleRegistry.deleteRole` | `processRoleDeletion` on `create-grants` |
| `AdminAuthorizationGranted` | `Admin.addAdmin` | `processAdminAuthorizationGranted` on `create-grants` — records the AA at the pre-minted id, `createAdminGrants`, `syncAdminAcr`, completes |
| `AdminAuthorizationRevoked` | `Admin.removeAdmin` | `processAdminAuthorizationRevoked` on `create-grants` — deletes the AA at `object.id`, `revokeAdminGrants`, `syncAdminAcr`, completes |
| `NeedBasedAccessRequestSent` | `ShareResource.requestAccessUsingApplicationNeeds` / `requestAccessUsingAccessNeeds` | `processNeedBasedAccessRequest` on `create-grants` — forwards to the data owner's issuance endpoint |
| `NeedBasedAccessRequestReceived` | `GrantIssuanceHandler` (owner's issuance endpoint) | `processNeedBasedAccessRequestReceived` on `create-grants` — PUTs the immutable AccessRequest |
| `AccessRequestGranted` | `detectGrantedRequests` (child of `updateDelegatedGrants`) | **terminal** — no workflow/completion |
| `AccessRequestArchived` | `Authorization.archiveAccessRequest` | **terminal** — no workflow/completion |
| `DelegatedGrantsUpdated` | `ReciprocalWebhookHandler` (peer `Update`) | per-peer `processDelegatedGrantsUpdated` consumer on `create-grants` (start-or-signal, workflow id `delegated-grants:<webId>:<peerId>`). Each drain runs the `syncReciprocalMirror` child workflow on `reciprocal-registration` first, then `updateDelegatedGrants`, then writes the completions. A **terminal** sync (`404`/`410` on the peer's registration) skips the regeneration and still completes — a peer that unregistered us must not stay `pending` forever. |
| `ActivityCompleted` | Temporal completions | forwarding only (`done`); never dispatches |
| `grantsRevoked` (retired) | none | wiring retired by the activity-first cleanup; revocation now goes through the issuance boundary and workflows |

**Dispatch rules.** The owner channel dispatches; an admin channel is
forward-only (keyed by the admin's webId). `AuthorizationDenied`,
`AccessRequestGranted`, `AccessRequestArchived`, and `ActivityCompleted` never
start a workflow. The admin orchestrators are sequential: the AdminAuthorization
write/delete happens first, then the grant materialization, then the ACR rewrite
(`syncAdminAcr` reads the AuthorizationRegistry as source of truth and
re-guards the last admin); the completion is written only after all succeed.
`createAdminGrants` writes one `RegistrySet`-scope admin marker plus one
Read-only `DataRegistry`-scope grant per data registry in the set, which is what
the data-server permission engine reads. Add and remove are distinct classes
with distinct object shapes: add embeds the AdminAuthorization-to-be at the
pre-minted id, remove embeds the existing AdminAuthorization at its real id;
the admin's grantee is read from the object (no `granted: false` reuse).

**Deferred events.** A `RegistrySet`-scope admin authorization should expand to
a new `DataRegistry`-scope admin grant when the org gains a data registry; no
`dataRegistryAdded`-style producer exists yet. A public
`adminAuthorizations()` iteration API is deferred — the workflows read the
AuthorizationRegistry directly, type-filtered. `grantsRevoked` remains retired;
the revocation leg is the `AuthorizationRevoked` carrier plus the
`processAuthorizationRevoked` workflow.

## Full arc (AuthorizeApp)

1. UI submits `authorizeApp` (RPC).
2. `ApiHandler` resolves cookie → webId → session; `recordAuthorization` writes
   the activity only and returns the pending ack (the RPC resolves with intent
   committed, not outcome).
3. The container `Add` reaches `ActivityWebhookHandler`, which emits `pending`
   and dispatches `processAuthorizationGranted` (a decline is forward-only).
4. The parent groups the DAs by grantee → one `processGranteeAuthorization`
   child per grantee → each stores DAs + grants + ACRs and PATCHes the
   registration; the parent writes the single completion.
5. The completion `Add` is loaded via `target` and emitted as `done`.
6. The UI maps `done(<activity class>)` to list refetches.

## Webhook entrypoint and routing

`ActivityWebhookHandler.handle` resolves the delivery channel by `sendTo`
(410 if unknown), parses the body (400 on malformed JSON), and acts only on
`Add` notifications that carry an `object`. It loads the activity with the
channel's session, then **forwards to the events bus before dispatch** so every
`Add` emits a line. Owner versus observer is decided by
`session.registrySet.hasActivityRegistry?.id === channel.topic`: a non-owner
(admin) channel returns 200 forwarding-only; the owner channel proceeds to
`dispatch`.

## Durable webhook delivery

Registry and data do not POST webhook notifications directly. Their
`DurableWebhookEmitter` reads the serialized notification once and starts the
`deliverWebhook` workflow on the dedicated `webhook-delivery` queue. The
workflow has one `postWebhook` activity with a 1-minute start-to-close timeout
and a bounded retry policy: 1s initial interval, backoff 2, 60s maximum, 10
attempts. `postWebhook` treats `400`, `410`, `413`, `415`, and `422` as
non-retryable; other 4xx, 5xx, and network failures retry. If enqueueing fails,
the emitter falls back to the direct POST the stock CSS emitter performs.

Delivery is at-least-once. A lost 2xx response or a 5xx after the receiver
processed the notification can repeat an `Add`, so the dispatched workflows must
tolerate duplicates. The handlers document a future `Idempotency-Key` header as
the dedupe seam. The receivers still use `sendTo` as a capability URL and do not
verify the stock emitter's DPoP token, so the durable path sends no
`Authorization` or `DPoP` headers.

For `DelegatedGrantsUpdated`, **`done` means the peer mirror is current**: the
completion is written by the per-peer consumer only after its drain replicated
the mirror (`syncReciprocalMirror`) *and* regenerated the delegated grants, so
`generateDelegatedDataGrants` never reads a mirror that predates the delivery.
The one exception is the terminal case: when the sync reports that the peer
deleted its registration of us (`404`/`410`), the consumer completes the batch
**without regenerating** — there is no source left to regenerate from, and
retrying into the cap would leave the activity `pending` forever. Every other
failure retries, and the mirror step keeps `syncReciprocalMirror`'s five-attempt
retry cap (a permanently unreadable or `403` peer therefore stays `pending`,
visible rather than stale-done; the reconcile sweep re-drives it, and the
sweep's production cadence is a deployment concern). Grants where the context is
the `grantedBy` rather than the
grantee are not part of this mirror (the data owner holds the authoritative
copies); see
[Federation constraints](../architecture/federation.md#the-reciprocal-mirror-in-detail).

## Events bus and stream

`ActivityEvents` is an in-memory `WrappedSetMultiMap<webId, PassThrough>`.
`forwardActivity` emits `{type: 'activity', activity, status}` where a regular
activity is `pending` and an `ActivityCompleted` is enriched back into `done`
by loading its `target` original. `EventsHandler` serves `GET /.sai/events`,
resolves the webId from the account cookie, subscribes a stream, flushes
headers with an initial heartbeat, and heartbeats every ~30s. There is no
replay — clients must listen first.

### Notification wire format

CSS webhook deliveries are JSON-LD. For **streaming** channels the server
advertises `application/x-ndjson` through `NdjsonNotificationSerializer` and
`NdjsonStreamingHttpRequestHandler` (`packages/components/src/NdjsonNotification.ts`,
wired by `config/http/notifications/ndjson.json`): each line is one expanded
JSON-LD notification, because the stock CSS serializer and streaming handler
hardcode Turtle and the notification context is not publicly resolvable. The
`GET /.sai/events` stream is a separate, sai-owned NDJSON stream served by
`EventsHandler` (not the CSS notification machinery). `packages/application`'s
`NotificationManager` consumes the same NDJSON stream (discarding the initial
state line) and parses each line with `toStore`.

## Leaky edges (accepted)

- No `failed`/dead-letter state — permanent failure leaves `pending` forever.
- `done` without `pending` — ordering is not guaranteed; `done` is authoritative.
- Duplicate `done`s (concurrent consumer + sweep) are harmless but may cause
  redundant UI refetches. At-least-once webhook delivery can also repeat a
  `pending`/`done` pair, so receivers must tolerate duplicate `Add`s.
- `AgentRegistrationAdded` stuck-pending on permanent failure — the sweep skips
  it (no `accountId` in its payload).
- `GrantIssuanceHandler` bypasses the outbox (starts `storeGrant` directly), so
  the data owner's UI gets no event for incoming delegated grants.

## Reconciliation backstop

`reconcileActivities` (a Temporal workflow) reprocesses every activity that has
no completion referencing it, using the same owner-channel routing. It skips
`AgentRegistrationAdded` and reuses the deterministic consumer ids (per-grantee
and `delegated-grants:<webId>:<peerId>`) so a running consumer absorbs entries;
the `DelegatedGrantsUpdated` branch therefore starts that consumer, which
replicates the mirror before regenerating and owns the completion — the sweep
never writes a completion that could predate the mirror. It currently has no
scheduler/caller and is run on demand (e.g. directly by tests).
