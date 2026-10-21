# Plans index

Status snapshot of the implementation plans in this directory, cross-checked
against the current codebase and git history. A plan's own `Status` header is the
primary source.

All **completed** implementation plans have been removed; their resulting design
is documented in the [OpenWiki](../openwiki/index.md). The `federation.md` and
`events.md` design notes were also absorbed into the OpenWiki
(`openwiki/architecture/federation.md` and the domain event catalogue in
`openwiki/services/activity-lifecycle.md`). The completed Turtle-removal plan is
also removed; its remaining `n3` phase is now `reconsider-n3-package.md`. The
three per-pod storage plans are **done and removed**; their landed design is in
`openwiki/architecture/storage-isolation.md` and
`openwiki/architecture/federation.md`, with remaining follow-ups in
`pod-isolation-followup.md`.

## Summary

| Status | Count | Plans |
|---|---|---|
| 🔶 partial | 1 | `revoke-delegation-chain` |
| ⬜ not started / design only | 13 | `authorization-revoked`, `authorization-revocation`, `check-equivalence`, `webhook-subscription-bootstrap`, `registry-set-permissions`, `components-tweaks`, `specific-instance-access-requests`, `generic-auditing`, `extract-temporal-workflows`, `update-deployment`, `pod-isolation-followup`, `reconsider-n3-package`, `npm-publishing` |
| ⬜ follow-up backlog | 1 | `revoke-delegation-chain-follow-ups` |

**15 plans total.**

## Full table

