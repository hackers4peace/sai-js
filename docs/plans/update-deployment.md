# Update deployment — NixOS/Podman for per-pod Fuseki + Garage

> **Status:** 📋 not started. This is the single home for the remaining
> **production deployment and hardening** work for the per-pod storage stack.
> The code-level per-pod isolation is landed and documented in the OpenWiki
> (`architecture/storage-isolation.md`, `architecture/federation.md`,
> `services/org-context.md`); the remaining mirror-lifecycle, object-lifecycle,
> and cross-pod test work is in
> [`pod-isolation-followup.md`](pod-isolation-followup.md).
> The former production-consumer-cleanup workstream is **folded into this plan**
> (the image/package build workstream below). [`npm-publishing.md`](npm-publishing.md)
> remains an independent future goal — it is **not** a prerequisite for
> deployment.

## Problem

`nix/podman.nix` still describes the pre-migration deployment: one Oxigraph
container behind the `sai-oxigraph` nginx facade, `CSS_SPARQL_ENDPOINT` on
auth/registry/data/id, no Fuseki, and no Garage/S3 service. The application code
has moved on:

- CSS servers resolve storage through `PodEndpointStore`; there is no
  `CSS_SPARQL_ENDPOINT` default anymore. The `id` service requires
  `CSS_ID_SPARQL_ENDPOINT`, not `CSS_SPARQL_ENDPOINT`.
- Account bootstrap is a Temporal workflow that creates Fuseki datasets and
  Garage buckets/keys on the **worker**, not the auth server.
- Per-pod datasets, per-pod buckets, endpoint records, `/sparql-admin`, the
  session/context allowlist, and mirror writes are live in dev/test.

Today a production deploy would start CSS with removed/missing env, the `id`
service would not boot, and no Fuseki/Garage exists to resolve endpoints.

## Goal

Production NixOS/Podman matches the dev/test storage model:

- Fuseki (one dataset per registry pod + per data pod + a dedicated `id`
  dataset) replaces Oxigraph.
- Garage provides per-data-pod S3 buckets, provisioned by the account workflow
  with a worker-held admin token.
- The app images run Node 26 with the no-build TypeScript source (or, later,
  built npm artifacts — see [`npm-publishing.md`](npm-publishing.md)).
- `flake.nix`, `nix/podman.nix`, `nix/hosts/*`, `.github/workflows/oci.yml`, and
  the README describe the new topology and pass a deployed smoke test.

## Out of scope

- The code-level per-pod implementation (landed; see the OpenWiki
  `architecture/storage-isolation.md`).
- Live-registration mirror backfill **tooling**, the unregister mirror flow,
  external admin endpoint discovery, S3 orphan/account-deletion cleanup, and the
  cross-pod/mirror-freshness tests — [`pod-isolation-followup.md`](pod-isolation-followup.md)
  owns them; this plan sequences running the backfill before cutover.
- Publishing packages to npm ([`npm-publishing.md`](npm-publishing.md)).

## Current production state (verified)

| Area | Today |
| --- | --- |
| SPARQL store | `oxigraph` + `sparql` (sai-oxigraph nginx) in `nix/podman.nix`; `nix/images/sai-oxigraph.nix`; `sai-oxigraph-image` in `flake.nix` and `.github/workflows/oci.yml` |
| CSS env | auth/registry/data/id all receive `CSS_SPARQL_ENDPOINT = "http://sparql/sparql"` (removed from the code) |
| `id` service | still given `CSS_SPARQL_ENDPOINT`; the code requires `CSS_ID_SPARQL_ENDPOINT` and throws at startup |
| Object storage | no Garage service in `nix/podman.nix`; data has only the `css-data` file volume |
| Worker env | no `CSS_FUSEKI_BASE_URL`/`CSS_FUSEKI_ADMIN`, no `CSS_GARAGE_ADMIN_*`, no `CSS_S3_ENDPOINT` |
| Nix packages | `buildNpmPackage` on standalone `services/css`, `services/worker`, `services/id` with published deps; interop packages are TS-source-only |
| Images/OCI | `sai-css`, `sai-worker`, `sai-id`, `sai-oxigraph`; UI is a Nix package served by Caddy, not an image |
| Hosts | `h4p`, `demo`, `lima` set `sparql.tag`/`sparql.resolver`; `lima-local` loads `sai-oxigraph` and orders `podman-sparql.service` |
| Tracing | image wrappers run `node` without `--require .../tracing/preload.cjs` |

## Workstream A — storage services in `nix/podman.nix`

- [ ] Replace `oxigraph`/`sparql` containers with a **Fuseki** container
  (`secoresearch/fuseki:5.6.0` as in dev, or a Nix-built image if a pinned
  build is preferred). Keep it internal-only (no `ports`).
