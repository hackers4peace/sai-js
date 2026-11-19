---
type: operations
title: Production deployment and observability
description: The NixOS/Podman VPS deployment (nixos-anywhere, flake hosts, ragenix-encrypted secrets, Caddy reverse proxy) and the OpenTelemetry env contract, mechanics, and Tempo/Grafana observability path for sai-js.
tags: [operations, nixos, podman, caddy, ragenix, opentelemetry, tempo]
sources:
  - id: openwiki-source-02b9d7214f2fe7cbd68d0d5c
    resource: repo://.github/workflows/oci.yml
  - id: openwiki-source-4c86ae0c485703b6191347bc
    resource: repo://environments/dev/tempo/tempo.yaml
  - id: openwiki-source-3eda5d2b85501c78fc0ba02d
    resource: repo://flake.nix
  - id: openwiki-source-aec65e72753159f364299ec7
    resource: repo://nix/caddy.nix
  - id: openwiki-source-b5b7c7b18f157aa016a62301
    resource: repo://nix/h4p.nix
  - id: openwiki-source-4a0a78bc752d0516a23440a7
    resource: repo://nix/images/sai-css.nix
  - id: openwiki-source-f17a99c6d8bccb141c65fb47
    resource: repo://nix/images/sai-id.nix
  - id: openwiki-source-cba26730439008725c490cef
    resource: repo://nix/images/sai-worker.nix
  - id: openwiki-source-833782312af20d943c4bd83d
    resource: repo://nix/podman.nix
  - id: openwiki-source-55f67d07018be4b3c4161eb1
    resource: repo://packages/components/src/temporal/queues.ts
  - id: openwiki-source-60ea044d0e14ab98032a8e8c
    resource: repo://packages/components/src/tracing/bootstrap.ts
  - id: openwiki-source-23ba2a7bbe5efb6e2d77954d
    resource: repo://packages/components/src/workers/main.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
---

# Production deployment and observability

Production runs as NixOS hosts whose containers are managed by Podman, with
Caddy as the edge reverse proxy, ragenix-encrypted secrets, and an
OpenTelemetry → Tempo → Grafana trace pipeline.

## Flake hosts

`flake.nix` declares a ragenix input and several `nixosConfigurations`:

- `hetzner-cloud-aarch64` — the bare Hetzner target installed with
  `nixos-anywhere`.
- `h4p` — the production host; pulls in the ragenix module, `nix/caddy.nix`,
  and `nix/podman.nix`.
- `demo` — the Cloudflare-based demo host (also ragenix + caddy + podman).
- `lima`, `lima-min`, `lima-local` — local Lima VM variants.

## Podman container runtime

`nix/podman.nix` sets `virtualisation.oci-containers` with
`backend = "podman"` and declares the full service fleet (fuseki, garage, id,
postgresql, temporal, auth, worker, registry, data). Containers get systemd
`Restart = "always"` by default; the one-shot Temporal schema/namespace setup
jobs force `Restart = "no"`. The image definitions
(`nix/images/sai-css.nix`, `nix/images/sai-worker.nix`, …) pin `pkgs.nodejs_26`
to match the repo's Node 26 requirement.

### Fuseki and Garage

The Podman fleet uses the same per-pod storage model as dev/test: Fuseki
(`docker.io/secoresearch/fuseki:5.6.0` by default) with a persistent
`/fuseki-base` volume, and Garage (`dxflrs/garage:v2.2.0`) with meta/data
volumes. The `id` container points at
`CSS_ID_SPARQL_ENDPOINT=http://fuseki:3030/id/sparql`; the data container sets
`CSS_S3_REGION=garage`; the worker receives `CSS_FUSEKI_BASE_URL`,
`CSS_GARAGE_ADMIN_ENDPOINT`, and `CSS_S3_ENDPOINT`. There is no shared
Oxigraph or `CSS_SPARQL_ENDPOINT` in the current configuration
([`nix/podman.nix`](../../nix/podman.nix)).

Production images are built from the repo workspace under Node 26
(`nix/packages/sai-runtime.nix`), not from published interop tarballs. The OCI
workflow publishes `sai-id-image`, `sai-css-image`, and `sai-worker-image`
([`.github/workflows/oci.yml`](../../.github/workflows/oci.yml)).

