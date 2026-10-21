---
type: architecture
title: Temporal workflows and activities
description: The Temporal client and worker bootstrap, the four task queues (create-grants, reciprocal-registration, forward-to-push, webhook-delivery), the typed *Id boundary objects, the self-contained createGrantsForAgent regeneration, findRoleUsage routing, the single-activity share with per-grantee fan-out, and how activities call back into the service layer.
tags: [temporal, workflows, activities, worker, architecture]
sources:
  - id: openwiki-source-c18acf0c50387f2e5ea026d1
    resource: repo://packages/components/src/ActivityWebhookHandler.ts
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-9f9c5f051cdee5032dfd735b
    resource: repo://packages/components/src/services/Authorization.ts
  - id: openwiki-source-ec9b01d4f49d308517fdc575
    resource: repo://packages/components/src/services/ShareResource.ts
  - id: openwiki-source-b3f53b3cc2943909883f8582
    resource: repo://packages/components/src/temporal/activities/account.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-e04884959e0812782a6d49fe
    resource: repo://packages/components/src/temporal/client.ts
  - id: openwiki-source-55f67d07018be4b3c4161eb1
    resource: repo://packages/components/src/temporal/queues.ts
  - id: openwiki-source-4dbb1c79cd1a93efa0f3bf2d
    resource: repo://packages/components/src/temporal/workflows/account.ts
  - id: openwiki-source-1478d95c096325a2041fecee
    resource: repo://packages/components/src/temporal/workflows/create-grants.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
  - id: openwiki-source-23ba2a7bbe5efb6e2d77954d
    resource: repo://packages/components/src/workers/main.ts
  - id: openwiki-source-9b409abe21ade962fb73ed30
    resource: repo://packages/components/test/delegated-grants.test.ts
  - id: openwiki-source-81127af59080ceff3a2cde89
    resource: repo://packages/data-model/src/index.ts
