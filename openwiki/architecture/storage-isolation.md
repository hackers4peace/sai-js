---
type: architecture
title: Per-pod storage and isolation
description: How dev/test storage is isolated per pod — one Fuseki dataset per registry/data pod, one Garage bucket and key per data pod, the typed PodEndpointStore records, the routed SPARQL/S3 and hybrid accessors, session/context endpoint allowlists, permission-engine endpoint resolution, reciprocal mirrors, and the account-bootstrap workflow.
tags: [architecture, storage, fuseki, garage, sparql, s3, isolation]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-18T21:45:34.463Z
sources:
  - id: openwiki-source-6de19f62f4df5fc517fa9ac5
    resource: repo://packages/components/src/HybridDataAccessor.ts
  - id: openwiki-source-704738f33fe7e379043e2233
    resource: repo://packages/components/src/PodEndpointStore.ts
  - id: openwiki-source-10a90e52cdd29dd645417bdb
    resource: repo://packages/components/src/RoutedS3DataAccessor.ts
  - id: openwiki-source-710b47f92bbb944fa6fc3488
    resource: repo://packages/components/src/RoutedSparqlDataAccessor.ts
  - id: openwiki-source-0e27aa8e897f26683c4de317
    resource: repo://packages/components/src/SaiAuthorizationManager.ts
  - id: openwiki-source-9cd6e2280365d84a6828353d
    resource: repo://packages/components/src/SaiPermissionsEngine.ts
  - id: openwiki-source-3e8f48f62968e08a27cd3572
    resource: repo://packages/components/src/services/Account.ts
  - id: openwiki-source-452244fad48fe4fdb39195dd
    resource: repo://packages/components/src/services/Context.ts
  - id: openwiki-source-ce3937bfbcfbea447784ab6a
    resource: repo://packages/components/src/SessionManager.ts
  - id: openwiki-source-b3f53b3cc2943909883f8582
    resource: repo://packages/components/src/temporal/activities/account.ts
  - id: openwiki-source-4dbb1c79cd1a93efa0f3bf2d
    resource: repo://packages/components/src/temporal/workflows/account.ts
  - id: openwiki-source-23ba2a7bbe5efb6e2d77954d
    resource: repo://packages/components/src/workers/main.ts
generated: { by: "pi", at: "2026-10-18T21:45:34.463Z" }
---

# Per-pod storage and isolation

The dev/test cluster no longer points every service at one shared quadstore.
The **isolation unit is the pod**: each registry pod (a registry set) and each
data pod (a data storage) gets its own Fuseki dataset, and each data pod gets
its own Garage bucket and access key. The production NixOS/Podman config has not
followed this migration and still runs a single Oxigraph — see
[Deployment landscape](deployment-landscape.md).

Two consequences shape the whole codebase:

- The **owner's grants** live in the owner's **registry-pod** dataset, not in a
  data pod's dataset. A resource's own graph and its authorizations are in
  different datasets.
- Because no peer's dataset is reachable from a local session, peer-side
  registry data is read through a **reciprocal mirror** written into the owner's
  own dataset (see [Social graph](social-graph.md)).

## The endpoint registry (`PodEndpointStore`)

`packages/components/src/PodEndpointStore.ts` stores the internal endpoints in
the CSS `AccountLoginStorage` (Postgres) as two **typed** record kinds:

| Type | Keyed by | Fields |
| --- | --- | --- |
| `sparqlEndpoint` | `podUrl` | `accountId`, `endpoint` |
| `objectEndpoint` (data pods only) | `podUrl` | `accountId`, `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey` |

The pod is the direct subject (`podUrl`); the owning user is reached
**indirectly** through `accountId` (the reverse `webIdLink` lookup). The store
exposes `createSparql`/`createObject`,
`findSparqlByPodUrl`/`findObjectByPodUrl`,
`findSparqlByAccountId`/`findObjectByAccountId`,
`findSparqlByWebId`/`findObjectByWebId` (resolve the account first), and
`findSparqlByIri`/`findObjectByIri` (longest pod-URL prefix). Both types are
defined and indexed on startup by the store's `handle()`.

