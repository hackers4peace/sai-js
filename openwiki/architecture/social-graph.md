---
type: architecture
title: Social graph
description: How systems of different peers connect — the reciprocal webhook and mirror, request/response endpoints (invitation and agent-id), authenticated pod accesses, the local delegated-grant projection, and the org↔admin edges.
tags: [architecture, social-graph, federation, invitations, delegation, webhooks, grants]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-91b9eb868de58a18862849c3
    resource: repo://packages/authorization-agent/src/grant-chain.ts
  - id: openwiki-source-f43abf593fa5899437adf71e
    resource: repo://packages/components/config/http/handler/default.json
  - id: openwiki-source-7b94b7d1bbbc76b34b554505
    resource: repo://packages/components/src/AgentIdHandler.ts
  - id: openwiki-source-f61ceb613541bbcadb627564
    resource: repo://packages/components/src/InvitationHandler.ts
  - id: openwiki-source-b51f04210bf90c2ec8824400
    resource: repo://packages/components/src/ReciprocalWebhookHandler.ts
  - id: openwiki-source-4d3b0f3b2548bcc05444118e
    resource: repo://packages/components/src/ReciprocalWebhookStore.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-b407f45a278715ed33b367aa
    resource: repo://packages/components/src/temporal/activities/reciprocal.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-6b6976370d0cdcf6bd57cad3
    resource: repo://packages/data-model/src/grant.ts
  - id: openwiki-source-ffa35cc9379c0d10f59dfee0
    resource: repo://packages/utils/src/notifications.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# Social graph

This page documents how the systems of **different peers** connect — the
inter-peer edges that carry invitations, delegated grants, and reciprocal
updates. The internal webhook on a peer's own Activity Registry is *not* an
inter-peer edge and lives in
[Activity outbox and events pipeline](../services/activity-lifecycle.md).

## Connection tiers

Inter-peer interactions fall into three tiers; only the first is event-driven.

| Tier | Kind | Direction | Examples |
| --- | --- | --- | --- |
| 1 | push webhook | peer registry → our handler | reciprocal webhook (per pair); org Activity-Registry admin channel |
| 2 | one-shot request/response HTTP | initiatee → responder | invitation POST, agent-id discovery |
| 3 | authenticated pod reads/writes | our session ↔ own/peer pod | reciprocal discovery, grant + ACR writes, profile/grant reads |

## Tier 1 — the reciprocal webhook

The per-pair push edge is created by the `reciprocalWebhook` Temporal activity,
invoked from the `establishReciprocal` workflow, which is triggered only by an
`agentRegistrationAdded` activity written by the **inviter's**
`InvitationHandler`. Subscriptions are deduped per pair
(`ReciprocalWebhookStore.findAllBetween`). The subscription itself is created
with the in-repo `subscribeToNotificationChannel` helper against a
`WebhookChannel2023` whose `sendTo` points at our handler
([`temporal/activities/reciprocal.ts`](../../packages/components/src/temporal/activities/reciprocal.ts),
[`utils/src/notifications.ts`](../../packages/utils/src/notifications.ts)).
The webhook watches `registration.reciprocalRegistration` — the *peer's
registration of the inviter* — so it fires when the peer PATCHes their
registration of the inviter (e.g. sets an access need group, or updates
`hasDataGrant`). On receipt, `ReciprocalWebhookHandler` PUTs a
`delegatedGrantsUpdated` activity (its `object` is the subscription's own
`topic` — the reciprocal registration IRI — recorded for traceability only).
The per-peer consumer (`processDelegatedGrantsUpdated`) then replicates the
mirror, regenerates the inviter's delegated grants, and only then completes.

