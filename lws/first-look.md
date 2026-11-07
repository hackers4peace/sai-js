# PR #126 first look — switching CSS to `jeswr/CommunitySolidServer#feat/lws-next-major`

Evaluated against `sai-js` at `main`/`lws` (`077a12ed`), CSS `8.0.0-alpha.2`.

## TL;DR

Switching the **CSS package source** to PR #126 is low-risk and mostly mechanical. **Enabling LWS on SAI** is the real work: PR #126 was built and tested against CSS's file/memory backends, while SAI runs a custom Postgres + Fuseki + S3 hybrid store, a custom policy engine, and its own notification/grant model.

Recommended shape:

- Use the **`solid-lws`** components, **not `lws`**. `lws` changes `application/ld+json` container responses to LWS JSON and would break SAI/Solid clients. `solid-lws` keeps Solid-OIDC DPoP and LDP JSON-LD.
- Keep **auth** Solid-only (it has `allow-all` + `ldp/handler/disabled`, so the LWS presets cannot run there anyway).
- Enable LWS first on **data**, then **registry**.
- Plan for four SAI-specific gaps: SPARQL child metadata, JSON document preservation, LWS subscription storage, and `.lws/` paths in `SaiPermissionsEngine`.
- Update tests expecting `205` to `204`.

---

## 1. What PR #126 actually is

- PR: `jeswr/CommunitySolidServer#126`, draft, head `feat/lws-next-major` (`311b3677`), base `lws-next-major-base` (`9ebe8c46`).
- 4 commits, 147 files, +12,759/−4. Mostly new LWS classes/configs; existing configs are not changed (semver minor).
- Base is upstream `versions/next-major` at `9ebe8c46`, which is **alpha.3 + 16 commits** (dependency bumps, memory-backend child metadata, test config). The fork's `package.json` is still `8.0.0-alpha.3`.
- The npm `next` tag is `8.0.0-alpha.3`, which **does not contain LWS**. There is no published LWS preview package.
- New presets: `config/lws.json`, `lws-acp.json`, `solid-lws.json`, `solid-lws-acp.json`, plus `lws`/`solid-lws` component variants.
- `solid-lws` is the dual protocol config: Solid + LWS, WAC; `solid-lws-acp` is ACP. SAI's data/registry configs already provide `ReadDeleteReader`, so the LWS `lws-access.json` override works with SAI's custom policy engine too.

Built the fork branch locally: `npm ci` builds `dist/` successfully and the server boots with `config/solid-lws.json`.

---

## 2. Dependency switch

### Files to change

- `/package.json`
- `/packages/components/package.json`
- `/services/css/package.json`
- `/package-lock.json`
- `/services/css/package-lock.json`

### Options

1. **Git dependency** (simplest for a branch):
   ```json
   "@solid/community-server": "github:jeswr/CommunitySolidServer#feat/lws-next-major"
   ```
   npm runs CSS's `prepare` (`npm run build`) on install. It works, but `npm ci` clones/builds CSS and the lockfile records the commit.

2. **Tarball / local build** (more reproducible):
   ```json
   "@solid/community-server": "file:../vendor/community-solid-server-8.0.0-alpha.3.tgz"
   ```
   Build once with `npm ci && npm pack` in the fork and install the tarball. The tarball includes `config/` and `dist/`.

3. **Publish a preview** from the fork (e.g. `8.0.0-alpha.3-lws.1`) and use a normal semver range. Best long-term; avoids git builds and version ambiguity.

### Gotchas

- The fork version is still `8.0.0-alpha.3`. If the lockfile already has the registry alpha.3, npm may not replace it. Use a distinct version, a git URL, or `--force`.
- `packages/components` currently depends on `@solid/community-server: 8.0.0-alpha.2`. If it stays at alpha.2 while the root is on the fork, npm can install a **second nested CSS**. That causes duplicate Comunica/n3 versions and can break Components.js loading. Update all three references consistently, or use a root `overrides` entry.
- `services/css` is **not** a workspace. It has its own lock and installs `@elfpavlik/sai-components` rc.29 from npm. If you change `packages/components/config`, `services/css` will not see it until you publish a new components version or switch that dependency to `file:`.
- `componentsjs-compile-config` / `npm run validate` fails in a clean alpha.3/fork install with the Comunica/CSS generated-components “empty term” error. The server still boots (verified), and alpha.2 with componentsjs 6.4 fails the same way, so this is pre-existing rather than PR-specific. Do not rely on `validate` as the gate; use server startup + integration tests.

