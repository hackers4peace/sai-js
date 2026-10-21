---
type: reference
title: Sequence and discovery flows
description: A catalogue of the dynamic views in docs/temporal.c4 — discovery, reciprocal registration, invitation, admin, roles, share/request access, and authorization flows — plus the LikeC4 authoring conventions used to keep them consistent.
tags: [likec4, sequences, flows, temporal, discovery]
sources:
  - id: openwiki-source-f94e6df9b22c5d9088de9576
    resource: repo://docs/temporal.c4
  - id: openwiki-source-c18acf0c50387f2e5ea026d1
    resource: repo://packages/components/src/ActivityWebhookHandler.ts
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-b51f04210bf90c2ec8824400
    resource: repo://packages/components/src/ReciprocalWebhookHandler.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
generated: { by: "pi", at: "2026-10-21T05:20:05.106Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T05:20:05.106Z
---

# Sequence and discovery flows

`docs/temporal.c4` is the authoritative catalogue of interaction sequences,
modelled as LikeC4 **dynamic views**. Its `model` block defines the parties as
`security` actors — `ACME`, `Others`, `Common`, `Alice`, `Bob`, `Kim`, `Dan`,
`YoYo`, `Peers`, and `App` — where each user/org actor owns a **UAS** (User
Authorization Server) containing `UiApi`, `Temporal`, `WebhookReceiver`, and
`Discovery`, plus a `Registry`, an optional `Data` registry, a `WebhookSender`,
and an `AUI` authorization UI. `App` owns the application-side
`StreamingHTTPReceiver`, `UI`, and `CID`. `Common` hosts the shared
`Shapetrees` directory.

## LikeC4 conventions

The dynamic views follow a fixed set of authoring conventions:

- **Dynamic views & steps** — view ids and `navigateTo` targets are kebab-case
  (`social-agent-registration-discovery`); step syntax is `SOURCE -> TARGET
  'title'` (`<-` for a response step, `<->` is not valid); a `navigateTo
  <view-id>` on a step renders the drill-down link. Never leave unused
  includes — every included element is referenced by a step or a style.
- **Include ordering** — acceptor first, then the inviter party, then the
  admin; in two-party views the parties' components mirror around the registry
  seam so the two registries sit adjacent. Colors: `green` inviter/org owner,
  `indigo` admin, `sky` acceptor/peer.
- **Notes & callouts** — a step's note opens with an h4 header that repeats
  the relationship title, then callouts; every step carries a `>[!NOTE]` with
  `>file > describe`; requests carry a `>[!IMPORTANT]` naming the acting
  identity (e.g. `Auth: CSS cookie session as alice`); `>[!TIP]` only for
  genuine patterns.
- **Request + response is a single step** — a request and its directly
  following response are one step; the response `HTTP/1.1 <status>` (+ payload)
  goes at the bottom of the request step's note, separated by a `---` line.
  Non-adjacent responses stay separate steps.
- **Code blocks** — `http` blocks are minimal (request line + auth/type
  headers); JSON-LD payloads use the compacted form with the expanded-context
  note; SPARQL declares `PREFIX` with subject/predicate/object on their own
  lines. Validate with `likec4 validate --json --no-layout --file <file>
  <project-dir>`.

## Discovery flows

- `application-registration-discovery` — an application performs a `HEAD` on
  the authorization-agent id with credentials; `Discovery` looks up the
  Application Registration and returns it via a Link header.
- `social-agent-registration-discovery` — one UAS's `Discovery` asks a peer
  UAS's `Discovery`; the peer finds the Social Agent Registration and returns
  it via a Link header.
- `org-registry-set-discovery` — an org admin's `Discovery` resolves the org's
  Registry Set; the `hasRegistrySet` link is returned only when the caller's
  registration carries the `hasAdminGrant` admin marker.

## Reciprocal registration

- `reciprocal-registration-update` — a peer's `Update` is written as a
  `DelegatedGrantsUpdated` activity. The activity Add reaches auth through the
  durable `DurableWebhookEmitter` and `deliverWebhook` path. `ActivityWebhookHandler`
  then start-or-signals the per-peer `processDelegatedGrantsUpdated` consumer
  (workflow id `delegated-grants:<webId>:<peerId>`); each drain runs the
  `syncReciprocalMirror` child workflow on `reciprocal-registration` **first**,
  then `updateDelegatedGrants` (finding the affected authorizations, fanning out
  grant updates and delegation registration), then writes the completion — so
  `done` means the mirror is current.
  **Model drift:** `docs/temporal.c4` still draws the previous shape (a direct
  `start updateDelegatedGrants workflow` plus a parallel, serialized mirror
  sync); the view needs updating the next time the model is touched. The LikeC4
  view does not show the webhook-delivery queue.

## Invitation

- `invitation` — personal invitation create/accept.
- `admin-invitation-send` / `admin-invitation-receive` — org-context
  invitations where a person invites an org (accepted by the org admin) and an
  org admin invites a person.

Both invitation flows also seed the reciprocal mirror before completing:
`establishReciprocal` on the inviter side and `acceptInvitation` on the acceptor
side each run `syncReciprocalMirror` as their last step before
`markActivitiesDone`, so a pair starts out mirrored on both ends.

## Admin

- `org-admin-add` / `org-admin-remove` — an org admin grants/revokes admin
  status on a member, driving `createAdminGrants`/`revokeAdminGrants` plus ACR
  sync.
- `org-admin-add-personal` / `org-admin-remove-personal` — a user makes an
  agent an admin of their own (personal) context.

## Roles

- `role-membership-change` — `processRoleMembershipChange` fans out grant
  updates to every member of a changed role.
- `role-deletion` — `processRoleDeletion` revokes grants tied to a deleted
  role.

## Authorization and access

- `authorization` and `authorization-data-app` — recording an authorization
  decision and the resulting authorization data.
- `authz-data-need-based-request` — the authorization data behind a
  need-based access request.
- `share-resource` — the owner shares a data instance, generating grants.
- `request-access` — a requester sends a need-based access request.
- `approve-access-request` / `deny-access-request` — the owner approves or
  (silently) declines a need-based access request.

The activity→workflow mapping is documented in
[Activity outbox and events pipeline](../services/activity-lifecycle.md); the
corresponding Temporal workflow definitions are in
[Temporal workflows and activities](../temporal/workflows.md).
