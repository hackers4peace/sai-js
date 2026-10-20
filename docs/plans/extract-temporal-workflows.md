# Extract Temporal workflows; shrink `components` to Components.js-only

> **Status:** 📋 planning — blocked on a dependency-cycle decision (see
> "Dependency cycle"). Extracted from the completed ESM/no-build work (now
> documented in the OpenWiki `architecture/overview.md`) so that work can close
> out; this refactor is independent of the ESM/no-build/publishing work and is
> **not** part of it.

## Goal

`packages/components` should contain only the minimum needed for
`componentsjs-generator` to emit `dist/components/*.jsonld` (the component
classes + same-file helpers + `config/`). Everything else moves to dedicated
packages:

- all Temporal code → a new `packages/temporal-workflows`
  (`@elfpavlik/sai-temporal-workflows`, private);
- the non-component glue (`services/*`, `builders/*`, tracing, `util`,
  `SelfIssuedSession`) → a shared `packages/sai-services` (or folded into
  `@janeirodigital/interop-authorization-agent`).

## Audit

Registered Components.js classes currently in the package (**keep**):
ActivityEvents, ActivityWebhookHandler, ActivityWebhookStore,
AdminPermissionReader, AdminSparqlHandler, AgentIdHandler, ApiHandler,
CustomWebIdStore, EnvJwkGenerator, EventsHandler, GrantIssuanceHandler,
GrantRevocationHandler, HybridDataAccessor, InvitationHandler, NdjsonNotification,
PostgresKeyValueStorage, ProxyAdminHandler, ReciprocalWebhookHandler,
ReciprocalWebhookStore, S3DataAccessor, SaiAuthorizationManager,
SaiPermissionsEngine, SessionManager, UiPushSubscriptionStore — plus the
same-file helper classes the generator emits (SessionAcquirer, HybridResourceStore,
NdjsonNotificationSerializer, NdjsonStreamingHttpRequestHandler,
CompactedNotification, S3DataAccessorArgs, SparqlStoreEntry, ClientIdHandler) and
`config/`.

## ⚠️ Dependency cycle (blocks the naive move)

Moving `temporal/*` out as-is creates a `components ↔ temporal-workflows` package
cycle:

- **components → temporal:** `ActivityWebhookHandler`, `GrantIssuanceHandler`,
  `GrantRevocationHandler` import `temporal/client` + the workflow definitions to
  start workflows.
- **temporal → components:** activities import `builders/*` — and
  `builders/sessionManager` constructs the `SessionManager` + `EnvJwkGenerator`
  components, `builders/accountLoginStorage` constructs `PostgresKeyValueStorage`,
  and `activities/reciprocal` constructs `ReciprocalWebhookStore` — all component
  classes.

## Options to break it (decision needed before executing)

- **A. Workflow-starter port (cleanest).** Components depend on an injected
  `WorkflowStarter` interface (wired via Components.js config);
  `temporal-workflows` supplies the implementation. Move `services/*` (clean —
  they don't import components) + `builders`/`tracing`/`util` + `SelfIssuedSession`
  to `sai-services`, and move the component classes the builders construct
  (`SessionManager`, `EnvJwkGenerator`, `PostgresKeyValueStorage`) there too,
  re-exported by `components` for the generator. Largest; changes `config/`.
- **B. Accept the cycle (smallest).** Move `temporal/*` + `workers/main.ts` to
  `temporal-workflows`; `components` imports it (client/workflows) and
  `temporal-workflows` imports `@elfpavlik/sai-components` (builders,
  `ReciprocalWebhookStore`). Works at runtime; circular workspace dependency;
  `components` keeps services/builders.
- **C. Invert the builders (medium) — not sufficient alone.** Move builders to
  `sai-services` as factories taking the component instances as parameters;
  callers (worker, tests) construct them. Changes `buildSessionManager()` call
  sites incl. `test/`. Must be combined with A (the workflow-start edge remains).

## Move to a new `packages/temporal-workflows`

- `src/temporal/workflows/*` (7 files) — must stay isolated
  (`@temporalio/workflow`, `@temporalio/common`, pure data).
- `src/temporal/activities/*` (6 files) — Node-side; currently import
  `builders/*`, `services/ReciprocalMirror`, `ReciprocalWebhookStore`,
  `util/uriTemplates`.
- `src/temporal/client.ts` and `src/workers/main.ts` (the worker entrypoint the
  dagger/nix/compose commands run).
- worker-only tracing: `src/tracing/otel-state.ts`; decide `tracing/preload.cjs`.

## Other non-component code to relocate

| Code | Used by | Suggested destination |
|---|---|---|
| `src/services/*` (route handlers + domain helpers; ~15 files) | `ApiHandler` (component) **and** activities (`services/ReciprocalMirror`) | new `packages/sai-services`, or fold into `@janeirodigital/interop-authorization-agent` — overlaps `components-tweaks.md` |
| `src/builders/*` (`sessionManager`, `accountLoginStorage`) | activities + component tests | same destination as `services/*` |
| `src/SelfIssuedSession.ts`, `src/SessionManager.ts` | `SessionManager` is a component; `SelfIssuedSession` is its glue | keep with components (or move to the services package if `SessionManager` stays thin) |
| `src/tracing/bootstrap.ts`, `src/tracing/effect-tracer.ts` | `index.ts`, `workers/main.ts`, `test/`, `services/id` | small shared `tracing` package/module |
| `src/tracing/preload.cjs` | dagger/compose CSS `--preload` | keep as the package's non-component preload, or move to the shared tracing location |
| `src/util/uriTemplates.ts` | components + activities | shared location if components keep needing it |
| `src/messages.ts` | **no importers found** in `src` | confirm dead code, delete |

`src/index.ts` is then reduced to component exports (drop `./services/Account.js`,
`./tracing/bootstrap.js`, `./util/uriTemplates.js` if they move).

## Open decisions to resolve when starting

1. **Which cycle-breaking option** (A / B / C) — see above.
2. Destination of shared services/builders/tracing: a new `sai-services` package
   vs moving into `interop-authorization-agent` (coordinate with
   `components-tweaks.md`, which already plans to move residual SAI domain logic
   to the AA).
3. Whether `temporal-workflows` is private (likely) and whether it affects the
   publishing plan (`npm-publishing.md`).
4. Whether `config/` still needs to live in `components` (yes, Components.js
   configs must ship with the descriptors) and how the lsd `importPaths` change.

## Gate

G1 + G3 green, and `componentsjs-generator` output is unchanged — diff
`dist/components/*.jsonld` before/after (only expected path changes).