`config/storage/pod-endpoints.json` wires the store on the registry and data
servers; `config/storage/account.json` defines it (with `webIdStore`) on the
auth server and appends it to the primary and early-process initializers.
`config/storage/hybrid.json` and `config/storage/routed-sparql.json` replace
CSS's single-endpoint accessor with the routed/hybrid ones.

**There is no shared or default endpoint.** An identifier that belongs to no
pod, or a pod with no record, fails closed — a storage outage or a missing
record can never silently widen the scope.

## LDP read/write routing

The data server's backend accessor is a `HybridDataAccessor`
(`packages/components/src/HybridDataAccessor.ts`) that picks a plane by
content:

- **binary** documents (no conversion to `internal/quads`) go to
  `RoutedS3DataAccessor`, with metadata written separately to the SPARQL plane;
- **quads**, metadata, children, and containers go to
  `RoutedSparqlDataAccessor`;
- `deleteResource` attempts both planes and tolerates not-found in either.

Both routed accessors resolve the pod the same way:
`StorageLocationStrategy.getStorageIdentifier(identifier)` yields the pod base
URL (a subdomain pod root on the data server, the first container on the
path-based registry server), which is the registry key.

- `RoutedSparqlDataAccessor` (`packages/components/src/RoutedSparqlDataAccessor.ts`)
  calls `findSparqlByPodUrl` and caches one `SparqlDataAccessor` per endpoint.
  A non-pod identifier raises `NotFoundHttpError` (so ACP ancestor `.acr` reads
  treat the server root as "no ACR"); a pod without a record throws.
- `RoutedS3DataAccessor` (`packages/components/src/RoutedS3DataAccessor.ts`)
  calls `findObjectByPodUrl` and caches one `S3DataAccessor` per
  `endpoint/bucket`. `S3DataAccessor` appends the bucket to the bucket-less
  endpoint (`s3mini` derives the bucket from the URL path) and only supports
  binary get/write/delete.

The data server combines this with `static-root` initialization and the
subdomain identifier strategy. Because a pod root is then `/` on a subdomain,
CSS's path-only `StaticAssetHandler` would shadow every pod root with the
landing page; `RootStaticAssetGuard` (`packages/components/src/RootStaticAssetGuard.ts`,
wired in `config/overrides/base-http-handler.json`) refuses only the exact root
path on a base-host subdomain and lets the LDP handler serve it.

## Session and context allowlists

`SessionManager` (`packages/components/src/SessionManager.ts`) builds an
owner-scoped endpoint allowlist when it mints a session: it resolves the
records for the webId via `findSparqlByWebId`, builds a `podUrl -> endpoint`
map, and passes it to `AuthorizationAgent.build(...)` as `sparqlEndpoints`.
The registry-pod endpoint is required — a session without it throws
(`no registry-pod SPARQL endpoint for ...`) rather than falling back. In the
worker and test harness (`buildSessionManager()`), the manager lazily builds a
shared `PodEndpointStore` from Postgres; only an unavailable Postgres is
tolerated.

`AuthorizationAgent` (`packages/authorization-agent/src/authorization-agent.ts`)
keeps that map and exposes `resolveEndpoint(iri)` (longest pod-URL prefix) and
`sparqlTransportFor(iri)`, which throws when the resource is not under one of
the owner's pods. Data-plane reads thus cannot escape the owner's pods.

`services/Context.ts` puts the map on `ResolvedContext.endpoints`: the personal
context reuses `session.sparqlEndpoints`; the org context reads the **org's**
records from the endpoint store (`findSparqlByWebId(orgWebId)`), so an admin
never gets a wider set than the context's own pods.

## Permission-engine endpoint resolution

The policy engine is split across two datasets:

- `SaiPermissionsEngine` (`packages/components/src/SaiPermissionsEngine.ts`)
  resolves the **resource's data-pod** endpoint (`resolvePodEndpoint` via
  `getStorageIdentifier` + `findSparqlByPodUrl`) to read the resource graph
  (for example the shape-tree `viaPredicate` children) and returns no result
  when the resource is not under a pod.