`syncReciprocalMirror` calls `updateReciprocalMirror`, which writes a read-only
local copy of the peer's reciprocal registration and its linked grants into the
writing context's **registry-pod dataset**. With per-pod datasets this mirror is
effectively the *only* way the local session sees grants the peer issued to us —
the peer's own dataset is not reachable — so the mirror is the upstream for
delegated-grant generation (see [Per-pod storage and isolation](storage-isolation.md)
and [Federation constraints](federation.md#the-reciprocal-mirror-in-detail)).

Both invitation legs seed the mirror before completing (`establishReciprocal` on
the inviter side, `acceptInvitation` on the acceptor side), so a pair is mirrored
on both ends from the moment its invitation finishes. Later refreshes come only
from the peer's `Update`. A `404`/`410` on the peer's registration is terminal —
the replica is dropped and the activity completes without regenerating — while
grant-level `404`s, `401`/`403`, `5xx` and network errors retry (see
[Federation constraints](federation.md#the-reciprocal-mirror-in-detail)).

**Polarity asymmetry** is the key property: subscription ownership follows who
initiated the invitation, with one webhook per pair pointing from the peer's
registry to the inviter's stack. There is no code path that creates the
symmetric second edge on the invitee side.

A second, non-reciprocal Tier-1 edge is the **org Activity-Registry admin
channel**: an admin subscribes to the org's Activity Registry container with a
`WebhookChannel2023` whose `sendTo` reaches the admin's own handler. Unlike the
reciprocal webhook it is container-level (every `Add` on the org outbox) and not
invitation-polarity-dependent — one channel per (admin, org). Channel
provisioning for real deployments is not implemented yet (issue #113).

## Tier 2 — request/response endpoints

| Endpoint | Handler | Purpose |
| --- | --- | --- |
| `POST /.sai/invitations/<base64(webId)>.<uuid>` | `InvitationHandler` | invitee registers, writes `agentRegistrationAdded` (which creates the Tier-1 edge) |
| `GET/HEAD /.sai/agents/<base64(webId)>` | `AgentIdHandler` | authorization-agent client-id document; for an admin of the org, also returns `Link: rel="interop:hasRegistrySet"` (evaluated against request credentials, so it stays admin-only) |
| `GET/HEAD /.sai/grants/<base64(owner)>` | `AccessGrantHandler` | read-only view over the assigner's grant registry; grants are never issued or revoked through this route |

There is **no delegation-issuance POST** in the current protocol. Delegated
grants are projections of the assigner's own `DataAuthorization`s and are
written by the assigner's workflow into the assigner's grant registry
([`temporal/workflows/grants.ts`](../../packages/components/src/temporal/workflows/grants.ts)).
The old `.sai/grants` issuance route and
`interop:hasDelegationIssuanceEndpoint` are not part of the protocol.

## Tier 3 — authenticated pod accesses

Carried by the agent's session (`session.fetch`) against the relevant CSS — no
endpoint of ours involved: `discoverReciprocal` (peer webId → their UAS → their
registration of us), `storeGrantAndAcr` / `createAcr` on the **assigner's**
registry pod, and label/profile/grant reads. The data owner's pod is read
through the token-carried access paths, not by writing grants there.

## Delegation chain (dataOwner ≠ grantedBy ≠ grantee)

In a three-party chain Alice (dataOwner) → Bob (grantedBy) → Charlie (grantee),
Bob's `DataAuthorization` projects a delegated grant into **Bob's own** grant
registry. There is no Alice-side issuance handler and no issuer-side replica:
chain validity is a match-based predicate over the data owner's/assigner's
registry, and regeneration reuses an equivalent local subtree
([`grant-chain.ts`](../../packages/authorization-agent/src/grant-chain.ts),
[`grant-reuse.md`](grant-reuse.md)).

A root grant is valid when `grantedBy == dataOwner`; a delegated grant is valid
when an upstream grant exists with `grantee == g.grantedBy`, the same
`dataOwner`, shape tree, registration, and scope/access-mode coverage. Issuance
and revocation validation use the same predicate (see
[Authorization revocation and grant projections](authorization-revocation.md)).

The **grantee-visibility gap** follows the webhook polarity: when Bob's
reconciliation regenerates Charlie's grants, it PATCHes `hasDataGrant` on Bob's
registration of Charlie — the write Charlie's UI needs to hear — but whether
Charlie gets a live event depends on who invited whom. If Bob invited Charlie,
nobody hears the PATCH and Charlie falls back to mount/reconnect refetches.

## Org ↔ admin

An administered org is a peer the user acts *for*: the admin performs Tier-3
reads/writes against the org's registries with their own UAS, but the **org**
is the data owner (the admin is a client of another peer's registries). The
edges are agent-id discovery (admin-only `hasRegistrySet` link), the forward-only
org Activity-Registry webhook channel (events keyed by the admin's webId), and
Tier-3 reads/writes admitted by the org's `#fullAdminAccess` ACP matchers. The
org's authorization agent may live on a different server than the admin's.
