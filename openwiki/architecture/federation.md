---
type: architecture
title: Federation constraints
description: The single-deployment shortcuts the SAI implementation still relies on — per-pod storage, peer discovery, local pod ownership, the org registry-set link, and one notification path — the federated ID-JAG issuer resolution through subject CID documents, the reciprocal mirror and admin impersonation that have landed, and what must keep working when servers split.
tags: [architecture, federation, storage, discovery, org-context, webhooks, mirror, id-jag]
sources:
  - id: openwiki-source-0531e8ebff475ca0a556fc29
    resource: repo://packages/authorization-agent/src/grant-generation.ts
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-0b475136796d3c6391256850
    resource: repo://packages/components/config/overrides/emitter.json
  - id: openwiki-source-90c157df451973113a63b968
    resource: repo://packages/components/src/AdminImpersonationAuthority.ts
  - id: openwiki-source-d5b18f1bbc300c60de0dee27
    resource: repo://packages/components/src/CidIssuerResolver.ts
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-95310ca3c4786b5a5c369581
    resource: repo://packages/components/src/IdJagSubjectTokenVerifier.ts
  - id: openwiki-source-759ab06bf1f6a0b228effe16
    resource: repo://packages/components/src/IdJagTokenHandler.ts
  - id: openwiki-source-09198068dc92d7c890b3e305
    resource: repo://packages/components/src/services/peerData.ts
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
  - id: openwiki-source-04f6a81cd8f58552c8dfc86f
    resource: repo://services/id/cid.ts