### Remaining cutover work

The code and Nix configuration are migrated; the operational cutover is not
complete. Remaining work is tracked as issues:

- #109 — export the old Oxigraph graphs, split them per pod, provision Fuseki
datasets/Garage buckets for existing accounts, write endpoint records, and run
the reciprocal-mirror backfill.
- #114 — Fuseki/Garage hardening (Shiro auth, internal-only ports), tracing
  preload in the image commands, the `findSparqlByIri` index, deployed smoke
  test, backups/restore, and the `lima-local` → `demo` → `h4p` rollout.
- #112 — schedules for `reconcileActivities`/`reconcilePeerMirrors` and the
  mirror-sync retry-cap decision.
- #113 — real-deployment webhook channel bootstrap/healing.

The C4 model (`docs/architecture.c4`) still uses the old shared-Quadstore
vocabulary; see [Deployment landscape](../architecture/deployment-landscape.md).

## Caddy and secrets

`nix/caddy.nix` defines the container options and Caddy `virtualHosts` for
`*.id`, `data`, `registry`, `auth`, and `ui`. `nix/h4p.nix` wires the Caddy
Gandi DNS plugin for ACME DNS-01 challenges, mounts `age.secrets.gandi` and
`age.secrets.auth` via ragenix, exposes the bearer token through a systemd
`EnvironmentFile`, and opens the firewall. Deployment is manual:
`nixos-anywhere --flake .#hetzner-cloud-aarch64` then
`nixos-rebuild switch --flake .#me --target-host … --build-host …`.

## Observability

Instrumented Node processes start OpenTelemetry through
`packages/components/src/tracing/preload.cjs` and `bootstrap.ts`
(`initNodeTracing`), exporting OTLP/HTTP to the Tempo service. With no env vars
the SDK is a no-op. The production image commands do **not** wire the
`--require preload.cjs` flag yet; that is part of the hardening issue #114.

### Env contract

| Var | Effect |
| --- | --- |
| `SAI_OTLP_ENDPOINT` | our OTLP endpoint, handed to the exporter explicitly — required under Dagger, whose engine injects and overrides `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | live OTLP/HTTP export for the Compose dev loop when `SAI_OTLP_ENDPOINT` is unset |
| `OTEL_SERVICE_NAME` | span `service.name` (sai-test / sai-uas / sai-id / sai-registry / sai-data / sai-worker) |
| `OTEL_CAPTURE_HEADERS=true` | attach `authorization` / `cookie` / `content-type` / `accept` / `if-none-match` / `link` as span attributes |
| `OTEL_SDK_DISABLED=true` / `OTEL_TRACES_EXPORTER=none` | hard-off |
| `TEMPORAL_ADDRESS` | Temporal endpoint for auth, worker, registry, and data. Registry and data need it for durable webhook delivery as well as workflow dispatch. |

`SAI_OTLP_ENDPOINT` wins because the Dagger engine injects the standard vars for
its own telemetry; the dedicated endpoint is passed straight to the exporter so
the injected standard vars are ignored.

### Mechanics

`HttpInstrumentation` + `UndiciInstrumentation` provide server/client spans, and
`SimpleSpanProcessor` is used (synchronous — no batching, no tail-span loss when
services are killed). `ApiHandler` wraps each RPC call in a `sai.rpc.handle`
span; the JSON-LD helpers emit `sai.jsonld.raw` / `sai.jsonld.framed` /
`sai.jsonld.expanded` spans; SPARQL reads run inside `sparql.query` spans;
Temporal uses `OpenTelemetryPlugin` on the four workers and the client. Browser
spans export from the UI to `/otlp`, routed by Traefik to `tempo:4318`.

`environments/dev/tempo/tempo.yaml` runs single-binary Tempo: OTLP ingestion on `4317` (gRPC)
and `4318` (HTTP), the TraceQL/query API on `3200`, with local WAL/blocks. A
provisioned Grafana datasource (`environments/dev/grafana/provisioning/datasources/tempo.yaml`)
points Grafana at Tempo, so traces are browsable out of the box.
