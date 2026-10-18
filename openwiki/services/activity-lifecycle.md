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
  - id: openwiki-source-a9727c97c08565f7dac9c147
    resource: repo://packages/components/src/EventsHandler.ts
  - id: openwiki-source-d8a4328f642d2e3760ef7fcd
    resource: repo://packages/components/src/NdjsonNotification.ts
  - id: openwiki-source-9f9c5f051cdee5032dfd735b
    resource: repo://packages/components/src/services/Authorization.ts
  - id: openwiki-source-ec9b01d4f49d308517fdc575
    resource: repo://packages/components/src/services/ShareResource.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-40eb9f7315a1082fe32671da
    resource: repo://packages/data-model/src/activities.ts
  - id: openwiki-source-ffa35cc9379c0d10f59dfee0
    resource: repo://packages/utils/src/notifications.ts
generated: { by: "pi", at: "2026-10-18T21:45:34.463Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-18T21:45:34.463Z
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

- **`pending`** — a change activity (`activityType !== 'ActivityCompleted'`)
  with no completion referencing it.
- **`done`** — an `ActivityCompleted` whose `target` is the activity IRI exists.

Both transitions are container `Add`s on the same pre-seeded webhook channel
(one signal source; no per-activity subscriptions, polling, or replay). **`done`
is authoritative without a prior `pending`** — the change `Add` may be missed
while connected, so correlation is via the completion's `target`, not ordering.
A permanently failing workflow leaves the activity `pending` forever (there is
no dead-letter state); `reconcileActivities` is the reprocessing backstop.

## The activity union

`ActivityData` is the typed discriminant union of one member per activity RDF
class (`InvitationAccepted`, `AuthorizationGranted`, `DelegatedGrantsUpdated`,
`ActivityCompleted`, …), and `isActivityClass(activity, cls)` checks membership
in the class tuple. The comment on the union codifies the extension seam:
adding a class means extending the union plus the vocab/context entry, and
updating the handler, `reconcileActivities`, and the UI `events.ts` row.

## Activity object carrier

Granting activities embed the term-covered `DataAuthorizationData` POJOs
directly on the activity `object` at **pre-minted ids** — there is no separate
RPC structure crossing the wire (the carrier decision that settled the RPC
term gap). `recordAuthorization` pre-mints the data authorizations and embeds
them as `AuthorizationGranted.object: DataAuthorizationData[]`, and
`shareResource` does the same with the `buildShareDataAuthorizations` output.

## Producers and consumers

Producers PUT a change activity into the registry set the request operates in
(the **org's** Activity Registry in an org context); the producer's synchronous
writes (if any) happen before/with the PUT:

| Producer | activityType |
| --- | --- |
| `Authorization.recordAuthorization` | `AuthorizationGranted` (grant) / `AuthorizationDenied` (decline — pure, no delete) |
| `ShareResource.shareResource` | `AuthorizationGranted` (ONE activity for all grantees) |
| `RoleRegistry.updateRole` / `deleteRole` | `RoleMembershipChanged` / `RoleDeleted` |
| `InvitationHandler` | `AgentRegistrationAdded` |
| `ReciprocalWebhookHandler` (peer `Update`) | `DelegatedGrantsUpdated` |
| `Admin.addAdmin` / `removeAdmin` | `AdminAuthorizationGranted` / `AdminAuthorizationRevoked` |

Consumers (the owner channel's `dispatch`) map each class to a workflow on a
task queue: `AuthorizationGranted` → `processAuthorizationGranted` (parent) →
per-grantee `processGranteeAuthorization` children on `create-grants`;
`AuthorizationDenied` is forward-only; `RoleMembershipChanged`/`RoleDeleted` →
`processRoleMembershipChange`/`processRoleDeletion`; `AgentRegistrationAdded` →
`establishReciprocal` on `reciprocal-registration`; `DelegatedGrantsUpdated` →
`updateDelegatedGrants`; the admin classes → `createAdminGrants`/
`revokeAdminGrants` + `syncAdminAcr`. Admin channels never dispatch — the org's
owner channel runs the org's workflows.

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
6. The UI maps `done(activityType)` to list refetches.

## Webhook entrypoint and routing

`ActivityWebhookHandler.handle` resolves the delivery channel by `sendTo`
(404 if unknown), parses the body (400 on malformed JSON), and acts only on
`Add` notifications that carry an `object`. It loads the activity with the
channel's session, then **forwards to the events bus before dispatch** so every
`Add` emits a line. Owner versus observer is decided by
`session.registrySet.hasActivityRegistry?.id === channel.topic`: a non-owner
(admin) channel returns 200 forwarding-only; the owner channel proceeds to
`dispatch`.

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
`EventsHandler` (not the CSS notification machinery).

## Leaky edges (accepted)

- No `failed`/dead-letter state — permanent failure leaves `pending` forever.
- `done` without `pending` — ordering is not guaranteed; `done` is authoritative.
- Duplicate `done`s (concurrent consumer + sweep) are harmless but may cause
  redundant UI refetches.
- `AgentRegistrationAdded` stuck-pending on permanent failure — the sweep skips
  it (no `accountId` in its payload).
- `GrantIssuanceHandler` bypasses the outbox (starts `storeGrant` directly), so
  the data owner's UI gets no event for incoming delegated grants.

## Reconciliation backstop

`reconcileActivities` (a Temporal workflow) reprocesses every activity that has
no completion referencing it, using the same owner-channel routing. It skips
`AgentRegistrationAdded` and reuses deterministic grantee workflow ids so a
running consumer absorbs entries. It currently has no scheduler/caller and is
run on demand (e.g. directly by tests).
