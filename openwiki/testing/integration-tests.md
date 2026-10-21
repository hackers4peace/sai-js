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
  - id: openwiki-source-8550437c8cb83e5ccf36217b
    resource: repo://packages/authorization-agent/test/get-reciprocal-grants.test.ts
  - id: openwiki-source-e00ad90a057384916ebd690e
    resource: repo://packages/authorization-agent/test/grant-generation.test.ts
  - id: openwiki-source-5f0cad26b57bfa61e0dea5c4
    resource: repo://packages/authorization-agent/test/registration-links.test.ts
  - id: openwiki-source-bc6348a5e5c2ba0a1275d82e
    resource: repo://packages/components/src/temporal/activities/webhook-delivery.ts
  - id: openwiki-source-4b9eeba4dd0aabcf86743edc
    resource: repo://packages/components/src/temporal/workflows/webhook-delivery.ts
  - id: openwiki-source-7ec61beaaf8b2a6cc1791916
    resource: repo://packages/components/test/check-equivalence-activity.test.ts
  - id: openwiki-source-88e59fc8baf4f02379e91f1d
    resource: repo://packages/components/test/check-equivalence.test.ts
  - id: openwiki-source-9b409abe21ade962fb73ed30
    resource: repo://packages/components/test/delegated-grants.test.ts
  - id: openwiki-source-7cee32971e9a12bcc4227ff9
    resource: repo://packages/components/test/delegation-request.test.ts
  - id: openwiki-source-23684c4afa0b096bb7c0aa5d
    resource: repo://packages/components/test/durable-webhook-emitter.test.ts
  - id: openwiki-source-d86eb75db262e88d8237c824
    resource: repo://packages/components/test/grants-workflow.test.ts
  - id: openwiki-source-015d2f3faf2ecfac16eafb8e
    resource: repo://packages/components/test/reciprocal-mirror.test.ts
  - id: openwiki-source-c4ce6c0448c661ad179c011a
    resource: repo://packages/components/test/reciprocal-sync.test.ts
  - id: openwiki-source-81028398d49b5413dde247f1
    resource: repo://packages/test-utils/src/fuseki.ts
  - id: openwiki-source-900a2d8c960b090aaf5dc614
    resource: repo://temporal/dynamicconfig/development-sql.yaml
  - id: openwiki-source-825c895ab72bea7eb33edb2e
    resource: repo://test/check-equivalence.test.ts
  - id: openwiki-source-72256836fb28a2c54e04cb89
    resource: repo://test/federation-mirror.test.ts
  - id: openwiki-source-1bc7541f22daab19be8ab8ba
    resource: repo://test/invitation.test.ts
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
generated: { by: "pi", at: "2026-10-21T17:33:35.590Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-21T17:33:35.590Z
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
seed time (`applyReciprocalMirrors`): for every pod whose registration graph
carries a `reciprocalRegistration` link it copies the peer's registration and
the grants linked from it into that pod's dataset. That models a **federation
that already exists and has been backfilled** — no invitation flow ever runs
for the seeded pairs, so nothing at runtime would create those mirrors and
removing the backfill would make every reciprocal read fail for fixture
reasons. It is fixture state, not a runtime replication path: runtime initial
replication is asserted separately by the invitation tests (see
[`architecture/federation.md`](../architecture/federation.md#the-reciprocal-mirror-in-detail)).
Note that it copies only `hasDataGrant` targets — children only when the
registration links them (the seed's acme → alice registration links only the
parent) — and does not synthesise parent links; a parent body may still carry
reverse `inheritsFromGrant` edges. Seeded **delegated child** generation is
therefore not exercised; source-tree reuse reads the grantor's own registry,
where the child body is present.

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

The black-box suite does **not** read replica graphs while asserting a product
outcome. `roles.test.ts` and `share.test.ts` assert instead on the authoritative
sides: the grantor's own registration links the grant (local), the grant body is
read with the **data owner's** session (the grantor for source grants, the peer
owner for delegated ones — where the authoritative copy lives), and the
grantee-facing result comes from `ListDataRegistries` with the grantee's context
(the RPC behind the UI's "data of <peer> that I can see" view). That RPC is
served from the grantee's replica, so it is polled with `waitFor`: replication is
webhook-driven and can lag the barrier's registration `Update`.

`test/util.ts` also exposes `localMirror(session, peerId)` — it resolves the
peer's registration of `session.webId` through the reading side's own SPARQL
plane, so a missing replica fails with `Node <iri> not found in framed output` —
and `rpcCall(payload, cookie)`, which unwraps the Effect RPC envelope (200 +
`Success`) so assertions go through the public surface.

## The one replica-reading file

`federation-mirror.test.ts` is the only file that reads replica graphs directly,
because the replication contract ("the grantee's local copy of the peer's
registration and of every grant linked from it is present and current") has no
product surface of its own — a missing replica only shows up later as a
wrong/empty view. It asserts that a seeded pair starts with a complete replica
(every linked grant body resolves) and that a grant write converges the replica
to the peer's authoritative link set, with the grant semantics the delegation
path needs (`hasDataInstance`, `scopeOfGrant`, `accessMode`). No test writes a
mirror.

The invitation suite additionally asserts both legs of a **runtime-created** pair
(no seeded relationship) are mirrored once their completion activity is done —
the runtime counterpart to the fixture backfill.

No test writes the reciprocal mirror. The grant-reuse end-to-end test does
trigger the real issuance path, which writes the separate **issuer-side grant
replica**; that replica is read only through the equivalence activity and is
not asserted directly.

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

## Package-level replication tests

These run under `npm test` (vitest projects under `packages/*`) and may mock;
the black-box `/test` suite may not.

- `packages/components/test/delegated-grants.test.ts` mocks
  `@temporalio/workflow` and asserts the consumer's contract: the exact order
  replicate → regenerate → complete, the mirror child carrying the
  `reciprocal-registration` task queue and the consumer payload,
  `updateDelegatedGrants` receiving no `activityId`, burst coalescing into one
  pass, a mid-flight signal re-draining with a fresh mirror, the idle no-op, the
  reconcile arm starting the same consumer without completing the activity
  itself, and the **terminal** case (a `peerGone` mirror result completes the
  batch with no regeneration).
- `packages/components/test/reciprocal-sync.test.ts` pins the failure
  classification of `syncReciprocalMirror` against a stubbed session and service:
  `404`/`410` **on the reciprocal** drops the replica and returns `peerGone`;
  a `404` on a *linked grant* stays retryable and keeps the replica;
  `401`/`403`/`500`/network reject; a registration without a reciprocal link is
  a no-op.
- `packages/components/test/delegation-request.test.ts` asserts that
  `requestDelegations` sends one `interop:AccessRequest` POST per data-owner
  group, parses the echoed finalised grants, writes the issuer-side replica
  (one named graph per grant, parent reverse child edge, best effort on
  failure) and returns every assigned IRI; it also no-ops on an empty group,
  rejects a mixed `dataOwner` batch, surfaces a non-200, and rejects a
  malformed response without writing a partial replica.
- `packages/components/test/check-equivalence.test.ts` covers the pure
  comparison: field equality and set normalization, ignored ids/derived links,
  flat and embedded tree builders (order, n-depth, missing child, orphan,
  mismatched parent), subtree equality, and greedy one-to-one pairing with the
  child correspondence.
- `packages/components/test/check-equivalence-activity.test.ts` covers the
  activity's local-only body loading, source and delegated subtree reuse,
  missing delegated child → fail closed, source/delegated pools paired
  independently, and delegated index addressing.
- `packages/components/test/grants-workflow.test.ts` pins the value-based
  workflow contract: a non-empty result skips storing/requesting and re-links
  every reused IRI (parents + children) in the full-set registration PATCH.
- `packages/authorization-agent/test/registration-links.test.ts` covers the
  one-query link reads: `hasAdminGrant` presence from the resource graph and its
  `meta:` twin, and `getLinkedGrantOwners` returning the distinct owners behind
  the linked grants (skipping links without bodies).
- `packages/authorization-agent/test/get-reciprocal-grants.test.ts` pins the
  batched grantee-side read: the link set from the `meta:` twin plus every body in
  exactly two queries, links without bodies skipped, the reverse
  `inheritsFromGrant` edge surfacing as `hasInheritingGrant`, and no body query
  when nothing is linked.
- `packages/components/test/reciprocal-mirror.test.ts` mocks
  `fetch-sparql-endpoint` and drives `updateReciprocalMirror` /
  `deleteReciprocalMirror` against a scripted mirror. It asserts the oracle
  reads both the resource graph and its `meta:` twin, that a linked-but-absent
  grant body is re-fetched while present ones are skipped, that the newly
  linked grant is fetched, and that drops cover the `meta:` twins.
- `packages/authorization-agent/test/grant-generation.test.ts` serves a
  mirror-only fake transport and a `deps.fetch` stub that throws on any call,
  so it proves delegated-grant generation never dereferences a peer. It also
  pins the peer-side read count per regeneration, the field carry-over and
  shape-tree matching, both `MirrorIncompleteError` kinds (registration and
  grant), the child-grant delegation through the parent's reverse
  `inheritsFromGrant` edge, and that registration bodies are found in `meta:`
  graphs.

## Coverage

Each `/test` file verifies one protocol surface: `access-request.test.ts` (need-based
requests), `account-creation.test.ts` (bootstrap workflow provisioning),
`admin-events.test.ts` (org-admin activity forwarding),
`agent-discovery.test.ts` / `discovery.test.ts` (Link-header discovery),
`agents.test.ts`, `authorization.test.ts` (authorization + approval),
`check-equivalence.test.ts` (two-run identical IRIs for source and delegated
grants), `delegation-endpoint.test.ts` (issuance echo/revocation),
`federation-mirror.test.ts` (replica contents, the only replica-reading file),
`invitation.test.ts` (personal + org invitation), `key-scoping.test.ts`,
`org-context.test.ts` (admin org context + proxy/sparql-admin),
`personal-admin.test.ts` (AddAdmin/RemoveAdmin + ACR),
`policy-engine.test.ts` (WAC/ACP matrix), `reciprocal-webhook.test.ts`,
`reconciliation.test.ts` (sweep + seed subtree reuse), `revocation-rpc.test.ts`,
`roles.test.ts`, `services.test.ts` (reachability smoke), and `share.test.ts`.

## Residual limits

The measures serialize and wait — they do **not** fix product-side races: a
workflow iterating authorizations still 404s on a just-replaced/deleted
authorization (stale `ldp:contains` after `replaceDataAuthorizationsForGrantee`;
CSS SPARQL-backend `dcterms:modified` metadata corruption). Iterators
(`findAuthorizationsForAgent`, `dataAuthorizations`) have no 404/410 tolerance
yet.

The explicit **SPARQL cross-pod isolation** and **mirror-freshness** end-to-end
cases are still to be added; they are tracked in
[`pod-isolation-followup.md`](../../docs/plans/pod-isolation-followup.md). The
mirror-freshness case can lean on the consumer's ordering: `done` on a
`DelegatedGrantsUpdated` activity now implies the mirror write happened, so an
assertion after the barrier needs no extra polling.
