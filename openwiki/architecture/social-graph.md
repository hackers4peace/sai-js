---
type: architecture
title: Social graph
description: How systems of different peers connect — the reciprocal webhook and mirror, request/response endpoints (invitation, delegation issuance, agent-id), authenticated pod accesses, the delegation chain with match-based validity and grant reuse, and the org↔admin edges.
tags: [architecture, social-graph, federation, invitations, delegation, webhooks, grants]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T17:33:35.590Z
sources:
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-7b94b7d1bbbc76b34b554505
    resource: repo://packages/components/src/AgentIdHandler.ts
  - id: openwiki-source-99a0f343f48d54d1c1e98086
    resource: repo://packages/components/src/GrantIssuanceHandler.ts
  - id: openwiki-source-f61ceb613541bbcadb627564
    resource: repo://packages/components/src/InvitationHandler.ts
  - id: openwiki-source-b51f04210bf90c2ec8824400
    resource: repo://packages/components/src/ReciprocalWebhookHandler.ts
  - id: openwiki-source-4d3b0f3b2548bcc05444118e
    resource: repo://packages/components/src/ReciprocalWebhookStore.ts
  - id: openwiki-source-9e7488ce272b5af0500c0557
    resource: repo://packages/components/src/services/GrantReplica.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-b407f45a278715ed33b367aa
    resource: repo://packages/components/src/temporal/activities/reciprocal.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-6b6976370d0cdcf6bd57cad3
    resource: repo://packages/data-model/src/grant.ts
  - id: openwiki-source-ffa35cc9379c0d10f59dfee0
    resource: repo://packages/utils/src/notifications.ts
generated: { by: "pi", at: "2026-10-21T17:33:35.590Z" }
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
| 2 | one-shot request/response HTTP | initiatee → responder | invitation POST, delegation issuance POST, agent-id discovery |
| 3 | authenticated pod reads/writes | our session ↔ peer pod | reciprocal discovery, ACR writes, profile/grant reads |

## Tier 1 — the reciprocal webhook

The per-pair push edge is created by the `reciprocalWebhook` Temporal activity,
invoked from the `establishReciprocal` workflow, which is triggered only by an
`agentRegistrationAdded` activity written by the **inviter's**
`InvitationHandler`. Subscriptions are deduped per pair
(`ReciprocalWebhookStore.findAllBetween`). The subscription itself is created
with the in-repo `subscribeToNotificationChannel` helper (which replaced the
`@solid-notifications/*` packages) against a `WebhookChannel2023` whose
`sendTo` points at our handler. The webhook watches
`registration.reciprocalRegistration` — the *peer's registration of the
inviter* — so it fires when the peer PATCHes their registration of the inviter
(e.g. sets an access need group, or updates `hasDataGrant`). On receipt,
`ReciprocalWebhookHandler` PUTs a `delegatedGrantsUpdated` activity (its
`object` is the subscription's own `topic` — the reciprocal registration IRI —
recorded for traceability only). The per-peer consumer
(`processDelegatedGrantsUpdated`) then replicates the mirror, regenerates the
inviter's grants where the peer is the data owner (reusing an equivalent
delegated subtree when nothing changed), and only then completes.

`syncReciprocalMirror` calls `updateReciprocalMirror`, which writes a read-only
local copy of the peer's reciprocal registration and its linked grants into the
writing context's **registry-pod dataset** (through that session's endpoint).
With per-pod datasets this mirror is effectively the *only* way the local
session sees grants the peer issued to us — the peer's own dataset is not
reachable — so the mirror is the upstream for delegated-grant generation (see
[Per-pod storage and isolation](storage-isolation.md) and
[Federation constraints](federation.md#the-reciprocal-mirror-in-detail)).

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
invitation-polarity-dependent — one channel per (admin, org).

## Tier 2 — request/response endpoints

| Endpoint | Handler | Purpose |
| --- | --- | --- |
| `POST /.sai/invitations/<base64(webId)>.<uuid>` | `InvitationHandler` | invitee registers, writes `agentRegistrationAdded` (which creates the Tier-1 edge) |
| `POST /.sai/grants/<base64(dataOwner)>` | `GrantIssuanceHandler` | delegated-grant issuance; validates the delegable grant, stores grant + ACR, runs `storeGrant` (bypasses the outbox), and echoes the finalised grants so the grantor can store its issuer-side replica |
| `GET/HEAD /.sai/agents/<base64(webId)>` | `AgentIdHandler` | authorization-agent client-id document; for an admin of the org, also returns `Link: rel="interop:hasRegistrySet"` (evaluated against request credentials, so it stays admin-only) |

## Tier 3 — authenticated pod accesses

Carried by the agent's session (`session.fetch`) directly against the peer's
CSS — no endpoint of ours involved: `discoverReciprocal` (peer webId → their
UAS → their registration of us), `createAcr` (PUT the ACR onto the data owner's
pod), and label/profile/grant reads.

## Delegation chain (dataOwner ≠ grantedBy ≠ grantee)

In a three-party chain Alice (dataOwner) → Bob (grantedBy) → Charlie (grantee),
the edges are: delegation issuance (Bob's stack → Alice's `GrantIssuanceHandler`),
grant + ACR physical writes (Alice's session on her storage via `storeGrant`),
and a reciprocal webhook on Bob/Charlie that depends on invitation polarity —
not on the delegation relationship.

Delegated grants **no longer store `delegationOfGrant`**. Chain validity is a
match-based predicate over the data owner's registry: a root grant is valid when
`grantedBy == dataOwner`, and a delegated grant is valid when an upstream grant
exists with `grantee == g.grantedBy`, the same `dataOwner`, shape tree and
registration, and scope/access-mode coverage. Issuance and revocation validation
use the same predicate.

Regeneration reuses an equivalent delegated subtree from the **issuer-side
replica** (the grant bodies the issuance endpoint echoed and the grantor stored
locally — see [Grant equivalence and reuse](grant-reuse.md)), so an unchanged
chain keeps its grant IRIs instead of re-requesting delegated grants.

The **grantee-visibility gap** follows the webhook polarity: after
`createGrantsForAgent` regenerates Charlie's grants, it PATCHes `hasDataGrant`
on Bob's registration of Charlie — the write Charlie's UI needs to hear — but
whether Charlie gets a live event depends on who invited whom. If Bob invited
Charlie, nobody hears the PATCH and Charlie falls back to mount/reconnect
refetches.

## Org ↔ admin

An administered org is a peer the user acts *for*: the admin performs Tier-3
reads/writes against the org's registries with their own UAS, but the **org**
is the data owner (the admin is a client of another peer's registries). The
edges are agent-id discovery (admin-only `hasRegistrySet` link), the forward-only
org Activity-Registry webhook channel (events keyed by the admin's webId), and
Tier-3 reads/writes admitted by the org's `#fullAdminAccess` ACP matchers. The
org's authorization agent may live on a different server than the admin's.
