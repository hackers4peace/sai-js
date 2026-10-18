---
type: overview
title: Architecture overview
description: The sai-js monorepo, the Solid Application Interoperability specification it implements, its npm-workspace package layout, the no-build ESM/JSR package surface, and the Node 26/Turborepo/Vitest/oxlint toolchain.
tags: [architecture, monorepo, solid, typescript, overview]
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-0d51e872e5313bf2bd32309c
    resource: repo://packages/application/package.json
  - id: openwiki-source-c223d917c8b42455af9ac175
    resource: repo://packages/authorization-agent/package.json
  - id: openwiki-source-9a0178ffa2620c135186d460
    resource: repo://packages/components/package.json
  - id: openwiki-source-06f346a302383133b02d09e8
    resource: repo://packages/utils/package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-b7181b4d7359d016a13b092d
    resource: repo://test/package.json
  - id: openwiki-source-df1e4d0dc0a35c64fd0e652b
    resource: repo://tsconfig.base.json
  - id: openwiki-source-440ae1e215cb02721dda855c
    resource: repo://turbo.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "pi", at: "2026-10-18T21:45:34.463Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-18T21:45:34.463Z
---

# Architecture overview

`sai-js` is a TypeScript monorepo implementing the
[Solid Application Interoperability (SAI) specification](https://solid.github.io/data-interoperability-panel/specification/).
The root `package.json` is a private workspace named `interop` that groups the
packages under `packages/*`, the integration suite under `test`, and the docs
website under `docs/website`. The toolchain targets **Node.js 26** and npm 11.

## Intended dependents

The two public, spec-facing modules are documented in the root `README.md`:

- **Solid Applications** — `@janeirodigital/interop-application` (`packages/application`), the top-level module for applications conforming to SAI.
- **Solid Authorization Agent** — `@janeirodigital/interop-authorization-agent` (`packages/authorization-agent`), the top-level module for authorization agents.

## Workspace layout

| Area | Path | Role |
| --- | --- | --- |
| `api-messages` | `packages/api-messages` | `@effect/rpc` + effect Schema wire contract between UI and service |
| `application` | `packages/application` | Client-side application module and grant traversal |
| `authorization-agent` | `packages/authorization-agent` | Agent-side module (registries, grants, authorizations) |
| `components` | `packages/components` | HTTP handlers, service layer, Temporal workflows/activities, worker; the only workspace package that compiles to `dist` for Components.js |
| `data-model` | `packages/data-model` | JSON-LD POJO entities, ACR JSON-LD builders, bootstrap TriG templates |
| `repl` | `packages/repl` | Command-line REPL/utility (seed, gen-jwk) |
| `test-utils` | `packages/test-utils` | Shared seeding/fixture helpers, including per-pod Fuseki and Garage seeding |
| `utils` | `packages/utils` | JSON-LD, SPARQL/N-Quads, notification-subscription, discovery, and fetch primitives |
| services | `services/id`, `services/css`, `services/worker` | WebID/CID service, CSS instance configs, worker package |
| UI | `ui/authorization` | Vue authorization console |
| examples | `examples/plenary`, `examples/vuejectron` | Demo applications |
| shapetrees | `shapetrees` | Cloudflare shape-tree worker |
| environments | `environments/` | CSS configs, seed data, dev URL map |
| nix | `nix/` | NixOS/Podman production deployment |

The `data-model` package is the dependency-free anchor: `application` and
`authorization-agent` both depend on it, and it depends on neither of them (see
[Data model entities](../data-model/entities.md)).

## Package and publishing shape

The public packages — `utils`, `data-model`, `application`,
`authorization-agent`, `api-messages`, and `test-utils` — are **no-build ESM**
packages: `main`, `types`, and `exports` all point at `src/index.ts`, the
`files` list ships `src/`, and the runtime imports use explicit `.ts`
extensions. They are published directly from TypeScript (the JSR-oriented
layout), so consuming them requires a runtime that executes TypeScript.

`components` is the exception: it keeps a `tsc` build to `dist/` because
Components.js needs generated component descriptors (`dist/components/`), and
the `worker`/CSS entrypoints run the compiled JavaScript. `repl` also builds to
`dist`. The `authorization-agent` and `application` packages are the two
intended dependents-facing modules named in the README (`interop-application`
and `interop-authorization-agent`).

## Build and test tooling

- **Turborepo** drives `build`, `test`, `clean`, and `dev` across workspaces.
  `test` depends on `build` and is never cached; `build` outputs to `dist/**`.
- **Vitest 5** is the unit/integration runner. The root `vitest.config.ts` uses
  the `test.projects: ['packages/*']` form (it replaced the removed
  `vitest.workspace.ts`); the `test/` suite keeps its own configuration.
- **oxlint** and **oxfmt** replaced Biome: `npm run check` runs
  `oxlint . && oxfmt --check .`, and lint-staged applies both on commit.
- **TypeScript** is configured through a shared `tsconfig.base.json` with
  `strict`, `module`/`moduleResolution: nodenext`,
  `allowImportingTsExtensions`, and `erasableSyntaxOnly`; `npm run typecheck`
  runs `tsgo --noEmit` over the no-build packages.
- **Node.js 26** is the supported runtime (README, `devbox.json`, CI, and the
  Nix images all pin 26), and npm 11 is the package manager.

The two test layers are distinct: per-package unit tests under `packages/*/test`
run locally, while the Dagger-driven end-to-end suite under `test/` requires the
Dockerized service cluster (see [Integration test suite](../testing/integration-tests.md)).