- [ ] Mount a **production** Fuseki config and a persistent
  `/fuseki-base` volume. Do not ship the dev `fuseki.config.ttl` fixture list:
  production starts with no fixture accounts (the `id` dataset may be declared
  or created by the workflow). Enable the admin module/Shiro so
  `/$/datasets` works; source the admin password from ragenix and pass the
  matching `CSS_FUSEKI_ADMIN` to the worker. The expected shape is Fuseki Full
  with `shiro.ini`:
  ```ini
  [users]
  sai-service=<hashed>,admins
  [urls]
  /$/ping = anon
  /$/server = anon
  /$/** = authcBasic,roles[admins]
  /**=anon
  ```
  Dataset creation persists in `FUSEKI_BASE`, so it survives restarts.
- [ ] Add a **Garage** container (`dxflrs/garage:v2.2.0`) with its own config,
  `meta`/`data` volumes, node key/layout, and an admin token from ragenix.
  S3 API on 3900 and admin API on 3903 stay internal. Do **not** reuse the dev
  token/node key from `garage/garage.toml`.
- [ ] Remove the `sparql` options (`tag`, `resolver`) from
  `nix/podman.nix`; add Fuseki/Garage options (image/tag, config path, secret
  paths, volumes).
- [ ] Update `nix/hosts/demo/demo.nix`, `nix/hosts/lima/config.nix`,
  `nix/hosts/lima/podman-local.nix`, and `flake.nix` accordingly; replace the
  `sai-oxigraph` image load with the Fuseki/Garage images (pulled or loaded).

## Workstream B — environment contract

- [ ] **auth** — remove `CSS_SPARQL_ENDPOINT`; **keep/add
  `CSS_FUSEKI_BASE_URL`** (the auth config imports
  `sai:config/variables/fuseki.json`, whose CLI extractor requires it even
  though the bootstrap workflow runs on the worker). `CSS_FUSEKI_ADMIN` is
  optional on auth; the worker requires it for dataset creation. Keep Postgres,
  Temporal, origins, VAPID.
- [ ] **registry** — remove `CSS_SPARQL_ENDPOINT`; reads resolve through the
  endpoint store. Keep `TEMPORAL_ADDRESS` for durable webhook delivery.
- [ ] **data** — remove `CSS_SPARQL_ENDPOINT`; add `CSS_S3_REGION=garage`. No
  bucket/endpoint env: the routed accessor reads the per-pod record. Keep
  `TEMPORAL_ADDRESS` for durable webhook delivery.
- [ ] **webhook retries**. `reconcileActivities` is the backstop for deliveries
  that exhaust their retries. It has no scheduler yet; scheduling stays
  separate from this cutover.
- [ ] **mirror-sync retry cap — reconsider before cutover.** With the
  replicate-before-regenerate flow landed (`openwiki/architecture/federation.md`),
  the mirror step of the `DelegatedGrantsUpdated` flow keeps today's 5-attempt cap
  (`packages/components/src/temporal/workflows/reciprocal.ts`, the
  `syncReciprocalMirror` proxy) and `done` on that activity means "the peer
  mirror is current". A peer that stays unreachable or keeps answering 403/5xx
  therefore leaves the activity **pending indefinitely** — the sweep that would
  eventually re-drive it still has no schedule. Revisit once scheduling exists:
  either unbounded retries with terminal 404/410, or a scheduled reconciliation
  arm. Until then, pending (not stale `done`) is the accepted failure mode.
- [ ] **worker** — add `CSS_FUSEKI_BASE_URL`, `CSS_FUSEKI_ADMIN`,
  `CSS_GARAGE_ADMIN_ENDPOINT`, `CSS_GARAGE_ADMIN_TOKEN`, `CSS_S3_ENDPOINT`.
  Keep `CSS_POSTGRES_CONNECTION_STRING`, `TEMPORAL_ADDRESS`, origins.
- [ ] **id** — replace `CSS_SPARQL_ENDPOINT` with
  `CSS_ID_SPARQL_ENDPOINT=http://fuseki:3030/id/sparql`.
- [ ] Wire `--require /…/tracing/preload.cjs` into the CSS/worker/id image
  commands (and keep the matching `OTEL_*`/`SAI_OTLP_ENDPOINT` env contract).

## Workstream C — images and packages

Production must stop installing TS-source-only interop packages into
`node_modules` (Node 26 cannot strip `.ts` there). Choose the **source-build**
path now; [`npm-publishing.md`](npm-publishing.md) is the later alternative.

- [ ] Rework `nix/packages/sai-css.nix`, `sai-worker.nix`, `sai-id.nix` to
  build/run from the **repo workspace** (workspace symlinks resolve to real
  source paths Node 26 can strip). Keep `@elfpavlik/sai-components` built
  (`dist/` + Components.js descriptors); the worker keeps its Temporal workflow
  bundles.
- [ ] Keep `sai-ui.nix` as the Vite build; `nix/hosts/*` keep serving it via
  Caddy. Verify `ui/authorization` (`vue-tsc`, dev server) against the no-build
  packages.
- [ ] Update `nix/images/sai-*.nix` `Cmd`/`WorkingDir` and Node 26 paths; remove
  `sai-oxigraph` if the upstream Fuseki/Garage images are used.
- [ ] Update `flake.nix` packages and `.github/workflows/oci.yml`
  `IMAGE_ATTRS` (drop `sai-oxigraph-image`; add `sai-fuseki-image` only if a
  Nix-built Fuseki image is chosen).