generated: { by: "pi", at: "2026-11-19T23:03:01.178Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T23:03:01.178Z
---

# Federation constraints

The org-admin data plane is the first feature that **crosses servers**: an admin
of an org operates on the org's registries (possibly on a different server than
the admin's), and admin grants on data registries are consumed by the
permission engine on the data server. This page records the remaining
shortcuts, their current status, and the cases that must keep working when real
federation lands.

## Shortcuts and current status

| # | Shortcut | Today | What breaks when servers/stores split |
| --- | --- | --- | --- |
| 1 | One shared SPARQL store | Dev/test and the NixOS/Podman stack use one Fuseki dataset per registry/data pod plus a dedicated `id` dataset, resolved through `PodEndpointStore` with **no default fallback**. The C4 model still says Oxigraph; see [Deployment landscape](deployment-landscape.md) and [Per-pod storage and isolation](storage-isolation.md). | The old cross-graph grant query (`GRAPH ?g {?s interop:hasStorage <storage>}` over every graph) no longer sees other owners' grants. The per-pod replacement is two lookups: the resource's data-pod dataset for the resource graph (`SaiPermissionsEngine`), and the storage owner's registry-pod dataset for grants (`SaiAuthorizationManager` via `podStore.getOwners` → `registryId(owner)`). |
| 1a | Reciprocal mirrors | `updateReciprocalMirror` writes the peer's reciprocal registration and the grants it links into the context's own registry-pod dataset. The mirror is **seeded on both invitation legs** — `establishReciprocal` (inviter) and `acceptInvitation` (acceptor) — before their activity completes, and afterwards refreshed **only** by the per-peer delegated-grants consumer (`processDelegatedGrantsUpdated`, workflow id `delegated-grants:<webId>:<peerId>`): each drain runs the `syncReciprocalMirror` child workflow on `reciprocal-registration`, then regenerates the delegated grants from the fresh mirror, then completes the activity. The mirror is the input to delegated-grant generation, not a UI cache. | The mirror is the **only** source for grants the peer issued to us once stores are split; freshness is eventually consistent and depends on webhook delivery. A delivery that never arrives, or a pair whose mirror was never written, is repaired by the reconciliation sweep's local completeness arm (see [Authorization revocation and grant projections](authorization-revocation.md)); the cutover backfill and drift scan are **not implemented** (issue #108). A `404`/`410` on the peer's registration is terminal (the replica is dropped and the activity completes without regenerating); every other failure keeps retrying, and after the 5-attempt cap a permanently unreadable peer leaves the activity `pending` (issue #112). Unregister propagation (`deleteReciprocalMirror`) is implemented but still has no caller. |
| 2 | Discovery uses the global `fetch` | `SaiPermissionsEngine` and the peer-data layer call `discoverAuthorizationAgent(agent, fetch)` / `fetchJsonLd` with the global fetch; storage-description discovery does the same. ID-JAG verification is the exception: `CidIssuerResolver` takes an injectable fetch and dereferences the subject CID document plus the issuer's key metadata itself. | Peers' WebID profiles, CID documents, issuer metadata, and storage descriptions must be reachable and DNS-resolvable. A federated grant fails closed when its subject document or JWKS cannot be read. |
| 2a | ID-JAG issuer trust spans servers | A verifier accepts an issuer from `trustedIssuers` or, for a federated `iss`, from the subject's controlled identifier document (`lws:OpenIdProvider` service endpoint equal to `iss`). | The issuing UAS must publish a CID document for the subject (`services/id` derives `lws:OpenIdProvider` from `solid:oidcIssuer`) and a discoverable JWKS; otherwise the grant is rejected. |
| 3 | Pod/storage ownership is local | The storage exchange policy and the `?pod=` gate decide "owner of this storage" via the local `podStore.getOwners` / endpoint records. | A data server must mirror remote org ownership or resolve it on the wire (e.g. via the org's agent-id document / registry set). |
| 4 | The org's Authorization Agent serves the registry-set link | The org's AA may live on a different server than the admin's; it serves the org's agent-id document and the admin-only `Link: <registrySet>; rel="interop:hasRegistrySet"` header, and runs the org's Activity Registry workflows. The admin's AA performs the UI interactions. | This is the **intended** federation shape for the registry plane: the header carries the authoritative RegistrySet IRI across servers. |
| 5 | One notification path | The org's Activity Registry webhook reaches `ActivityWebhookHandler`; admin channels are forward-only (keyed by the admin's webId), so org-context events reach the admin's own stream without dispatching workflows. Registry and data webhook delivery is durable through `DurableWebhookEmitter` and the `webhook-delivery` Temporal queue. | Cross-server webhook delivery is durable; **channel provisioning is not implemented** for real deployments (issue #113). Without it, a fresh account has no handler subscription and the sweep is the only dispatcher. |

## The reciprocal mirror, in detail

The mirror is a server-side, read-only copy of peer registry data, written by
`updateReciprocalMirror` with the context's own session and read strictly as a
replica by everything else ([`ReciprocalMirror.ts`](../../packages/components/src/services/ReciprocalMirror.ts)).

- **Contents.** For every social-agent registration carrying a
  `reciprocalRegistration` link: the peer's registration *of us* (the grantee
  side) and every grant that registration links via `interop:hasDataGrant` —
  parents and inheriting children alike, since the grantor links both. Grants
  where *we* are the `grantedBy` are not part of this mirror: those are issued
  by us and live in our own grant registry.
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
  `MirrorIncompleteError(<iri>, kind)` from delegated-grant generation instead
  of a generic framing error
  ([`reciprocal.ts`](../../packages/components/src/temporal/activities/reciprocal.ts),
  [`grant-generation.ts`](../../packages/authorization-agent/src/grant-generation.ts)).
- **Grantee-side reads are batched.** Consent and browsing views
  (`getDescriptions` data owners, `DataRegistry` grant index + instance listing,
  the social-agent list's `adminOf` and data-owner rows, the org-admin gate) read
  the replica through `getReciprocalGrants` (link set + all bodies in two
  queries), `getRegistrationLinks` and `getLinkedGrantOwners` (one query each)
  instead of framing a registration and every linked grant per peer.

## Delegated grants in the current model

Delegated grants are projections of the issuing agent's `DataAuthorization`s,
so they are stored in **that agent's own grant registry**; the receiving peer
mirrors them as part of its own peer data. There is no issuer-side grant replica
and no peer-owned grant deletion: reconciliation computes the local closure and
deletes it with the owner session ([`grants.ts`](../../packages/components/src/temporal/workflows/grants.ts)).
The mirror is still the **source** for grants a peer issued to us; that is the
one cross-server direction the mirror exists for.

## Federated ID-JAG issuer resolution

An incoming ID-JAG may be minted by a UAS other than this deployment. The
verifier resolves that trust on the wire, per grant, without a static peer list
([`CidIssuerResolver.ts`](../../packages/components/src/CidIssuerResolver.ts),
[`IdJagSubjectTokenVerifier.ts`](../../packages/components/src/IdJagSubjectTokenVerifier.ts)):

1. If `trimTrailingSlashes(iss)` is in `trustedIssuers`, the issuer is local:
   no subject document is fetched. This is the `.sai` interaction case too, where
   `aud` is a full request URL and therefore differs from `iss`.
2. Otherwise the verifier dereferences `sub` with
   `Accept: application/ld+json, application/json;q=0.9, text/turtle;q=0.8, application/cid`.
   A non-200 response is a rejection, not a retry.
3. The document `id` must equal `sub`. A compact `application/cid`/plain-JSON
   document is read directly (`service[]` with `type`/`serviceEndpoint`); JSON-LD
   and Turtle go through the `RepresentationConverter`.
4. A service with type `https://www.w3.org/ns/lws#OpenIdProvider` must exist and
   its `serviceEndpoint` (CID `cid:serviceEndpoint` or DID
   `did:serviceEndpoint`) must equal `iss` after trailing-slash normalization.
   There is no `solid:oidcIssuer` fallback and no WebID/Solid-OIDC path.
5. The issuer's key set comes from OIDC discovery
   (`/.well-known/openid-configuration`, which must name the same `issuer` and a
   `jwks_uri`) with the LWS metadata (`/.well-known/lws-configuration`) as
   fallback; the remote JWKS is cached per issuer.

Every failure (unreachable document, wrong `id`, no `lws:OpenIdProvider`
service, endpoint mismatch, missing JWKS) is a `400` rejection of the grant.
The giving side of this contract is the `services/id` CID derivation: a WebID
profile's `solid:oidcIssuer` becomes a `did:service` of type
`lws:OpenIdProvider` whose endpoint is that issuer
([`services/id/cid.ts`](../../services/id/cid.ts)).

`.sai` audiences follow the same split. `IdJagTokenHandler` accepts, as a
minting audience, a known storage/authorization-server base URL, the UAS itself,
any `.sai` URL under this UAS, or a `.sai` URL whose origin is in
`authorizationServerOrigins` (configured peer UASs). Any other `.sai` URL is an
`invalid_target`.

## Admin peer reads

Admin reads of peer-granted data no longer use a document proxy. The org's
exchange is the decision point: `AdminImpersonationAuthority` mints a
read-only ID-JAG as the org, and `ctx.storageFetch` /
`SessionManager.impersonationFetch` perform the read server-side with no
arbitrary-IRI endpoint ([`peerData.ts`](../../packages/components/src/services/peerData.ts)).
The peer sees the org as subject; hidden actors never appear in the final token.
The `/sparql-admin` registry-plane endpoint remains a separate admin-gated
transport.

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

- The per-pod store split (Fuseki datasets, `PodEndpointStore`, routed
  accessors, session/context allowlists) — see
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
- Delegated grants stored in the assigner's own registry, with local
  `revokeGrantClosure` GC and registration PATCH last — see
  [Authorization revocation and grant projections](authorization-revocation.md).
- Durable webhook delivery: `DurableWebhookEmitter` on registry/data, the
  `deliverWebhook` workflow and `postWebhook` activity on the
  `webhook-delivery` queue, at-least-once retries, and the direct-POST fallback
  when enqueueing fails.
- The owner-registry-pod grant lookup and the data-pod resource lookup in the
  permission engine.
- Read-only admin impersonation for peer data; the old proxy/document endpoints
  are removed.
- The admin-only `hasRegistrySet` link and the forward-only admin channel.

## Open work

- Mirror drift scan/backfill and unregister deletion — issue #108.
- Stranded `AuthorizationRevoked` end-state and role-grantee healing — issues
  #110 and #111.
- Real-deployment webhook channel bootstrap/healing — issue #113.
- Production data migration, hardening/smoke tests, and schedules — issues
  #109, #114, and #112.
- Cross-pod/mirror-lifecycle tests — issue #131.

## Related pages

- [Authorization revocation and grant projections](authorization-revocation.md)
  — the projection GC, chain closure, and sweep backstop.
- [Grant equivalence and reuse](grant-reuse.md) — the tree comparison and the
  value-based regeneration result.
- [Per-pod storage and isolation](storage-isolation.md) — the store split and
  endpoint allowlists.
- [Deployment landscape](deployment-landscape.md) — the Fuseki/Garage topology
  and the stale C4 model.
- [Org-context data plane](../services/org-context.md) — the admin read plane
  and its gates.
- [Social graph](social-graph.md) — reciprocal webhooks and the org↔admin edges.
- [Activity outbox and events pipeline](../services/activity-lifecycle.md) — how
  a peer update reaches the consumer, and what `done` guarantees.