### Code compatibility

No **export-name conflicts** and no CSS API breakage found in `packages/components/src`:

- The PR's `src/index.ts` changes are additive LWS exports.
- `DataAccessorBasedStore` changes: description resources inherit `dc:modified`, and `If-Match`/`If-Unmodified-Since` failures now return **412** instead of 304. SAI uses `If-None-Match: *`, so this should not affect its idempotent PUTs, but it is a behavior change to test.
- `InMemoryDataAccessor` change only affects the memory backend (not SAI's hybrid store).
- `ResourceUtil` change is the 412 behavior above.
- `ContentTypes`/`Vocabularies` additions are additive.

Alpha.3 also bumps Comunica 4→5, n3 1→2, `rdf-parse`/`rdf-dereference`/`rdf-serialize` 4→5, `componentsjs` 6.3→6.4, etc. SAI's direct Comunica (`@comunica/query-sparql-rdfjs` 4.x) and n3 1.x coexist with CSS's newer versions, but keep an eye on duplicate packages and RDF/JS type compatibility.

---

## 3. Config changes to enable LWS

### Use `solid-lws`, not `lws`

`config/util/representation-conversion/converters/solid-lws-container.json` keeps `application/ld+json` as the LDP representation; the `lws` variant makes `application/ld+json` return LWS JSON. SAI clients use `application/ld+json` extensively, so `solid-lws` is required.

### Data and registry configs

In both `packages/components/config/data.json` and `packages/components/config/registry.json`, replace:

| Current | Replace with |
|---|---|
| `css:config/ldp/authentication/dpop-bearer.json` | `css:config/ldp/authentication/solid-lws.json` |
| `css:config/ldp/handler/default.json` | `css:config/ldp/handler/solid-lws.json` |
| `css:config/ldp/metadata-parser/default.json` | `css:config/ldp/metadata-parser/lws.json` |
| `css:config/ldp/metadata-writer/default.json` | `css:config/ldp/metadata-writer/solid-lws.json` |
| `css:config/ldp/modes/default.json` | `css:config/ldp/modes/lws.json` |
| `css:config/storage/middleware/default.json` | `css:config/storage/middleware/lws.json` |
| `css:config/util/representation-conversion/default.json` | `css:config/util/representation-conversion/solid-lws.json` |

Add:

- `css:config/identity/lws/default.json` (LWS token endpoint, JWKS, subject-token verifiers)

Keep SAI's own:

- `sai:config/ldp/authorization/sai.json` (data) / `css:config/ldp/authorization/acp.json` (registry)
- `sai:config/storage/hybrid.json`, `routed-sparql.json`, `pod-endpoints.json`, Postgres key-value
- `sai:config/http/handler/default.json`, notifications, overrides

The LWS `lws-access.json` override targets `urn:solid-server:default:ReadDeleteReader`; SAI's `readers/default.json` defines it, so the override should apply. The `PathBasedReader`/`AdminPermissionReader` wrapping remains.

### HTTP handlers

SAI's `sai:config/http/handler/default.json` defines its own `BaseHttpHandler`. Add the LWS handlers there:

- `urn:solid-server:default:LwsNotificationHttpHandler` (before `NotificationHttpHandler`)
- `urn:solid-server:default:LwsAuthorizationServerHandler` (before `IdentityProviderHandler`/`LdpHandler`)

No need to import `css:config/http/handler/lws.json`'s `HttpHandler`; SAI overrides it anyway. The LWS handler definitions come from `solid-lws.json` (`lws-notifications.json`) and `identity/lws/default.json`.

### Auth service

Leave `packages/components/config/auth.json` alone for the first phase. It uses `css:config/ldp/authorization/allow-all.json` and `css:config/ldp/handler/disabled.json`; the LWS handler config requires `ReadDeleteReader` and an LDP handler, so it will not work there. Auth remains the Solid-OIDC IdP/UAS. The data service's LWS `OidcSubjectTokenVerifier` accepts ID tokens from auth via the `solid:oidcIssuer` fallback, and `services/id` already maps `solid:oidcIssuer` to `lws:OpenIdProvider` in its CID document.

### Wrappers / environments

- `services/css/*.json` and `environments/css/*.json` are thin wrappers around `sai:config/*.json`; they pick up data/registry changes automatically.
- `environments/css/https/auth.json` is a **full copy** of the auth config, not a wrapper. If auth changes, update it manually.
- `environments/css/https/data.json` uses `suffix` identifiers, `environments/css/data.json` uses `subdomain`; LWS storage = pod root in both. Test both shapes.

### Flat URI space (LWS issue #207)

Issue #207 asks for a storage capability advertising URI allocation (e.g. `https://storage.example/{uuid}`) and notes clients should not assume URI structure reflects containment.

- The branch has **no standard URI-allocation capability**. `LwsStorageDescriptionHandler` supports a `capabilities` array in the storage description, but the LWS presets (`lws.json`, `solid-lws.json`) do not configure it, and there is no LWS/CSS vocabulary for a URI-template capability.
- Identifier configs: `suffix.json` = `SingleRootIdentifierStrategy` (single root; pods at `baseUrl/{pod}/`), `subdomain.json` = `SubdomainIdentifierStrategy` (multiple roots). LWS presets use `suffix`; SAI's docker data service uses `subdomain`, dagger uses `suffix`.
- POST to a container without a `Slug` generates a UUID under that container (`DataAccessorBasedStore.createURI`). POST to the root therefore yields `baseUrl/{uuid}` — a flat one-level space, matching the issue's example for resources directly under the storage root.
- But containment is still slash-based: `BaseIdentifierStrategy.getParentContainer`/`contains` and `DataAccessorBasedStore.createURI` derive parent/containment from the path. A truly flat URI space where URI structure is independent of containment is not supported without a custom `IdentifierStrategy` plus store/containment logic. The branch does not add one.
- Customization: `IdentifierStrategy` is a Components.js interface; you can implement a custom strategy and advertise a custom `capability` on `LwsStorageDescriptionHandler`, but you would also need to override `DataAccessorBasedStore.createURI`/containment or provide a custom store. The existing `IdentifierGenerator` is for pod creation, not resource allocation.

Verdict: flat root-level UUID allocation is possible with `suffix.json` + POST to root; the LWS URI-allocation capability is not implemented; URI-independent containment requires custom code.

---

## 4. SAI-specific code changes

These are the non-mechanical parts.

### 4.1 LWS container listings on the SPARQL store

`packages/components/src/RoutedSparqlDataAccessor.ts` delegates `getChildren` to CSS's `SparqlDataAccessor`. That implementation yields only `new RepresentationMetadata(childPath)` — no child metadata. `DataAccessorBasedStore` then adds only `ldp:contains` to the container representation. The LWS `ContainerToLwsJsonConverter` reads the child quads and defaults every data resource's `format` to `application/octet-stream`, with no `size`/`modified`.

PR #126 fixed this for the **memory backend** (`InMemoryDataAccessor`), but not for the SPARQL backend. SAI's data/registry pods are SPARQL-backed, so LWS listings will misreport formats.

Fix options:

- Enhance `RoutedSparqlDataAccessor.getChildren` to fetch each child's metadata (N+1 `getMetadata` calls), or
- Add a single SPARQL query that constructs the containment children plus their metadata graph, or
- Accept `application/octet-stream` for LWS listings (not ideal; LWS requires `format` for `DataResource`).

This is the most concrete functional gap for LWS browsing of SAI data.

### 4.2 Preserve LWS JSON documents in the hybrid store

`HybridDataAccessor.writeDocument` tries to convert every document to `INTERNAL_QUADS`. `application/ld+json` is convertible, so it is stored in Fuseki as quads. LWS access grants/requests are JSON documents; `AccessGrantIndex.loadGrants` reads them with `store.getRepresentation(...)` and `JSON.parse(await readableToString(...))`. If a grant was posted as `application/ld+json`, the store returns a quad stream and `JSON.parse` fails; the grant is silently ignored.

The PR's own tests post grants as `application/lws+json`, which SAI's converter likely cannot convert, so it falls back to S3 and works. But `AccessDocumentOperationHandler` also accepts `application/ld+json` and `application/json`.

Required:

- Either route `.lws/` JSON documents (or `application/lws+json` / `application/ld+json` under `.lws/`) to the binary accessor, or
- Restrict LWS access documents on SAI's data service to `application/lws+json`/`application/json`, or
- Teach `AccessGrantIndex`/`AccessDocumentOperationHandler` to work with quad representations (larger change).

Also test the same for LWS access requests and any LWS JSON Merge Patch target. `JsonMergePatcher` only accepts representations whose metadata content type is JSON; SAI's JSON-LD resources are `INTERNAL_QUADS`, so LWS JSON Merge Patch on SAI JSON-LD data resources will fall through to 415. This is a fundamental mismatch between LWS's JSON resource model and SAI's RDF-normalizing hybrid store.

### 4.3 LWS subscription storage

`config/ldp/handler/components/lws-notifications.json` defines `LwsSubscriptionStorage` with a `JsonResourceStorage` over the root `ResourceStore` at `/.internal/lws/subscriptions/`. SAI's data service has **no root storage** (pods are subdomains or path-based pods), so that storage cannot be created. The LWS notification endpoint will fail.

Fix: override `LwsSubscriptionStorage.storage` to a prefixed view of SAI's Postgres `KeyValueStorage`:

```json
{
  "@id": "urn:sai:default:OverrideLwsSubscriptionStorage",
  "@type": "Override",
  "overrideInstance": { "@id": "urn:solid-server:default:LwsSubscriptionStorage" },
  "overrideParameters": {
    "storage": {
      "@type": "ContainerPathStorage",
      "relativePath": "/lws/subscriptions/",
      "source": { "@id": "urn:solid-server:default:KeyValueStorage" }
    }
  }
}
```

`ContainerPathStorage.entries()` filters by prefix, so it will not pick up account/lock keys. This also avoids needing `.internal` path protection. If you instead keep `JsonResourceStorage`, add `PathBasedReader`/`AuxiliaryStrategy` rules for `.internal`; SAI currently has no `paths` on `PathBasedReader`.

### 4.4 `SaiPermissionsEngine` and `.lws/` member paths

`SaiPermissionsEngine.determineTargetType` returns `undefined` for paths deeper than `storage/registration/resource`; `getPermissions` then hits `default: throw new Error('unexpected IRI: ...')`.

LWS paths:

- `.lws/grants/` → `TargetType.Resource` (no throw)
- `.lws/grants/<id>` → `undefined` → **throws**
- `.lws/requests/` → `TargetType.Resource` (no throw)
- `.lws/requests/<id>` → `undefined` → **throws**

The LWS `AccessGrantReader` is unioned with `PolicyEngineReader`; `UnionPermissionReader` does not catch reader errors. For non-admin agents, accessing a grant/request member can therefore throw before the LWS reader grants anything. The UAS admin short-circuits via `AdminPermissionReader`, so UAS-managed grants work. External LWS access requests may still work if the POST permission check only targets the `.lws/requests/` container, but this needs testing; reading/deleting a request member as a non-admin will hit the throw.

Fix: make `SaiPermissionsEngine.getPermissions` return an empty permission map for unknown target types (or explicitly handle `.lws/` paths) instead of throwing. This is a small, safe change and should be tested with an external LWS agent creating and reading an access request.

### 4.5 Client-side token exchange

SAI's existing `SelfIssuedSession` issues Solid-OIDC DPoP tokens with `webid` + `client_id`; `solid-lws` keeps the Solid-OIDC extractors and sets `skipWebIdTokens: true` on the LWS extractor. So **SAI's existing clients continue to work** without implementing LWS token exchange.

External LWS clients use `/.well-known/lws/token` on the data service and can exchange:

- `did:key` self-signed credentials (works),
- OIDC ID tokens from SAI auth (works via `solid:oidcIssuer`/CID fallback),
- self-issued CID credentials (caveat: `CidSubjectTokenVerifier` fetches with `Accept: application/ld+json`, while `services/id` serves the CID document for `application/cid`; the OIDC suite is the practical path, or adjust the verifier/id service to negotiate CID).

### 4.6 204 vs 205

The `solid-lws` handler wraps the operation handler in `NoContentOperationHandler`, so successful PUT/PATCH/DELETE return **204** instead of CSS's **205**. SAI tests assert 205 in `test/policy-engine.test.ts` (PUT, PATCH, DELETE). Update those to 204, and the comment in `test/reconciliation.test.ts`. Other tests use `response.ok` and are fine.

---

## 5. Test / infra changes

- Update the CSS version in the dagger image (`npm ci` uses the root lockfile).
- Update `environments/css/https/*.json` if the shared `sai:config/*.json` changes; they import the shared configs, so mostly automatic. `environments/css/https/auth.json` is the manual copy.
- Add LWS integration tests covering:
  - `GET /` with `Accept: application/lws+cid` returns the storage description.
  - `/.well-known/lws-configuration`, `/.well-known/lws/token`, `/.well-known/lws/jwks`.
  - External agent token exchange + POST access request to `.lws/requests/`.
  - UAS creates a grant in `.lws/grants/`, external agent accesses the target.
  - LWS listing of a SPARQL-backed pod includes correct `format`/`size`/`modified`.
  - `application/ld+json` access grant round-trip (likely fails on the hybrid store).
  - JSON Merge Patch on a JSON-LD data resource (likely 415).
  - 204 responses.
- Existing Solid tests should mostly pass; the 205 assertions and any exact `Link`/`WWW-Authenticate` expectations are the likely changes. `agent-discovery` tests hit auth and are unaffected if auth stays Solid-only.
- The PR's LWS integration tests use CSS's memory backend, WAC/ACP, and the root storage; they do **not** cover SAI's hybrid store, Postgres key-value, subdomain/path pods, or custom policy engine. Do not treat them as coverage for SAI.

---

## 6. Product/architecture decisions

- **Two grant systems.** LWS access grants live in `.lws/grants/` and are simple JSON policies. SAI's DataGrant/AdminGrant model lives in the registry and drives the UI/Temporal workflows. Enabling LWS grants runs them in parallel; they will not appear in the SAI UI/registry unless projected. Replacing SAI's grant model with LWS grants is a much larger change.
- **Two access-request queues.** LWS requests live in `.lws/requests/`; SAI access requests live in the registry. The UAS can manage both, but the UI/Temporal flows currently only know SAI requests.
- **Two notification systems.** LWS webhook notifications and SAI's `DurableWebhookEmitter`/NDJSON stream are separate. Enabling LWS notifications will send a second set of notifications for every change; decide whether to keep both or make LWS notifications the single mechanism.
- **In-memory caches.** `AccessGrantIndex` and `LwsSubscriptionStorage` cache in memory and do not work correctly across multiple worker threads/replicas. SAI currently runs one data service process; if you scale horizontally, grants/subscriptions created via one replica will not be seen by others. The PR documentation explicitly notes this.
- **LWS spec draft.** The implementation follows the 28 September 2026 LWS editor's draft; behavior may change. The PR is still a draft and its base is a fork of `versions/next-major`, not the upstream branch.

---

## 7. Suggested sequence

1. **Dependency-only switch** to the fork branch/tarball, no config changes. Run the existing suite. This isolates alpha.3/dependency regressions (Comunica 5, componentsjs, 412 behavior).
2. **Data service `solid-lws`** with the import replacements, LWS identity config, LWS HTTP handlers, and the Postgres subscription-storage override. Keep SAI auth/policy/notifications. Add smoke tests for storage description + token exchange + access request.
3. **Registry service `solid-lws`** (ACP variant) with the same changes.
4. **Store/policy fixes**: child metadata in `RoutedSparqlDataAccessor`, JSON document preservation in `HybridDataAccessor`, `.lws` path handling in `SaiPermissionsEngine`.
5. **Decide on LWS grants/requests/notifications vs SAI's existing systems**; only then wire them into the UI/Temporal/registry model.

If the goal is only “make the CSS package come from PR #126” and not “use LWS on SAI pods”, steps 1 and the 204 test updates are essentially the whole change. If the goal is LWS interoperability, steps 2–4 are required before LWS access requests/grants/listing work reliably on SAI's storage.

See [`feature-parity.md`](./feature-parity.md) for the grant-model comparison against the current tests and `docs/temporal.c4`.
