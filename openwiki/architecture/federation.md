---
type: architecture
title: Federation constraints
description: The single-deployment shortcuts the SAI implementation still relies on — shared storage, global-fetch discovery, local pod ownership, the org AA's registry-set link, and one notification path — the per-pod replacements that have landed (including the replicated reciprocal mirror), and what must keep working when the auth, registry, and data servers split.
tags: [architecture, federation, storage, discovery, org-context, webhooks, mirror]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T05:20:05.106Z
sources:
  - id: openwiki-source-0287d02e668cd550d1f3ce6d
    resource: repo://docs/plans/improve-grant-replication.md
  - id: openwiki-source-ab7b36e81b6383f76d2ccee3
    resource: repo://docs/plans/revoke-delegation-chain.md
  - id: openwiki-source-0531e8ebff475ca0a556fc29
    resource: repo://packages/authorization-agent/src/grant-generation.ts
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-0b475136796d3c6391256850
    resource: repo://packages/components/config/overrides/emitter.json
  - id: openwiki-source-c18acf0c50387f2e5ea026d1
    resource: repo://packages/components/src/ActivityWebhookHandler.ts
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-99a0f343f48d54d1c1e98086
    resource: repo://packages/components/src/GrantIssuanceHandler.ts
  - id: openwiki-source-c4233c9bce7ccb07d3edd54a
    resource: repo://packages/components/src/services/ReciprocalMirror.ts
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
generated: { by: "pi", at: "2026-10-21T05:20:05.106Z" }
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
| 1a | Reciprocal mirrors | `updateReciprocalMirror` writes the peer's reciprocal registration and the grants it links into the context's own registry-pod dataset. The mirror is **seeded on both invitation legs** — `establishReciprocal` (inviter) and `acceptInvitation` (acceptor) — before their activity completes, and afterwards refreshed **only** by the per-peer delegated-grants consumer (`processDelegatedGrantsUpdated`, workflow id `delegated-grants:<webId>:<peerId>`): each drain runs the `syncReciprocalMirror` child workflow on `reciprocal-registration`, then regenerates the delegated grants from the fresh mirror, then completes the activity. The mirror is the input to `generateDelegatedDataGrants`, not a UI cache. | The mirror is the **only** source for peer-side registry data once stores are split; freshness is eventually consistent and depends on webhook delivery. A delivery that never arrives, or a pair whose mirror was never written, is repaired only by the drift scan/backfill in [`pod-isolation-followup.md`](../../docs/plans/pod-isolation-followup.md) A1 — the reconcile sweep has no schedule yet. The mirror sync keeps a 5-attempt retry cap, so a permanently unreadable peer leaves the activity `pending` (documented in [`update-deployment.md`](../../docs/plans/update-deployment.md)). Unregister propagation (`deleteReciprocalMirror`) is implemented but still has no caller. |
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
  where *we* are the `grantedBy` are never mirrored: source grants live in our
  own registry and onward delegated grants live in the data owner's, where the
  data server resolves the `delegationOfGrant` chain locally.
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
- **Failure behaviour.** A mirror gap surfaces as `MirrorIncompleteError(<iri>,
  kind)` from delegated-grant generation instead of a generic framing error; the
  consumer retries, and the sync's 5-attempt retry cap bounds the retrying.

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
- Durable webhook delivery: `DurableWebhookEmitter` on registry/data, the `deliverWebhook` workflow and `postWebhook` activity on the `webhook-delivery` queue, at-least-once retries, and the direct-POST fallback when enqueueing fails.
- The owner-registry-pod grant lookup and the data-pod resource lookup in the
  permission engine.
- The admin-only `hasRegistrySet` link and the forward-only admin channel.

Open work remains tracked in
[`pod-isolation-followup.md`](../../docs/plans/pod-isolation-followup.md)
(mirror backfill/drift scan, unregister deletion, external admin-endpoint
discovery, cross-pod tests),
[`grant-replication-follow-ups.md`](../../docs/plans/grant-replication-follow-ups.md)
(test reorganisation, grantee-side read optimisations, terminal-error policy —
including the issuer-side replica that real grant reuse needs, recorded in
[`check-equivalence.md`](../../docs/plans/check-equivalence.md) §2.1), and
[`webhook-subscription-bootstrap.md`](../../docs/plans/webhook-subscription-bootstrap.md)
(real-deployment channel provisioning). The production cutover is in
[`update-deployment.md`](../../docs/plans/update-deployment.md).

## Related pages

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