- [ ] `services/id` runs `.ts` under Node 26; `docs/website` must not import
  interop packages; README dev instructions drop the interop `npm run build`
  and keep the `packages/components` build for dagger.
- [ ] Keep the existing gate: `npx vitest run`, `npm run typecheck`,
  `npm run build -w @elfpavlik/sai-components`, `dagger call test`.

## Workstream D — data and account migration

- [ ] Export the production Oxigraph graphs and split them per pod
  (`reg-<handle>`, `data-<pod>`, plus the `id`/WebID profiles), reusing the
  fixture splitter where possible. Rehearse on `demo`/`lima` first.
- [ ] For **existing accounts**, create the Fuseki datasets, Garage buckets and
  scoped keys, and write the `sparqlEndpoint`/`objectEndpoint` records (the
  account workflow only runs for new signups). Decide whether legacy binary
  data on the `css-data` volume is migrated to Garage or kept read-only.
- [ ] Run the reciprocal-mirror **backfill** before the cutover
  ([`pod-isolation-followup.md`](pod-isolation-followup.md) deliverable); verify
  mirror freshness.
- [ ] Keep the old Oxigraph data/volume until the rollback window closes.

## Workstream E — hardening and verification

- [ ] Fuseki: restrict the admin/SPARQL endpoints to the podman network; enable
  Shiro auth (dev/test leave `/**=anon`); no public ports. Garage admin/S3 stay
  internal; the Garage admin token lives only on the worker.
- [ ] Replace `PodEndpointStore.findSparqlByIri`'s full-registry scan with an
  index/cache before large deployments (it is fine for the fixture).
- [ ] Add a deployed smoke test: signup → `bootstrapAccount` workflow →
  per-pod datasets + bucket/key + endpoint records → WebID profile → RPC
  (`ListSocialAgents`/`ListDataRegistries`) → org-context `/sparql-admin` →
  mirror sync.
- [ ] Verify backups/restore for the Fuseki and Garage volumes and the Postgres
  endpoint/account records.
- [ ] Rollout order: `lima-local` → `demo` → `h4p`; document rollback to the
  Oxigraph stack.

## Sequencing

1. **A + B** (services + env) with a fresh database and no data migration — get
   a green signup on `lima-local`.
2. **C** (image/package rework) so the images actually run the new env/source.
3. **D** (migration/backfill) on `demo`.
4. **E** (hardening + smoke + rollout) on `h4p`.

## Gate

- All app images build from the repo source under Node 26 and start with the
  new env.
- A fresh signup provisions Fuseki datasets, a Garage bucket/key, endpoint
  records, and a WebID profile; the per-pod storage smoke test passes.
- The migrated `demo` data is readable (registries, data instances, WebIDs,
  reciprocal mirrors) and the org-context flows work.
- `.github/workflows/oci.yml` publishes the new image set; `flake.nix` evaluates
  for all hosts.

## Cross-references / reconciliation

- The landed per-pod storage/isolation design is in the OpenWiki
  (`architecture/storage-isolation.md`, `architecture/federation.md`,
  `services/org-context.md`); the remaining mirror/object lifecycle and
  cross-pod tests are in [`pod-isolation-followup.md`](pod-isolation-followup.md).
- The former production-consumer-cleanup workstream is folded into workstream C.
- **[`npm-publishing.md`](npm-publishing.md)** is independent: deployment ships
  repo source. If publishing lands (built JS artifacts under `@hackers4peace`),
  the image build can switch to installed tarballs and drop the source-symlink
  layout.
- **[`extract-temporal-workflows.md`](extract-temporal-workflows.md)** may move
  the worker entrypoint; coordinate the worker image path with that plan.

## Files

| Area | Files |
| --- | --- |
| Containers | `nix/podman.nix`, `nix/images/sai-*.nix` |
| Packages/images | `nix/packages/sai-css.nix`, `sai-worker.nix`, `sai-id.nix`, `sai-ui.nix` |
| Flake/hosts | `flake.nix`, `nix/hosts/h4p.nix`, `nix/hosts/demo/demo.nix`, `nix/hosts/lima/*` |
| OCI | `.github/workflows/oci.yml` |
| Secrets | `nix/h4p.nix`, `nix/hosts/*/secrets.nix` + ragenix files (Garage admin token, Fuseki admin) |
| Migration | new export/split/backfill script or Temporal activity; `packages/test-utils/src/fuseki.ts` splitter |
| Docs | `README.md`, OpenWiki `operations/deployment.md` |

## Open decisions

- Fuseki: upstream image (`secoresearch/fuseki:5.6.0`) vs a Nix-built pinned
  image; production config file vs admin-created datasets.
- Keep legacy binary data on the `css-data` volume or migrate it to Garage.
- Whether existing production accounts are migrated in place or the environment
  is treated as demo data and wiped/reseeded.
- Mirror backfill tool: reuse the fixture splitter or wait for the
  `isolated-datasets` drift-scan workflow.
