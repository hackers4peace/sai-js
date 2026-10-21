---
type: architecture
title: Deployment landscape
description: The h4p.net production landscape modeled in docs/architecture.c4 — reverse proxy, auth (SAI agent, Solid-OIDC provider, FedCM), registry set, data, webid, account UI, workers, and their quadstore/postgres/S3 storage backends, plus the current dev/test per-pod Fuseki and Garage divergence.
tags: [architecture, deployment, solid, c4, h4p]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T01:32:20.770Z
sources:
  - id: openwiki-source-b8a927b0cc8a1ee64f5a4f78
    resource: repo://docker-compose.yaml
  - id: openwiki-source-d0f68fe32d2ff3a73bba3cb6
    resource: repo://docs/architecture.c4
  - id: openwiki-source-833782312af20d943c4bd83d
    resource: repo://nix/podman.nix
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-55f67d07018be4b3c4161eb1
    resource: repo://packages/components/src/temporal/queues.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
  - id: openwiki-source-23ba2a7bbe5efb6e2d77954d
    resource: repo://packages/components/src/workers/main.ts
generated: { by: "pi", at: "2026-10-21T01:32:20.770Z" }
---

# Deployment landscape

`docs/architecture.c4` is a LikeC4 model of the production **h4p.net** landscape.
It is the architectural counterpart to the dynamic flow diagrams in
`docs/temporal.c4` (see [Sequence and discovery flows](../temporal/sequence-views.md)) and
the concrete NixOS/Podman deployment in
[Production deployment](../operations/deployment.md).

The model declares three element kinds (`system`, `container`, `component`) and a
single top-level system `h4p` that contains the containers and components.

## Containers and responsibilities

| Container | Address | Role |
| --- | --- | --- |
| `ReverseProxy` | — | Caddy edge that fronts every other container |
| `Auth` | `auth.h4p.net` | Solid-OIDC provider (CSS) plus the SAI agent and a FedCM IdP |
| `Temporal` | — | Temporal server backing the workflow machinery |
| `Quadstore` | — | Oxigraph RDF store (one shared store in the model and in `nix/podman.nix`) |
| `KVstore` | — | PostgreSQL key-value store |
| `Workers` | — | Temporal workers for push, webhook delivery, reciprocal registration, and grant workflows |
| `Registry` | `reg.h4p.net` | Registry Set (authorization/agent/role registries) with ACP policy engine |
| `WWW` | `www.h4p.net` | Public website |
| `Data` | `*.data.h4p.net` | Data Registries with SAI policy engine and S3 (Garage) object storage |
| `WebID` | `*.h4p.net` & `id.h4p.net` | WebID documents |
| `Account` | `app.h4p.net` | Account management UI (authorization screen, credential management, social graph, pod/webid management) |

## Model versus current storage

The C4 model and the production NixOS/Podman configuration still describe and
run a **single shared Oxigraph** (`nix/podman.nix` keeps the `oxigraph` and
`sparql` containers and exports `CSS_SPARQL_ENDPOINT=http://sparql/sparql` to
the CSS servers). The **dev/test** stack has diverged: Docker Compose and the
Dagger harness run **Fuseki** with one dataset per registry/data pod, and
**Garage** with one bucket and access key per data pod, resolved through the
`PodEndpointStore` rather than a shared endpoint. Production does not yet
follow that migration, so the model remains a fair picture of production while
understating the dev/test isolation model — see
[Per-pod storage and isolation](storage-isolation.md).

The Temporal dependency is no longer limited to auth, the worker, and WebID.
`nix/podman.nix` and the Compose stack now set `TEMPORAL_ADDRESS` on the
`registry` and `data` containers as well, because their CSS processes run the
durable webhook emitter. The shared-Oxigraph storage model described above is
unchanged by that addition.

## Components and decomposition

The `Auth` container decomposes into three components: the **Solid-OIDC Provider**
(Community Solid Server), the **SAI Agent** (`sai-js`), and a **FedCM IdP**
(`liquid.surf`). `Registry` decomposes into a **Registry Set** (Authorization
Registry, Agent Registry, Role Registry) plus an **ACP Policy Engine**, a
**SPARQL endpoint**, and a Solid client; `Data` mirrors this with a Data
Registry, **SAI Policy Engine**, SPARQL endpoint, S3 (Garage) client, and a
Solid client. `Workers` hosts the **Push notifications sender** and the
**Webhook sender**. The webhook sender has its own `webhook-delivery` queue; the
same worker process also registers the push, reciprocal-registration, and
grant queues.

## Relationships

The edge routes everything through `ReverseProxy`; it fronts `Auth`, `Registry`,
`WebID`, `Data`, `Account`, and `WWW`. On the service-to-service plane the
notable edges are:

- `Auth`, `Registry`, `Data`, and `WebID` each reach `Temporal`. Registry and
  data use it for durable webhook delivery as well as workflow dispatch;
  `Auth`/`Registry`/`Data`/`Temporal` use `KVstore`.
- The worker process registers four queues: `forward-to-push`,
  `reciprocal-registration`, `create-grants`, and `webhook-delivery`. The last
  one carries `deliverWebhook` and its `postWebhook` activity.
- `Auth` talks to `Data`, `WebID`, and `Registry`; `Registry` and `Data` and
  `WebID` read the `Quadstore`; `Data` uses `GarageStorage` (S3).
- `Account` depends on `Auth`; `WWW` depends on `Data` and `WebID`.

## Views

The model ships six LikeC4 views: a full `index` landscape plus scoped views for
`auth`, `data`, `registry`, `set` (the Registry Set), `workers`, and `account`.
The `account` view is the richest — it pulls in `Data`, `WebID`, and `Auth` and
explicitly excludes the `Data -> WebID` edge while including `Auth -> Registry`.

> The LikeC4 authoring conventions for the dynamic views (note callouts, include ordering) are documented in [Sequence and discovery flows](../temporal/sequence-views.md); `docs/architecture.c4` follows the same LikeC4 project scope.
