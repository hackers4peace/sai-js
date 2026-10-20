---
type: frontend
title: Authorization UI
description: The Vue 3 + Vuetify + Pinia authorization console — entrypoint, router and pages, Pinia stores, the @effect/rpc client, the NDJSON events stream, localization, and PWA push.
tags: [ui, vue, vuetify, pinia, effect, pwa]
sources:
  - id: openwiki-source-a3fc2fbd28c4b3f035ac208f
    resource: repo://ui/authorization/src/effect.ts
  - id: openwiki-source-59c73756667a9a84494055ec
    resource: repo://ui/authorization/src/events.ts
  - id: openwiki-source-17a10a75566f17fa07d6bad6
    resource: repo://ui/authorization/src/main.ts
  - id: openwiki-source-3f9ce578a40e86af10ea5764
    resource: repo://ui/authorization/src/router/index.ts
  - id: openwiki-source-1de1cb7b4e5904caddca9b5c
    resource: repo://ui/authorization/src/store/app.ts
  - id: openwiki-source-1f2b0c598f24062f7708088d
    resource: repo://ui/authorization/vite.config.ts
generated: { by: "pi", at: "2026-10-09T21:04:39.559Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-10-09T21:04:39.559Z
---

# Authorization UI

`ui/authorization` is the single-page Vue 3 authorization console (`sai-authz-ui`),
served by Vite and reverse-proxied at `ui.auth.docker`.

## Bootstrap and routing

`src/main.ts` loads the runtime config (fetched `config.json`) **before**
mounting: on success it creates the app and `registerPlugins()` (Vuetify MD3,
fluent-vue, router, Pinia); on failure it renders a static error page. The
router (`src/router/index.ts`) has `/` (a default layout with `applications`,
`social-agents`, `roles`, `role`, `data-registries`, `settings`, `invitation`
children), `/authorize` (the OIDC interaction resolver), and `/login`. A global
guard calls `getWebId()` and redirects to `login` on failure.

## Pinia stores

- `core` (`store/core.ts`) — `userId`, language (persisted to `localStorage`
  with dynamic `.ftl` import), push subscription, and the cookie-based account
  lifecycle (`signIn/signUp/signOut`) against the `.account` endpoints.
- `app` (`store/app.ts`) — the registry cache (`socialAgentList`, `roleList`,
  `applicationList`, `invitationList`, `dataRegistryList`), `currentContext()`
  (org context or own webId), `switchContext` with revert-on-error, and the
  activity snackbar/claim tracker. Most actions pass `currentContext()` as the
  RPC `context` argument.

## RPC client and events stream

`src/effect.ts` builds an `HttpRpcResolverNoStream<UiRpcRouter>` whose requests
are prefixed with `${backendBaseUrl}/.sai/api` and send
`credentials: 'include'` (cookie auth), wrapped in `UiTracingLive` so browser
OTLP spans supply the `traceparent` the server reads. Every exported function
(`getWebId`, `authorizeApp`, `shareResource`, …) builds a typed `@effect/rpc`
request and `Effect.runPromise`s it. Activity-first RPCs echo the triggering
activity IRI as `activityId`; the app store records it as the claim anchor and
the stream handler matches the incoming row by exact id (no cross-binding).

`src/events.ts` opens `GET /.sai/events` (NDJSON, cookie-authed), runs
`fullRefresh()` on first connect and every reconnect, and `handleActivity`
refreshes the relevant store per activity class (filtering by
`actor === currentContext()`), with exponential-backoff reconnect and a
heartbeat watchdog.

The connection is a small state machine (`stopped → connecting → open ⇄
reconnecting`): on open it fires a **full store refresh** (snapshot resync —
the server never replays), the server heartbeats every ~30s and a watchdog
aborts a silent connection, and reconnects back off exponentially (1s → 30s).
Store freshness is soft, with three refresh kinds: **synchronous** (right after
the RPC returns — what the service already mutated), **completion-driven**
(a `done` event → targeted refetch by activity type), and **baseline** (view
mount + the `fullRefresh` on every (re)connect).

Access-request indicators are per-request collections: the `SocialAgent`
projection carries `accessRequestsSent` and `accessRequestsReceived`, and the
social-agent/data-registry views show their counts as badges and open the
matching authorization screen. An owner can archive a still-open request from
the list (`archiveAccessRequest`); `AccessRequestGranted` and
`AccessRequestArchived` are terminal resolutions, so the events stream clears
the indicator without a follow-up workflow.

## Localization and PWA

fluent-vue bundles (`.ftl` files under `src/locales/`) drive `$t`/`$ta`
localization, checked by `unplugin-fluent-vue`. The PWA is configured in
`vite.config.ts` via `VitePWA` (`injectManifest`, `autoUpdate`, `share_target`
on `/invitation`), and `src/sw.js` handles web push and broadcasts to clients.

> The UI has no unit/component tests of its own; behaviour is exercised through
> the Dagger service-level suite, which POSTs the same RPC envelope to
> `https://auth/.sai/api` and opens `/.sai/events`.
