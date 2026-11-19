---
type: architecture
title: Org-context data plane
description: How an admin reads an organization's registries and peers' granted data — the context-selected SPARQL transport, the /sparql-admin HTTP-QUERY endpoint with its pod ownership gate, read-only admin impersonation for peer reads, and the ACP non-cascade constraint.
tags: [org-context, sparql, admin, impersonation, architecture]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-90c157df451973113a63b968
    resource: repo://packages/components/src/AdminImpersonationAuthority.ts
  - id: openwiki-source-77182bdd0f02f880bb397ec8
    resource: repo://packages/components/src/AdminSparqlHandler.ts
  - id: openwiki-source-d1409b74f54faf54952386b2
    resource: repo://packages/components/src/services/adminGate.ts
  - id: openwiki-source-09198068dc92d7c890b3e305
    resource: repo://packages/components/src/services/peerData.ts
  - id: openwiki-source-d5d71ad8cddece4a004d0065
    resource: repo://packages/components/src/services/queries/org.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# Org-context data plane

When a signed-in admin operates in an organization's context, the service layer
reads the org's registries and the peers' granted data through the org context,
not the admin's personal store. This page documents that data plane; the
context-resolution rules are in
[RPC contract and service layer](rpc-and-services.md).

## SPARQL read plane

The read plane follows one principle: **the same registry query runs against
whichever endpoint the context requires** — only the endpoint differs, never the
query or mapping. The transport and query core lives in
`packages/authorization-agent/src/sparql.ts`:

- `SparqlTransport` is a two-op interface — `fetchBindings` (SELECT) and
  `fetchTriples` (CONSTRUCT). Query functions take a transport and never mention
  an endpoint.
- `localSparqlTransport(endpoint)` is the internal endpoint via
  `SparqlEndpointFetcher` (personal context and the AA's own session reads).
- `adminSparqlTransport(session, orgWebId, podUrl?)` issues HTTP `QUERY`
  (`application/sparql-query`) to `/.sai/sparql-admin/<base64url-org>`
  authenticated as the admin, adding `?pod=<podUrl>` when the query targets a
  specific pod; it lives in
  `packages/components/src/services/queries/org.ts`.
- `sparqlTransportFor(ctx)` dispatches **registry-plane** reads: personal →
  `localSparqlTransport(ctx.session.sparqlEndpoint)`, org →
  `adminSparqlTransport`.
- `sparqlTransportForPod(ctx, podUrl)` dispatches **data-plane** reads: personal
  → `ctx.session.sparqlTransportFor(podUrl)` (restricted to the session's
  allowlist), org → `adminSparqlTransport(..., podUrl)` (the handler verifies
  the pod belongs to the org).

Queries are IRI-parametrized (keyed by resource/graph IRI, never by
`session.webId`), so they resolve unchanged to mirror graphs at the per-owner
store split. **Writes stay REST/LDP** (the enforcement path); only registry-set
reads use SPARQL. Data-instance content, WebID/client-id profiles, shape-tree
descriptions, and storage descriptions stay HTTP. The personal context uses the
same query functions against its own pod endpoints; the endpoint allowlist is in
[Per-pod storage and isolation](../architecture/storage-isolation.md).

## Admin-gated endpoints

- **`/.sai/sparql-admin`** (`AdminSparqlHandler`) accepts `QUERY` only — any
  other method is rejected with `MethodNotAllowedHttpError(['QUERY'])` — and
  calls `requireOrgAdmin` ([`AdminSparqlHandler.ts`](../../packages/components/src/AdminSparqlHandler.ts)).
  Without `?pod` it forwards to the org's **registry-pod** endpoint resolved
  from the store; with `?pod=<podUrl>` it forwards to that pod only when the
  endpoint record's `accountId` matches the org's account
  (`ForbiddenHttpError` otherwise), so an admin cannot read another owner's
  dataset. SELECT returns `application/sparql-results+json`;
  CONSTRUCT/DESCRIBE returns `application/ld+json` (converted from triples with
  `jsonld.fromRDF`).
- **`requireOrgAdmin`** (`services/adminGate.ts`) returns 403 unless the org's
  registration of the caller carries a non-empty `hasAdminGrant`; an unknown
  org is indistinguishable from a non-admin.
- **`/.sai/proxy-admin`** and its `ProxyAdminHandler`/`peerFetch`/`peerProxy`
  clients are **removed**. There is no arbitrary-IRI admin document endpoint.

## Peer data reads

Peer-granted data is read server-side through the context's storage fetch, not a
proxy:

- Personal context: the user's own LWS fetch, which holds the grants.
- Org context: `ctx.storageFetch` either presents the admin's own credential
  (`scope: admin`, read-only) for the **org's own** pods, or performs read-only
  org impersonation for a peer storage. The org's exchange derives a claim from
  the org's DataRegistry `AdminGrant` and narrows it to `odrl:read`; the peer
  sees the **org** as subject
  ([`AdminImpersonationAuthority.ts`](../../packages/components/src/AdminImpersonationAuthority.ts),
  [`services/peerData.ts`](../../packages/components/src/services/peerData.ts)).

`fetchPeerDocument` uses `fetchJsonLd` through that storage fetch and wraps
failures in `PeerProxyError` with the upstream status. `dataRegistrationContains`,
`peerInstanceNode`, and `peerInstanceIris` route org-context reads through it.
Storage isolation keeps a peer pod out of the context's endpoint allowlist, so
the peer's own containment (`lws:partOf` metadata) is resolved from the
registrations the context's grants name.

## Known limitation: ACP does not cascade

CSS ACP does **not** cascade: `acp:memberAccessControl` applies only to
resources without their own `.acr`, so a per-resource ACR can hide a resource
from the org session. Mutating or deleting pre-existing **seeded** resources in
the org context therefore does not work through the org session; per-resource
ACR rewrites such as `syncAdminAcr` are the intended fix.

## Tests

- `test/org-context.test.ts` — context discovery, admin gate, org own/peer data
  reads, `/sparql-admin` `?pod` behavior, and admin actions.
- `packages/components/test/admin-sparql-endpoint.test.ts` — the endpoint
  resolution and 403 ownership gate.
- `packages/components/test/admin-impersonation.test.ts` — the impersonation
  authority and claim narrowing.
- `packages/components/test/peer-data.test.ts` — peer document and instance
  reads.

## Related pages

- [Organization admin model](../architecture/org-admin.md)
- [ID-JAG access claims and impersonation](../architecture/id-jag-access-claims.md)
- [Federation constraints](../architecture/federation.md)
- [RPC contract and service layer](rpc-and-services.md)
