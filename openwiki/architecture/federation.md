---
type: architecture
title: Federation constraints
description: The single-deployment shortcuts the SAI implementation still relies on — shared storage, global-fetch discovery, local pod ownership, the org AA's registry-set link, and one notification path — the per-pod replacements that have landed (including the reciprocal mirror and the issuer-side grant replica), and what must keep working when the auth, registry, and data servers split.
tags: [architecture, federation, storage, discovery, org-context, webhooks, mirror, grants]
sources:
  - id: openwiki-source-0531e8ebff475ca0a556fc29
    resource: repo://packages/authorization-agent/src/grant-generation.ts
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-0b475136796d3c6391256850
    resource: repo://packages/components/config/overrides/emitter.json
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-99a0f343f48d54d1c1e98086
    resource: repo://packages/components/src/GrantIssuanceHandler.ts
  - id: openwiki-source-9e7488ce272b5af0500c0557
    resource: repo://packages/components/src/services/GrantReplica.ts
  - id: openwiki-source-c4233c9bce7ccb07d3edd54a
    resource: repo://packages/components/src/services/ReciprocalMirror.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-b407f45a278715ed33b367aa
    resource: repo://packages/components/src/temporal/activities/reciprocal.ts
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
generated: { by: "pi", at: "2026-10-22T04:35:20.186Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-22T04:54:18.757Z
---

# Federation constraints

The org-admin data plane is the first feature that **crosses servers**: an admin
of an org operates on the org's registries (possibly on a different server than
the admin's), and admin grants on data registries are consumed by the
permission engine on the data server. The current implementation still takes
shortcuts that hold while the auth, registry, and data servers are
co-deployed. This page records them, their current status, and the cases that
must keep working when real federation lands.

## Shortcuts and current status

| # | Shortcut | Today | What breaks when servers/stores split |
| --- | --- | --- | --- |
| 1 | One shared SPARQL store | Dev/test uses one Fuseki dataset per pod (registry/data) plus a dedicated `id` dataset, resolved through `PodEndpointStore` with **no default fallback**; production Nix still runs one Oxigraph (see [Deployment landscape](deployment-landscape.md) and [Per-pod storage and isolation](storage-isolation.md)). | The old cross-graph grant query (`GRAPH ?g {?s interop:hasStorage <storage>}` over every graph) no longer sees other owners' grants. The per-pod replacement is two lookups: the resource's data-pod dataset for the resource graph (`SaiPermissionsEngine`), and the storage owner's registry-pod dataset for grants (`SaiAuthorizationManager` via `podStore.getOwners` → `registryId(owner)`). |
| 1a | Reciprocal mirrors | `updateReciprocalMirror` writes the peer's reciprocal registration and the grants it links into the context's own registry-pod dataset. The mirror is **seeded on both invitation legs** — `establishReciprocal` (inviter) and `acceptInvitation` (acceptor) — before their activity completes, and afterwards refreshed **only** by the per-peer delegated-grants consumer (`processDelegatedGrantsUpdated`, workflow id `delegated-grants:<webId>:<peerId>`): each drain runs the `syncReciprocalMirror` child workflow on `reciprocal-registration`, then regenerates the delegated grants from the fresh mirror, then completes the activity. The mirror is the input to `generateDelegatedDataGrants`, not a UI cache. | The mirror is the **only** source for grants the peer issued to us once stores are split; freshness is eventually consistent and depends on webhook delivery. A delivery that never arrives, or a pair whose mirror was never written, is repaired by the reconciliation sweep's local completeness arm (see [Authorization revocation and grant projections](authorization-revocation.md)) and by the cutover backfill in [`pod-isolation-followup.md`](../../docs/plans/pod-isolation-followup.md) A1; the production cadence is a deployment concern (`update-deployment.md`). A `404`/`410` on the peer's registration is terminal (the replica is dropped and the activity completes without regenerating); every other failure keeps retrying, and after the 5-attempt cap a permanently unreadable peer leaves the activity `pending` (documented in [`update-deployment.md`](../../docs/plans/update-deployment.md)). Unregister propagation (`deleteReciprocalMirror`) is implemented but still has no caller. |
| 1b | Issuer-side grant replica | Delegated grants live in the **data owner's** registry; the grantor keeps only the IRIs. The issuance endpoint echoes the finalised grants, and `requestDelegations` writes each body into the context's own registry-pod dataset (`storeGrantReplica`, `GRAPH <grantIri>`), so grant reuse can compare delegated trees without a peer read. | Reuse no longer depends on peer availability or on the grantor-read ACR policy. A missing body fails closed — the subtree is regenerated once and the echo repopulates it. Grants issued before the echo existed have no body until that first regeneration; replica graphs of unlinked grants are not dropped yet (see below). |
| 2 | UAS/storage discovery uses the global `fetch` | `SaiPermissionsEngine` and `AdminPermissionReader` call `discoverAuthorizationAgent(agent, fetch)` with the global fetch; storage-description discovery does the same. | Peers' WebID profiles and storage descriptions must be reachable and DNS-resolvable. Revisit when servers are actually split across hosts. |
| 3 | Pod/storage ownership is local | `AdminPermissionReader.requestFromAdmin` decides "owner of this storage" via the local `podStore.getOwners(storage.id)`. | A data server must mirror remote org ownership or resolve it on the wire (e.g. via the org's agent-id document / registry set). |
| 4 | The org's Authorization Agent serves the registry-set link | The org's AA may live on a different server than the admin's; it serves the org's agent-id document and the admin-only `Link: <registrySet>; rel="interop:hasRegistrySet"` header, and runs the org's Activity Registry workflows. The admin's AA performs the UI interactions. | This is the **intended** federation shape for the registry plane: the header carries the authoritative RegistrySet IRI across servers. |
| 5 | One notification path | The org's Activity Registry webhook reaches `ActivityWebhookHandler`; admin channels are forward-only (keyed by the admin's webId), so org-context events reach the admin's own stream without dispatching workflows. Registry and data webhook delivery is durable through `DurableWebhookEmitter` and the `webhook-delivery` Temporal queue. | Cross-server webhook delivery is durable; channel provisioning still needs the real-deployment bootstrap in `webhook-subscription-bootstrap.md`. |

## The reciprocal mirror, in detail

The mirror is a server-side, read-only copy of peer registry data, written by
`updateReciprocalMirror` with the context's own session and read strictly as a
replica by everything else.

- **Contents.** For every social-agent registration carrying a
  `reciprocalRegistration` link: the peer's registration *of us* (the grantee
  side) and every grant that registration links via `interop:hasDataGrant` —
  parents and inheriting children alike, since the grantor links both. Grants
  where *we* are the `grantedBy` are not part of this mirror: source grants
  live in our own grant registry, and delegated grants issued by a peer are
  replicated separately by the
  [issuer-side grant replica](#the-issuer-side-grant-replica).
- **One atomic update.** All fetches happen before a single SPARQL `UPDATE`, so
  a worker failure leaves no partial state. The grant-link set acts as the
  existence oracle: a linked grant that is already mirrored is neither
  re-fetched nor re-inserted, because grants are immutable (a change mints a
  fresh IRI). No-longer-linked grants are dropped.
- **Presence, not content.** The oracle verifies that each still-linked grant
  actually has a body (`presentGraphs`, the same `GRAPH <iri>` UNION
  `GRAPH <meta:iri>` union `graphDoc` frames) and re-fetches the ones that do
  not — otherwise a grant lost to a graph-at-a-time writer or a single-graph
  restore would stay missing forever. Every `DROP` covers both the resource
  graph and its `meta:` twin, so a seeded/restored meta copy cannot shadow the
  fresh graph through the union.
- **Failure classification.** `fetchJsonLd` raises a typed `HttpStatusError`
  (iri + status) and `syncReciprocalMirror` classifies it: a `404`/`410` **on the
  peer's registration** is terminal — the replica is dropped and the activity is
  completed **without regenerating** (there is no source left), so a peer that
  unregistered us cannot block `done` forever. A `404` on a *linked grant* is
  retryable (the reciprocal document still lists a grant the peer already
  replaced; the next sync reads the updated link set and the replica is kept).
  `401`/`403`, `5xx` and network errors retry, and the sync's 5-attempt cap
  bounds them. A mirror gap inside a successful sync surfaces as
  `MirrorIncompleteError(<iri>, kind)` from delegated-grant generation instead of
  a generic framing error.
- **Grantee-side reads are batched.** Consent and browsing views
  (`getDescriptions` data owners, `DataRegistry` grant index + instance listing,
  the social-agent list's `adminOf` and data-owner rows, the org-admin gate) read
  the replica through `getReciprocalGrants` (link set + all bodies in two
  queries), `getRegistrationLinks` and `getLinkedGrantOwners` (one query each)
  instead of framing a registration and every linked grant per peer.

## The issuer-side grant replica

The reciprocal mirror covers the **grantee** direction (peer data we may read).
Grant reuse also needs the **grantor** direction: a delegated grant we request
from a data owner is written to *that owner's* registry, while our side keeps
only the IRIs it gets back. `storeGrantReplica` closes that gap at issuance
time.

- **Write point.** The issuance endpoint echoes the finalised grants (parents
  **and** children) instead of bare IRIs. `requestDelegations` parses them,
  writes each body as `GRAPH <grantIri>` in the context's own registry-pod
  dataset, and returns the ids to the workflow. The write is **best effort**:
  the grants are already issued, so failing the activity would retry the POST
  and mint duplicates; a missing body only disables reuse (fail closed) until
  the next issuance or regeneration repopulates it.
- **Shape.** Same convention as the reciprocal mirror: one named graph per
  grant IRI, read through `graphDoc`. The parent document keeps the reverse
  `inheritsFromGrant` edges (the context maps `hasInheritingGrant` to the
  reverse property), so framing the parent surfaces its children; child bodies
  are their own graphs. Grants are immutable, so re-writing a body is a no-op.
- **Read side.** `getExistingGrantBodies` reads only the local SPARQL endpoint —
  own grant registry for source grants, this replica for delegated ones — and
  follows `hasInheritingGrant` recursively. A missing or unframable body is
  skipped, so the tree it belongs to fails the completeness check and is
  regenerated instead of reused.
- **Lifetime.** `storeGrantReplica` only inserts; dropping is a separate
  operation. `dropGrantReplicas` removes the replica graph and its `meta:` twin
  when the reconciliation removes the delegated tree (revocation or
  replacement), and it never names own grant-registry graphs. Stale graphs that
  survive a crash are invisible to reuse (only current registration links are
  read) and are removed by the next reconciliation; grants issued before the
  echo existed are regenerated once, which then populates the replica.

See [Grant equivalence and reuse](grant-reuse.md) for the comparison itself and
the workflow result contract.

## Cases the design must keep working

- **Admin status check from the data plane.** Data-server enforcement reads
  AdminGrants from the org's GrantRegistry (registry plane), not from registry
  ACRs — a different server and a different enforcement layer by design. The
  admin decision must come from grants discoverable from the data server.
- **Storage → org resolution.** The engine must map a target storage to the
  owning RegistrySet to know which AdminGrants apply. Today this falls out of
  `hasStorage` matching; in federation it may need the registry-set link or a
  storage-ownership registry.
- **Cross-server webhook/activity delivery** so admin UI events do not depend
  on co-location.
- **Mirror completeness at the per-pod cutover.** Every live reciprocal
  registration must be mirrored and fresh before an org moves to its own store,
  otherwise org-context views silently lose peer-derived rows (labels,
  access-requested flags, grants).

## What has actually landed

- The dev/test per-pod store split (Fuseki datasets, `PodEndpointStore`,
  routed accessors, session/context allowlists) — see
  [Per-pod storage and isolation](storage-isolation.md).
- The reciprocal mirror writer with invitation-time seeding on both legs, and
  the per-peer delegated-grants consumer that replicates the mirror before
  regenerating (`processDelegatedGrantsUpdated` on `create-grants`, with the
  `syncReciprocalMirror` child on `reciprocal-registration`; the same consumer
  is reused by `reconcileActivities`).
- Mirror-only delegated-grant generation: one peer index per regeneration and an
  explicit `MirrorIncompleteError` when a reciprocal-linked graph is absent.
- The terminal-error policy (`404`/`410` on the peer registration ⇒ drop the
  replica, complete without regenerating) and the batched grantee-side reads.
- The issuer-side grant replica written from the issuance echo, and whole-tree
  grant reuse over locally loaded bodies (`checkEquivalence` returns
  value-based `reusedSourceIds` / `reusedDelegatedIndexes` / `reusedExisting`) —
  see [Grant equivalence and reuse](grant-reuse.md). `delegationOfGrant` was
  dropped from the data model, generation, issuance, and seed; delegated-chain
  validity is match-based.
- Durable webhook delivery: `DurableWebhookEmitter` on registry/data, the `deliverWebhook` workflow and `postWebhook` activity on the `webhook-delivery` queue, at-least-once retries, and the direct-POST fallback when enqueueing fails.
- Revocation-driven cleanup: the projection GC deletes non-reused grants through
  the owner's C1 closure, requests peer-owned removals at the
  `AccessRevocation` boundary, drops the removed delegated trees' issuer-side
  replicas, and PATCHes the registration last — see
  [Authorization revocation and grant projections](authorization-revocation.md).
- The owner-registry-pod grant lookup and the data-pod resource lookup in the
  permission engine.
- The admin-only `hasRegistrySet` link and the forward-only admin channel.

Open work remains tracked in
[`pod-isolation-followup.md`](../../docs/plans/pod-isolation-followup.md)
(mirror backfill, unregister deletion — including the dangling reciprocal link a
terminal `404`/`410` leaves behind — external admin-endpoint discovery,
cross-pod tests), [`grants-replication-polish.md`](../../docs/plans/grants-replication-polish.md)
(peer-side orphan scan, stranded revocation end-state, role-grantee verification,
remaining tests), and [`webhook-subscription-bootstrap.md`](../../docs/plans/webhook-subscription-bootstrap.md)
(real-deployment channel provisioning). Issuer-side replica cleanup with the
orphaned grants has landed in the revocation GC. The production cutover is in
[`update-deployment.md`](../../docs/plans/update-deployment.md).

## Related pages

- [Authorization revocation and grant projections](authorization-revocation.md)
  — the projection GC, chain closure, boundary, and sweep backstop.
- [Grant equivalence and reuse](grant-reuse.md) — the tree comparison and the
  value-based regeneration result.
- [Per-pod storage and isolation](storage-isolation.md) — the store split and
  endpoint allowlists.
- [Deployment landscape](deployment-landscape.md) — production still uses one
  Oxigraph while dev/test is per-pod.
- [Org-context data plane](../services/org-context.md) — the admin read/proxy
  plane and its gates.
- [Social graph](social-graph.md) — reciprocal webhooks, delegation, and the
  org↔admin edges.
- [Activity outbox and events pipeline](../services/activity-lifecycle.md) — how
  a peer update reaches the consumer, and what `done` guarantees.
