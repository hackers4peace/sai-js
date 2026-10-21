---
type: "Reference"
title: "Auxiliary services"
openwiki_generated: true
sources:
  - id: openwiki-source-b8a927b0cc8a1ee64f5a4f78
    resource: repo://docker-compose.yaml
  - id: openwiki-source-5fefaeafd9642c4813d1f6df
    resource: repo://packages/components/config/auth.json
  - id: openwiki-source-6f14021836b9ccaba51777f5
    resource: repo://packages/components/config/data.json
  - id: openwiki-source-0b475136796d3c6391256850
    resource: repo://packages/components/config/overrides/emitter.json
  - id: openwiki-source-9f577882ea0b12c6f9a793ba
    resource: repo://packages/components/config/registry.json
  - id: openwiki-source-06025454564b63e0817ca135
    resource: repo://packages/components/src/DurableWebhookEmitter.ts
  - id: openwiki-source-20f656c24c37f213c002731b
    resource: repo://packages/components/src/index.ts
  - id: openwiki-source-55f67d07018be4b3c4161eb1
    resource: repo://packages/components/src/temporal/queues.ts
  - id: openwiki-source-c4c901bbae020feec3d29213
    resource: repo://services/css/auth.json
  - id: openwiki-source-e78a59eda6a92be12d4886a5
    resource: repo://services/css/data.json
  - id: openwiki-source-56517036d15dfae3226d9dbd
    resource: repo://services/css/registry.json
  - id: openwiki-source-04f6a81cd8f58552c8dfc86f
    resource: repo://services/id/cid.ts
  - id: openwiki-source-2fd7b9e9b2c7414ea65e9cc2
    resource: repo://services/id/server.ts
  - id: openwiki-source-ba7d0112a176643ef8b07b66
    resource: repo://shapetrees/functions/%5Bcollection%5D/%5Bname%5D.js
