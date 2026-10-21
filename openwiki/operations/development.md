---
type: operations
title: Local development environment
description: The Docker Compose dev stack (auth, registry, data, worker, ui, vuejectron, router, dns, temporal, fuseki, garage, tempo, grafana), wildcard *.docker DNS via dnsmasq, mkcert TLS, Node 26, and the per-pod devbox seed workflow.
tags: [operations, docker, development, dns, mkcert, devbox]
sources:
  - id: openwiki-source-a8a954b9de2bc6c0b4ca5044
    resource: repo://.dagger/src/index.ts
  - id: openwiki-source-4835a4ac60ade4980988746a
    resource: repo://.env
  - id: openwiki-source-09746815d483fcef938cf59c
    resource: repo://devbox.json
  - id: openwiki-source-b8a927b0cc8a1ee64f5a4f78
    resource: repo://docker-compose.yaml
  - id: openwiki-source-35d51428d97e66241738b5cf
    resource: repo://environments/css/fuseki.config.ttl
  - id: openwiki-source-012f2c78e3b1446dfc35803f
    resource: repo://Makefile
  - id: openwiki-source-ccdcdbc048f49246514e9069
    resource: repo://mkcert.sh
  - id: openwiki-source-55f67d07018be4b3c4161eb1
    resource: repo://packages/components/src/temporal/queues.ts
  - id: openwiki-source-23ba2a7bbe5efb6e2d77954d
    resource: repo://packages/components/src/workers/main.ts
  - id: openwiki-source-8dce2ce795a3d6ab234dc34d
    resource: repo://packages/repl/cmd.ts
generated: { by: "pi", at: "2026-10-21T01:32:20.770Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T17:33:35.590Z
---

# Local development environment

The local loop is a Docker Compose stack whose service definitions and shared
environment anchors live in `docker-compose.yaml`. `make up` starts it, and a
devbox `seed` script loads the seed data.

## Services

The Compose stack runs the full cluster:

- **Solid/OIDC and SAI**: `auth`, `registry`, `data` (three Community Solid
  Server instances), plus `worker` (the Temporal worker) and `ui` (the
  authorization console); `vuejectron` runs the demo application. Auth,
  registry, data, and worker all receive `TEMPORAL_ADDRESS`; registry and data
  need it because their CSS processes run the durable webhook emitter.
- **Routing and DNS**: `router` (Traefik) and `dns` (dnsmasq).
- **Infrastructure**: `postgresql`, `temporal` (plus the one-shot admin-tools
  and create-namespace jobs and `temporal-ui`), `fuseki` (per-pod datasets),
  `id`, and `garage` (per-data-pod S3 buckets). The worker process registers
  four queues: push, reciprocal registration, grants, and the dedicated
  `webhook-delivery` queue.
- **Observability**: `tempo` and `grafana`.

Fuseki replaces the former Oxigraph + nginx pair: it exposes the admin API on
`:3030` (deterministic `admin:sai`), and `environments/css/fuseki.config.ttl`
pre-declares the fixture datasets (`id`, `reg-<handle>`, `data-<pod>`). The
auth server gets `CSS_FUSEKI_BASE_URL`/`CSS_FUSEKI_ADMIN` so new signups can
create datasets. The `worker` is the only service with the Garage admin
credentials (`CSS_GARAGE_ADMIN_ENDPOINT`, `CSS_GARAGE_ADMIN_TOKEN`) and the
bucket-less `CSS_S3_ENDPOINT`; the `data` server only gets `CSS_S3_REGION` and
resolves each pod's bucket and credentials from its `objectEndpoint` record
(see [Per-pod storage and isolation](../architecture/storage-isolation.md)).

A `networks.sai` network with subnet `172.16.0.0/16` connects the services, and
Traefik's Docker provider routes by hostname from static certs under
`traefik/certs`.

## Wildcard DNS and TLS

dnsmasq maps every `*.docker` name to the Traefik container IP
`172.16.0.250` (`.env` `DMQ_GLOBAL=address=/docker/172.16.0.250`), and app
containers point their resolver at `172.16.0.253`. `mkcert.sh` reads
`TLS_DOMAINS` and generates a wildcard certificate into
`traefik/certs/cert.pem` via `make cert-install`, so `https://auth.docker`,
`https://*.data.docker`, `https://ui.auth.docker`, and friends work locally.
macOS users add bridge routes with `docker-mac-routes-add.sh`.

## Build, run, seed

- `make up` = `docker compose up --remove-orphans -d --wait`; `make up-router`
  and `make up-dns` start just those subsets.
- Node 26 is required (README, `devbox.json`, and the Nix images pin it); npm 11
  is the package manager (`packageManager` in the root `package.json`).
- Seeding is a devbox script, not a Make target:
  `node packages/repl/cmd.ts -- seed-env` (`devbox run seed`). It maps the seed
  IRIs for the chosen environment, **splits `environments/data/registry.trig`
  per pod** with `splitFixtureByPod`, provisions one Garage bucket + key per
  data pod through the admin API (`seedObjectEndpoints`), writes the resulting
  `objectEndpoint`/`sparqlEndpoint` records plus the rest of the KV fixture to
  Postgres, and loads each dataset into Fuseki (`seedFusekiDataset`).

The Dagger test harness binds the `registry` and `data` services to Temporal
and runs a Temporal-reachability wait before vitest. That gate prevents the
durable webhook emitter from paying the Temporal connect timeout on the first
webhook in a test run.

The dev URL→IRI mapping is in `environments/dev/map.json`; the production
equivalent is the NixOS/Podman deployment documented in
[Production deployment](../operations/deployment.md).