generated: { by: "pi", at: "2026-10-21T05:20:05.106Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T05:20:05.106Z
---

# Temporal workflows and activities

Asynchronous work runs on Temporal. The client is bootstrapped per HTTP request
and the worker is a long-lived process inside the `components` package.

## Bootstrap

`packages/components/src/temporal/client.ts` defines the `Temporal` class whose
`init()` lazily opens a `Connection` to `TEMPORAL_ADDRESS` and builds a
`Client` (with an optional `OpenTelemetryPlugin`). Each HTTP handler constructs
a `new Temporal()` per request rather than pooling connections.

`packages/components/src/workers/main.ts` is the worker entrypoint: it connects
with an infinite 500 ms retry, initializes tracing (`sai-worker`), registers
four `Worker.create` instances, runs them concurrently, then shuts down OTel
and the connection. The four registrations are:

- `forward-to-push` — `forward-to-push` workflows + push activities;
- `reciprocal-registration` — reciprocal workflows plus grants activities
  (because `establishReciprocal` calls `markActivitiesDone`);
- `create-grants` — the `create-grants.ts` barrel plus the grants, admin,
  invitation, access-request, **and account** activity sets;
- `webhook-delivery` — the `webhook-delivery.ts` workflow plus the
  `postWebhook` activity.

The `services/worker` package is only a skeleton; the deployed entry is
`packages/components/dist/workers/main.js` run by the Compose `worker` service.

## Task queues

Most queues are inline string literals repeated by the producers in
`ActivityWebhookHandler` and the grant handlers. The webhook queue is the
exception: the emitter and worker share the exported
`WEBHOOK_DELIVERY_TASK_QUEUE` constant.

- `create-grants` — the main queue; hosts the `create-grants.ts` barrel
  (grants + admin + invitation + access-request + **account** workflows) and
  registers all five activity sets accordingly. Because `grants.ts` imports
  `syncReciprocalMirror` from `reciprocal.ts` (the mirror child of the
  delegated-grants consumer), the reciprocal workflows are also present in this
  bundle — harmless: Temporal routes a run by its start queue, so they are
  still started on `reciprocal-registration`.
- `reciprocal-registration` — `reciprocal.ts` workflows, registering
  reciprocal **and** grants activities (because `establishReciprocal` calls
  `markActivitiesDone`).
- `forward-to-push` — `forward-to-push.ts` and the push activity;
- `webhook-delivery` — `webhook-delivery.ts` and the `postWebhook` activity.

## Workflow catalog

- `grants.ts` — `storeGrant`, `revokeGrants`, `processGranteeActivities` and
  `processDelegatedGrantsUpdated` (the two start-or-signal consumers),
  `createGrantsForAuthorization`, `processAuthorizationGranted`,
  `processGranteeAuthorization`, `updateDelegatedGrants`, `createRole`,
  `processRoleMembershipChange`, `processRoleDeletion`, `reconcileActivities`,
  and `createGrantsForAgent`.
- `admin.ts` — `createAdminGrants`, `revokeAdminGrants`, `syncAdminAcr`, and
  the `processAdminAuthorizationGranted/Revoked` orchestrators.
- `invitation.ts` — `createInvitation`.
- `reciprocal.ts` — `establishReciprocal`, `acceptInvitation` (both seed the
  reciprocal mirror as their last step before completing), and
  `syncReciprocalMirror` — the replication step, run as an activity directly by
  the invitation workflows and as a **child workflow** (explicit
  `taskQueue: 'reciprocal-registration'`) by the delegated-grants consumer.
- `access-request.ts` — `processNeedBasedAccessRequest`,
  `processNeedBasedAccessRequestReceived`, `detectGrantedRequests`.
- `account.ts` — `bootstrapAccount`, the five-step storage-provisioning
  workflow: `createFusekiDatasets`, `createObjectBucket`,
  `writeEndpointRecords`, `postBootstrapTriG`, `writeAccountRecords` (each
  find-first; a retry mints a fresh Garage key and compensates on failure).
- `forward-to-push.ts` — `sendPushNotifications`.
- `webhook-delivery.ts` — `deliverWebhook`, a one-activity workflow with a
  1-minute start-to-close timeout and retry 1s, backoff 2, maximum 60s,
  maximumAttempts 10.

Two access-request/invitation workflows deserve their own note:

- `detectGrantedRequests` is started as a **fire-and-forget child at the end of
  `updateDelegatedGrants`**. It reads the requester's open sent requests and
  received grants, matches them, and writes one terminal `AccessRequestGranted`
  activity per match (no completion — the class is the outcome).
- `acceptInvitation` is the **acceptor-side** workflow started from the
  `InvitationAccepted` activity by the webhook handler on
  `reciprocal-registration`. It POSTs the opaque capabilityUrl as the acceptor,
  builds the acceptor → inviter registration and reciprocal, subscribes the
  reciprocal webhook, seeds the local mirror of the inviter's registration of
  the acceptor, and marks the activity done (personal and org contexts alike).
  Its inviter-side counterpart `establishReciprocal` does the same seeding for
  its own leg, so a pair is mirrored on both ends from the moment its
  invitation completes.

The terminal resolution classes `AccessRequestGranted`, `AccessRequestArchived`,
and `AuthorizationDenied` never start a workflow and never get a completion;
`reconcileActivities` closes their outbox rows instead.

## The two consumers

Two long-lived workflows coalesce bursts per target instead of running one
workflow per activity. Both are started with a deterministic id and
start-or-signal (a failed start means a run is live, so the handler signals it;
a closed run is restarted), drain their pending set in a loop, and write the
completions themselves. After an empty drain each waits ~3s for a signal, then
exits — the residual exit-window gap is the reconcile sweep's concern.

| Consumer | Workflow id | Drained set | Steps |
| --- | --- | --- | --- |
| `processGranteeActivities` | `grantee:<webId>:<authorizationGrantee>` | pending `AuthorizationGranted` / `AuthorizationRevoked` for that grantee | resolve grantees → `createGrantsForAgent` per grantee → complete |
| `processDelegatedGrantsUpdated` | `delegated-grants:<webId>:<peerId>` | pending `DelegatedGrantsUpdated` whose `target` is that peer | `syncReciprocalMirror` child (replication) → `updateDelegatedGrants` **without** `activityId` → complete |

The delegated-grants consumer deliberately passes no `activityId` to
`updateDelegatedGrants`: with one, that workflow would write the completion by
itself, before the consumer owns the barrier. `reconcileActivities` reuses both
consumers (start-or-join) rather than calling the underlying workflows.

## Boundary objects and routing

- **Typed `{id, type}` boundary objects** — `AgentId = SocialAgentId |
  ApplicationId` and `AgentOrRoleId = AgentId | RoleId` are the identities
  passed across workflow/activity payloads (e.g.
  `CreateGrantsInput.authorizationGrantee: AgentOrRoleId`,
  `CreateGrantsForAgentInput.grantee: AgentId`).
- **Self-contained regeneration** — `createGrantsForAgent` fetches all the
  grantee's authorizations (including via roles) and existing grants itself,
  handles the empty/deny case, generates/stores/requests grants, and rewrites
  the registration links.
- **Role routing** — `findRoleUsage` delegates to `session.findRoleUsage`,
  which returns `usedAsGrantee` plus `affectedGrantees`; the membership/deletion
  workflows route role-as-grantee to the changed members and role-as-dataOwner
  to the affected grantees (members for a role, the agent itself otherwise).
- **Registration invariant** — grantees are always registered: grant
  generation relies on it (the registration "is guaranteed to exist"), and
  `replaceDataGrantsOnRegistration` throws if no registration is found; for
  applications `ensureApplicationRegistration` maintains it.
- **Sandbox rule** — workflow modules run in the Temporal sandbox and avoid
  runtime imports; `grants.ts` defines local IRI constants and a sandbox-safe
  `isActivityClass` instead of importing them.

## Granting fan-out

`recordAuthorization` writes **one** `AuthorizationGranted` activity with the
`dataAuthorizations` object, and `shareResource` writes **one**
`AuthorizationGranted` for all grantees. `processAuthorizationGranted` groups
that object by `grantee` and fans out an `executeChild` of
`processGranteeAuthorization` per group; each child materializes its data
authorizations and regenerates the grantee's grants, and the parent completes
only after all children succeed.

## Webhook delivery activity

`postWebhook` reads a `PostWebhookInput` of `sendTo`, `body`, and optional
`contentType`, then POSTs to `sendTo`. It returns on any 2xx. It throws a
non-retryable `ApplicationFailure` for `400`, `410`, `413`, `415`, and `422`;
other 4xx, 5xx, and network errors are retryable. Delivery is at-least-once, so
a lost 2xx or a 5xx after receiver processing can repeat the notification.
`DurableWebhookEmitter` starts `deliverWebhook` with a random workflow id and
falls back to a direct POST when the enqueue fails.

## Activities and the service layer

Every activity lazily resolves a session via
`buildSessionManager().getSession(webId)` and then calls the
authorization-agent / service APIs (`findAffectedGrantees`,
`generateDataGrants`, `RoleRegistry.updateRole`, `ActivityRegistry.createCompletion`, …).
The account activities are the exception: they do not run in a CSS server, so
they read their own process env (`CSS_FUSEKI_BASE_URL`/`CSS_FUSEKI_ADMIN`,
`CSS_GARAGE_ADMIN_ENDPOINT`/`CSS_GARAGE_ADMIN_TOKEN`, `CSS_S3_ENDPOINT`,
`CSS_POSTGRES_CONNECTION_STRING`) and use `getSharedEndpointStore()`.
Activities are deliberately find-first idempotent (`If-None-Match: *` PUTs,
404-tolerant deletes) so retries and `reconcileActivities` are safe. A CSS
SPARQL-backend `dcterms:modified` race forces serialized loops instead of
`Promise.all`. The ordering invariant is activity-first: an activity is marked
done only after all derived work succeeds.

The activity→workflow dispatch mapping lives in
[Activity outbox and events pipeline](../services/activity-lifecycle.md); the
flows each workflow realises are drawn in
[Sequence and discovery flows](../temporal/sequence-views.md).