generated: { by: "pi", at: "2026-10-21T01:32:20.770Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T01:32:20.770Z
---


# Auxiliary services

Three supporting services sit beside the SAI core packages. They are not part of
the workspace build graph (`services/*` and `shapetrees/*` are private packages)
but are essential to a running deployment.

## WebID / CID service (`services/id`)

`services/id` is a Hono HTTP service that serves **WebID profile documents** and
derived **Controlled Identifier Documents (CIDs)** from the Fuseki `id` dataset.
`services/id/http.ts` is the default plain-HTTP entry (port 3000) and
`services/id/https.ts` is the TLS variant; both mount the Hono app exported
from `services/id/server.ts`.

The server reads `ID_ORIGIN`, `DOC_ORIGIN`, and `CSS_ID_SPARQL_ENDPOINT` at
module load and throws if any is missing. The `CSS_ID_SPARQL_ENDPOINT` points at
the Fuseki dataset whose `sparql` service holds the WebID profiles (for example
`http://fuseki:3030/id/sparql` in dev); it is distinct from the per-pod registry
datasets (see [Per-pod storage and isolation](../architecture/storage-isolation.md)).
The service installs permissive CORS and exposes two routes:

- `GET /` is the subdomain router: the `Host` must be exactly one label deeper
  than `ID_ORIGIN` and end in it, and it 303-redirects to
  `https://${DOC_ORIGIN}/${subdomain}`.
- `GET /:handle` requires `Host === DOC_ORIGIN`, CONSTRUCTs every triple in the
  `https://${DOC_ORIGIN}/${handle}` graph, 404s when the graph is empty, then
  content-negotiates: `application/ld+json` via `jsonld.fromRDF`,
  `text/turtle` via `pretty-turtle`, and default `application/cid` via
  `toCidDocument`.

`services/id/cid.ts` derives the CID with an n3 `Reasoner`: a
`solid:oidcIssuer` becomes a `lws:OpenIdProvider` `did:service`, and
`interop:hasAuthorizationAgent` becomes an `interop:AuthorizationAgent`
`did:service`. `toCidDocument` frames the reasoned graph with the
`https://www.w3.org/ns/cid/v1` context.

## Community Solid Server configs (`services/css`)

`services/css` pins `@solid/community-server` 8.0.0-alpha.2 and
`@elfpavlik/sai-components` and provides three instance configs that import the
`css:config/http/server-factory/http.json` base plus a `sai:config/*.json`
graph from the components package:

- `auth.json` → `sai:config/auth.json` (the Solid-OIDC identity provider).
- `registry.json` → `sai:config/registry.json` (the ACP-protected registry server).
- `data.json` → `sai:config/data.json` (the SAI policy-engine data server).

These `services/css/*.json` files are thin wrappers; the authoritative config
graphs live under `packages/components/config/`. The Docker Compose stack mounts
near-identical copies from `environments/css/` instead.

### Components.js customization

`@elfpavlik/sai-components` is the in-repo `packages/components` package. It is
the only workspace package that builds to `dist/`: `tsc` produces the runtime
JavaScript and `componentsjs-generator -s dist -c dist/components -r sai -i
.componentsignore` produces the Components.js descriptors. The package's
`lsd:module` / `lsd:components` / `lsd:importPaths` fields point CSS at
`dist/components/` and the `config/` directory, so a config can import both
`sai:config/<server>.json` (custom components) and stock `css:config/...`
modules.

CSS built-ins are replaced with `@type: Override` entries in
`packages/components/config/overrides/`: `overrideInstance` names the stock
component, and `overrideParameters` (or `overrideSteps` for list edits) supply
the replacement. Existing precedents are `jwks.json`, `disable-ui.json`,
`disable-v6-migration.json`, `base-http-handler.json` (which swaps CSS's
`StaticAssetHandler` for `RootStaticAssetGuard`), and `emitter.json` (which
swaps `WebhookEmitter` for `DurableWebhookEmitter`). Custom SAI components are
added the same way — by `@id`/`@type` graph entries — rather than by editing
CSS itself: the storage/routing set (`PodEndpointStore`, the routed SPARQL/S3
accessors, `HybridDataAccessor`), the auth/permission set (`SessionManager`,
`SaiAuthorizationManager`, `SaiPermissionsEngine`, `CustomWebIdStore`), the
activity/events set (`ActivityWebhookHandler`, `EventsHandler`,
`NdjsonNotification`, `DurableWebhookEmitter`), the delegation handlers, and the account/Garage
components.

Notification wiring differs per server: **auth** imports
`css:config/http/notifications/disabled.json`; **registry** and **data** import
`css:config/http/notifications/all.json`, `sai:config/http/notifications/ndjson.json`
(the NDJSON streaming serializer and handler), and
`sai:config/overrides/emitter.json`. The emitter override replaces the stock
`WebhookEmitter` with `DurableWebhookEmitter`; the class is exported from the
components index and generated by `componentsjs-generator`.

`DurableWebhookEmitter` serializes the notification once and starts the
`deliverWebhook` workflow on the dedicated `webhook-delivery` queue. If the
enqueue fails, it falls back to the direct POST that the stock emitter performs.
The handlers use `sendTo` as a capability URL and do not verify the stock
emitter's DPoP token, so the durable path sends no `Authorization` or `DPoP`
headers. Channel provisioning still reuses the stock webhook API
(`webhook-subscription-bootstrap.md`).

## Shape-tree worker (`shapetrees`)

`shapetrees` is a Cloudflare Pages Functions worker serving **shape trees and
shapes** from static assets at `https://shapetrees.hackers4peace.net`. The
handler `shapetrees/functions/[collection]/[name].js` answers the
`/[collection]/[name]` route: `onRequest` reflects CORS, runs `negotiate`, then
fetches the chosen asset via the `env.ASSETS` binding.

`negotiate` reads a `COLLECTIONS` table (`shapes` → ShEx only; `trees` →
JSON-LD default plus Turtle), honours an explicit `.ext` suffix, and otherwise
scores `Accept` by q-value and specificity. The `.jsonld` assets are regenerated
from `.ttl` by `convert-to-jsonld.mjs`. Downstream consumers (e.g.
`examples/vuejectron`) reference these URLs directly, and
`environments/dev/map.json` maps the logical `https://data/shapetrees/` origin
to this worker.