- `SaiAuthorizationManager` (`packages/components/src/SaiAuthorizationManager.ts`)
  looks up the **grants**, which live in the storage owner's registry pod: it
  finds the pod by base URL (`podStore.findByBaseUrl`), reads its owner webId
  (`podStore.getOwners`), derives `registryId(owner)`, and resolves that
  registry-pod endpoint. No pod, no owner, or no record means "no grants"
  (deny); a store outage propagates (fail closed).

`config/policy/engine.json` injects `podStore` and `endpointStore` into the
manager; `config/ldp/authorization/sai.json` injects `storageStrategy` and
`endpointStore` into the engine.

## Reciprocal mirrors

`services/ReciprocalMirror.ts` maintains read-only local copies of peer
registry data. `updateReciprocalMirror` fetches the peer's reciprocal
registration and its linked grants as JSON-LD, then writes them as named graphs
into the owner's registry-pod dataset in one atomic SPARQL update (drop + insert
`GRAPH` blocks). `syncReciprocalMirror` / `deleteReciprocalMirror`
(`temporal/activities/reciprocal.ts`) use the owner session's registry-pod
endpoint (`session.sparqlEndpoint`) as the target. The mirror is what makes
cross-pod peer grants visible at all; it is required before the store split is
usable.

## Account-bootstrap provisioning

New accounts provision their storage through a Temporal workflow rather than a
synchronous request:

1. `AccountService.startBootstrapAccount`
   (`packages/components/src/services/Account.ts`) derives the account's IRIs
   (`webId`, client-id document, authorization agent, issuance URL, registry
   set, data registry), builds `BootstrapAccountInput`, and starts
   `bootstrapAccount` with the stable `workflowId = account-bootstrap:<accountId>`
   (a duplicate RPC reuses the in-flight/previous execution). It returns the
   WebID immediately; account creation completes asynchronously.
2. The `bootstrapAccount` workflow
   (`packages/components/src/temporal/workflows/account.ts`) runs five
   activities in order, each find-first so retries are safe:
   - `createFusekiDatasets` — ensures the registry, data, and shared `id`
     datasets exist (Fuseki admin API, "already exists" tolerated);
   - `createObjectBucket` — reuses an existing `objectEndpoint` record, else
     find-firsts/recreates the Garage bucket and a key scoped `read`/`write`/
     `owner` (a key secret is readable only at creation, so retries mint a
     fresh key; a failed attempt compensates by deleting the key and any bucket
     it created);
   - `writeEndpointRecords` — writes the registry and data `sparqlEndpoint`
     records plus the data `objectEndpoint` record;
   - `postBootstrapTriG` — GSP-POSTs the WebID profile to the `id` dataset, the
     registry set to the registry dataset, and the data registry to the data
     dataset;
   - `writeAccountRecords` — writes the Postgres account/pod/owner/webId-link
     records and their indexes, keyed off the account's existing `**webIdLink**`.
3. All five run on the `create-grants` task queue; the worker
   (`packages/components/src/workers/main.ts`) registers the account activities
   there alongside grants/admin/invitation/access-request activities.

Environment-specific endpoints are read from the worker's process env:
`CSS_FUSEKI_BASE_URL` + `CSS_FUSEKI_ADMIN`, `CSS_GARAGE_ADMIN_ENDPOINT` +
`CSS_GARAGE_ADMIN_TOKEN`, `CSS_S3_ENDPOINT`, and
`CSS_POSTGRES_CONNECTION_STRING`. The Garage admin token stays on the worker;
the data server only consumes the credentials in the `objectEndpoint` record.
`GarageAdminClient` (`packages/components/src/GarageAdminClient.ts`) wraps the
Garage v2 admin API (`CreateBucket`, `CreateKey`, `AllowBucketKey`, find-first
`ListBuckets`/`ListKeys`, compensating deletes).

The dev/test environment pre-declares the fixture pods in
`environments/css/fuseki.config.ttl` and splits the fixture seed per pod; see
[Local development environment](../operations/development.md) and
[Integration test suite](../testing/integration-tests.md).
