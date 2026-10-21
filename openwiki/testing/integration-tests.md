---
type: testing
title: Integration test suite
description: The Dagger-driven integration suite — seeded environments/data, per-test re-seed, the waitForQuiescence/awaitGrantCompletion race-prevention helpers, and what each test file verifies.
tags: [testing, dagger, vitest, integration, race-prevention]
sources:
  - id: openwiki-source-a8a954b9de2bc6c0b4ca5044
    resource: repo://.dagger/src/index.ts
  - id: openwiki-source-6028df227cf0c5e36d839191
    resource: repo://environments/data/registry.trig
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
  - id: openwiki-source-23684c4afa0b096bb7c0aa5d
    resource: repo://packages/components/test/durable-webhook-emitter.test.ts
  - id: openwiki-source-900a2d8c960b090aaf5dc614
    resource: repo://temporal/dynamicconfig/development-sql.yaml
  - id: openwiki-source-b7181b4d7359d016a13b092d
    resource: repo://test/package.json
  - id: openwiki-source-6996f47c4d119fbaf101afe4
    resource: repo://test/roles.test.ts
  - id: openwiki-source-11c141224a72985968f722ac
    resource: repo://test/setup.ts
  - id: openwiki-source-681173e11e9e253d0432fde4
    resource: repo://test/share.test.ts
  - id: openwiki-source-44922de4c3997ca2d1d53cd9
    resource: repo://test/util.ts
generated: { by: "pi", at: "2026-10-21T01:32:20.770Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T01:32:20.770Z
---

# Integration test suite

The `test/` workspace drives end-to-end verification against a real Dockerized
cluster (auth/registry/data/worker/temporal/fuseki/garage), not mocks. It runs
under **Dagger** via `npm run dagger:test` =
`vitest run --no-file-parallelism`, so one test file runs at a time in the test
container.

## Dagger pipeline

`.dagger/src/index.ts` defines the `SaiJs` object with service factories
(`postgresService`, `fusekiService`, `garageService`, `temporalService`,
`workerService`, `idService`, `authService`, `registryService`,
`dataService`) and a `testBase()` that assembles a node container mounting the
repo at `/sai`, binding every service by hostname, and setting env
(`CSS_FUSEKI_BASE_URL`, `CSS_ID_SPARQL_ENDPOINT`, `CSS_S3_ENDPOINT`,
`CSS_GARAGE_ADMIN_ENDPOINT`, `TEMPORAL_ADDRESS`). The registry and data service factories bind Temporal. The `test` pipeline
function runs a Temporal-reachability wait before `vitest run
--no-file-parallelism` (and accepts `--tempo-endpoint` so Dagger runs can export
OTLP to a host Tempo). `test/proxy.js` forwards local ports to the debug
services.

## Seed and per-test reset

`environments/data/registry.trig` holds every party's RegistrySet,
registrations, ACRs, and the Alice↔Kim reciprocal pair and YoYo admin marker
reused by tests; `environments/data/kv.json` seeds CSS's Postgres key-value
store with accounts, cookies, and pre-wired `activityWebhook`/`reciprocalWebhook`
channels. At module load, `test/setup.ts` maps the fixture per pod
(`fixturePodDatasets` + `splitFixtureByPod`) and provisions one Garage bucket
and key per data pod with `seedObjectEndpoints`, merging the generated
`objectEndpoint` records into the fixture. Its `beforeEach` then re-seeds the
key-value store (`pg.seedKeyValue`) and **every per-pod Fuseki dataset**
(`seedFusekiDataset`, which runs `DROP ALL` first) — every test starts from the
pristine seed, wiping leftover state and pending activities. The client-id
document is PUT/DELETEd directly in the test-client bucket in
`beforeAll`/`afterAll`. The fixture split also backfills reciprocal mirrors at
seed time (`applyReciprocalMirrors`); that is fixture state, not a runtime
replication step.

## Race prevention

`test/util.ts` owns the barriers that make the async workflow machinery
deterministic:

- `waitForQuiescence(webIds)` — waits until none of the webIds has pending
  activities (registry entries without a matching completion) for two
  consecutive polls; a transient registry 500 counts as unsettled.
- `awaitGrantCompletion(authFetch, registrationId, webIds, trigger)` — the
  listen-first barrier: open the registration notification stream, run one
  RPC trigger, await the registration `Update`, then wait for quiescence
  (the `Update` fires mid-chain, before the parent workflow's completion tail).
- Category-specific `waitFor*Completion` helpers wait for the matching
  completion activity, and `openNotificationStream`/`openEventsStream` open
  listen-first streams (no replay).

`openNotificationStream` reads the CSS **streaming notification** channel,
whose lines are NDJSON of expanded JSON-LD (`test/util.ts` parses each line);
`openEventsStream` reads the separate `/.sai/events` NDJSON stream. Both must be
opened *before* the trigger, because neither replays.

`roles.test.ts` and `share.test.ts` read the peer mirror through
`reciprocalRegistration` and poll it with `waitFor`. The mirror is refreshed by
a webhook-triggered workflow, so it can lag the grantor registration Update
that the barrier already saw. The poll observes eventual consistency; it does
not write or manually replicate the mirror.

The Temporal default activity retry policy is `maximumAttempts: 1`, but the
webhook-delivery and reciprocal workflows set explicit retry policies. The
webhook path retries transient failures up to 10 attempts and stops on
permanent 4xx responses.

## Package-level webhook tests

`packages/components/test/durable-webhook-emitter.test.ts` covers the emitter
enqueue arguments and queue, the direct-POST fallback when the enqueue fails,
`postWebhook` status classification (`400`/`410`/`413`/`415`/`422` permanent;
other 4xx, 5xx, network retryable), and the `410` response from both webhook
handlers for an unknown `sendTo`.

## Coverage

Each file verifies one protocol surface: `access-request.test.ts` (need-based
requests), `account-creation.test.ts` (bootstrap workflow provisioning),
`admin-events.test.ts` (org-admin activity forwarding),
`agent-discovery.test.ts` / `discovery.test.ts` (Link-header discovery),
`agents.test.ts`, `authorization.test.ts` (authorization + approval),
`delegation-endpoint.test.ts` (issuance/revocation), `invitation.test.ts`
(personal + org invitation), `key-scoping.test.ts`,
`org-context.test.ts` (admin org context + proxy/sparql-admin),
`personal-admin.test.ts` (AddAdmin/RemoveAdmin + ACR),
`policy-engine.test.ts` (WAC/ACP matrix), `reciprocal-webhook.test.ts`,
`reconciliation.test.ts` (sweep), `revocation-rpc.test.ts`, `roles.test.ts`,
`services.test.ts` (reachability smoke), and `share.test.ts`.

## Residual limits

The measures serialize and wait — they do **not** fix product-side races: a
workflow iterating authorizations still 404s on a just-replaced/deleted
authorization (stale `ldp:contains` after `replaceDataAuthorizationsForGrantee`;
CSS SPARQL-backend `dcterms:modified` metadata corruption). Iterators
(`findAuthorizationsForAgent`, `dataAuthorizations`) have no 404/410 tolerance
yet.

The explicit **SPARQL cross-pod isolation** and **mirror-freshness** end-to-end
cases are still to be added; they are tracked in
[`pod-isolation-followup.md`](../../docs/plans/pod-isolation-followup.md).