| Plan | Status | What it does | Depends on |
|---|---|---|---|
| `revoke-delegation-chain.md` | 🔶 partial — first cut (steps 1–5) landed | Revocation as a boundary operation at the delegation endpoint (`AccessRevocation`, all-or-nothing validation, requester hop, `RevokeGrants` RPC); replaces direct cross-peer DELETE | references `authorization-revoked` (deny-RPC precedent) |
| `authorization-revoked.md` | ⬜ not done (design only) | Producer writes the typed `authorizationRevoked` activity for deny; routing/consumer/sweep already handle the type | — |
| `authorization-revocation.md` | ⬜ not done (design only — deferred) | The authorization-revocation leg, extracted from the landed activity-first design (OpenWiki `services/activity-lifecycle.md`): UI revokes an **authorization** (never grants directly) → the `authorizationRevoked` producer → a workflow revokes the derived grants at the **issuance boundary with the org session** (fixes seeded-ACR 403) + clears the grantor's projection; decides whether the retired `grantsRevoked`/`processGrantsRevocation` wiring is revived | `authorization-revoked` (the typed producer); `revoke-delegation-chain` (+ its follow-ups — the boundary + `grantsRevoked` observability item) |
| `check-equivalence.md` | ⬜ not done (design only) | Real `checkEquivalence`: reuse equivalent existing grants (incl. child trees); workflow already fully wired, and `getExistingGrants` now returns IRIs only. **Prerequisite (§2.1):** replicate the grant bodies where we are `grantedBy` (onward delegated grants live on the data owner's registry) — equivalence compares body-only fields, so a peer read or IRI-only input is not enough | issuer-side replication (issuance echo or post-issuance store) |
| `reconsider-n3-package.md` | ⬜ decision needed — keep vs drop | Reconsider the remaining `n3` dependency: current Store/DataFactory footprint, the `ReciprocalMirror` N-Quads/GRAPH-block and TriG test/seed sites, options A/B/C, and a recommended partial drop | completed Turtle-removal work (OpenWiki `data-model/json-ld-layer.md`); `fetch-sparql-endpoint` keeps `n3` transitively |
| `pod-isolation-followup.md` | ⬜ not started | Remaining per-pod isolation edge cases: mirror backfill/drift scan, unregister mirror deletion, external admin endpoint discovery, S3 orphan/account-deletion cleanup, cross-pod/mirror-freshness tests, and the named-graph patch guard | landed per-pod storage code (OpenWiki `architecture/storage-isolation.md`); `update-deployment.md` for production |
| `webhook-subscription-bootstrap.md` | ⬜ not done (design only) | `ensureActivityWebhookChannel` at account creation + startup/periodic healing for real deployments (dev/test are pre-seeded) | — |
| `revoke-delegation-chain-follow-ups.md` | ⬜ all 9 items open | Items 1–9 of the revocation follow-up: full chain calculation, scope/mode-coverage ordering, replace-vs-delete race, grantor trigger integration (`grantsRevoked` producer), grantee self-revocation, error-detail schema, drop vestigial `delegationOfGrant`, sweep validation, `reconcileActivities` scheduling | `revoke-delegation-chain` (first cut) |
| `registry-set-permissions.md` | ⬜ not started (design) | Scope the blanket `#fullAdminAccess` per structural registry: per-container ACRs, GrantRegistry owner-only (admins never write grants; per-grant ACRs serve reads), ActivityRegistry Read + create/append (append-only immutable log) instead of blanket Write; seed ACR hygiene for the ACR-less yoyo DataGrants | `org-admin-feature` R1 |
| `components-tweaks.md` | ⬜ design only (investigation write-up) | Residual SAI domain/spec logic still in components after the reorganize phases: extract `SaiPermissionsEngine`'s grant-evaluation predicates (grant→request coverage, Inherited-chain resolution, admin modes) and the 4×-duplicated `hasAdminGrant` admin-marker rule to AA session methods/predicates; move the delegation-endpoint inheritance completion (`GrantIssuanceHandler`) and `buildAdminGrants` materialization to AA; plane-based session `findRegistration` | — |
| `update-deployment.md` | ⬜ not started | Production NixOS/Podman cutover to per-pod Fuseki + Garage, Node 26 source images, env/secrets/volumes, data/account migration, OCI/flake/hosts, deployed smoke test (folds in the former `production-consumer-cleanup` workstream) | landed per-pod storage code (OpenWiki `architecture/storage-isolation.md`); `pod-isolation-followup.md` mirror-backfill prerequisite |
| `npm-publishing.md` | ⬜ not started (future goal) | Move all packages to the `@hackers4peace` npm org and publish there (rename scopes, published artifact, release workflow); **not** a deployment prerequisite | the landed ESM/no-build groundwork (OpenWiki `architecture/overview.md`); see `update-deployment.md` for the source-build path |
| `extract-temporal-workflows.md` | ⬜ not started — blocked on a cycle decision | Move all Temporal code out of `packages/components` into a private `temporal-workflows` package and shrink `components` to Components.js-only; a `components ↔ temporal` dependency cycle needs option A/B/C resolved first | overlaps `components-tweaks.md` |
| `specific-instance-access-requests.md` | ⬜ not started (design only) | Access requests targeting specific data instances (`hasDataInstance` on `AccessNeed`); deferred from the granting work — no request-side caller yet | — |
| `generic-auditing.md` | ⬜ not started (design only) | A generic auditing mechanism for creation metadata (creator agent/client, creation/modification times), replacing the removed hand-written `interop:registeredBy`/`registeredWith`/`registeredAt`/`updatedAt` writes | — |

## Dependency graph

Read `→` as "depends on / builds on". All completed lineage plans have been
removed; the surviving plans are the open work items.

### Grant workflows & the activity outbox

```
revoke-delegation-chain 🔶 (403 → boundary revocation)
  └─ revoke-delegation-chain-follow-ups ⬜ (items 1–9)

authorization-revoked ⬜        (deny activity producer)
authorization-revocation ⬜     (depends on authorization-revoked + revoke-delegation-chain)
check-equivalence ⬜            (replaces the shipped checkEquivalence dummy)
webhook-subscription-bootstrap ⬜
```

### Org-admin workstream companion docs

`org-admin-feature.md` is the umbrella for the org-admin workstream (itself not
tracked in this index). The landed org-context read plane and the
`/.sai/proxy-admin` / `/sparql-admin` endpoints are documented in the OpenWiki
(`services/org-context.md`); the single-deployment/federation assumptions are
in `openwiki/architecture/federation.md`, and the domain event catalogue is in
`openwiki/services/activity-lifecycle.md`. The remaining companions:

- `registry-set-permissions.md` — ⬜ design; follow-up to `org-admin-feature` R1.
- `pod-isolation-followup.md` — ⬜ not started; mirror backfill/unregister,
  external admin-endpoint discovery, S3 orphan/account deletion, and the
  cross-pod/mirror-freshness tests. The landed per-pod storage design is in the
  OpenWiki (`architecture/storage-isolation.md`, `architecture/federation.md`).
- `update-deployment.md` — ⬜ not started; the production Nix/podman/OCI
  cutover, secrets/volumes, data migration, and Fuseki/Garage hardening.

### Independent / deferred

- `components-tweaks` — **unblocked**: follows the completed reorganize work
  (residual engine/admin-marker findings); component-side extraction only.
- `specific-instance-access-requests` — deferred granting scope; no
  request-side caller yet.
- `generic-auditing` — future creation-metadata mechanism; the removed writes
  had no readers.
- `reconsider-n3-package` — decision-only: `n3` is still used for `Store`/
  `DataFactory` and for the N-Quads/GRAPH-block + TriG seed/test sites; drop
  the mechanical runtime uses first (recommended) and decide separately on the
  parser/writer sites.
- `revoke-delegation-chain-follow-ups` — depends only on the landed first cut;
  internal ordering: 1 (chain calc) → 2 (coverage ordering) → 4 (trigger
  integration); 3 (replace-vs-delete race) is orthogonal; 8 → 9 (sweep
  validation then scheduling).
- `check-equivalence` — **unblocked**: `createGrantsForAgent` already consumes
  `reused`; only the activity needs a real implementation.
- `authorization-revoked` — **unblocked**: routing, per-target consumer and
  sweep already support the type; only `recordAuthorization` needs to write it.
- `webhook-subscription-bootstrap` — **unblocked**: builds on the landed
  ActivityRegistry module + `ActivityWebhookStore`/handler; runtime-only
  (dev/test are pre-seeded).
- `update-deployment` — production Nix/podman/OCI cutover; depends on the
  landed per-pod storage code and the `pod-isolation-followup` mirror-backfill
  prerequisite, not on the remaining design-only plans.
- `pod-isolation-followup` — mirrors/object lifecycle and cross-pod tests; the
  landed design is in the OpenWiki, not in a plan.

## Federation

The single-deployment shortcuts, the reciprocal-mirror role, and what must keep
working when servers split are documented in the OpenWiki
`architecture/federation.md`; the store split is in
`architecture/storage-isolation.md`, and the production/dev divergence in
`architecture/deployment-landscape.md`. Open plan work:
`pod-isolation-followup.md` (mirror backfill/unregister + cross-pod tests),
`webhook-subscription-bootstrap.md`, and `update-deployment.md` (production).

## Security

The enforcement boundaries themselves are documented in the OpenWiki:
`services/org-context.md` (`requireOrgAdmin`, `/.sai/proxy-admin`,
`/.sai/sparql-admin`), `architecture/storage-isolation.md` (endpoint allowlist,
fail-closed routing, endpoint-as-capability), and `architecture/federation.md`
(single-deployment shortcuts). Security-relevant plan work:
`pod-isolation-followup.md` (mirror single-writer, cross-owner isolation tests,
named-graph patch guard), `update-deployment.md` (Fuseki/Garage internal auth,
Garage admin token, `findSparqlByIri` scan), and `registry-set-permissions.md`
(ACR/ACP scoping per structural registry).

## Custom Community Solid Server (CSS) components

The Components.js package/build/wiring and override mechanics (including the
per-server notification config) are documented in the OpenWiki
`integrations/auxiliary-services.md`. This index only tracks the remaining CSS
plans:

### Custom CSS built-ins

The durable webhook emitter is implemented. `DurableWebhookEmitter` starts a
`deliverWebhook` workflow on the dedicated `webhook-delivery` queue and falls
back to a direct POST when the enqueue fails. The NDJSON streaming stack is
also landed (OpenWiki `services/activity-lifecycle.md`). No CSS built-in
override plans remain.

### Extend the CSS config with custom "sai" components (already shipped; not overrides)

| Plan | Custom components added |
|---|---|
| `revoke-delegation-chain.md` 🔶 | `GrantRevocationHandler` + `AccessRevocation` dispatch on the delegation endpoint (`GrantIssuanceRouter`), and the `RevokeGrants` RPC (`services/Revocation.ts` via `ApiHandler`) |
| `webhook-subscription-bootstrap.md` ⬜ | Reuses the existing `ActivityWebhookStore` + the **stock** CSS notification API (`SubscriptionClient` → `WebhookChannel2023`, kv-backed `KeyValueChannelStorage`) — no new components |

### No CSS components needed

Everything else — `authorization-revoked`, `check-equivalence`,
`revoke-delegation-chain-follow-ups`, `components-tweaks`,
`specific-instance-access-requests`, `generic-auditing` — runs in the Temporal
worker, the services layer, or data-model; they neither override nor extend the
CSS server configuration.
