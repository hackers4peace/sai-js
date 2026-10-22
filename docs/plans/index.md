# Plans index

Status snapshot of the implementation plans in this directory, cross-checked
against the current codebase and git history. A plan's own `Status` header is the
primary source.

**Start here:** [CONVENTIONS.md](CONVENTIONS.md) — status vocabulary, required
headers, the ground-truth rule, capability slices, green gates, and the session
protocol. All plans follow it.

Completed implementation plans are normally removed and their resulting design
documented in the [OpenWiki](../../openwiki/index.md). The **closed revocation
workstream** (C0–C5, decisions D1–D21) is done and removed; its landed design is
in `openwiki/architecture/authorization-revocation.md`, and the remaining
replication polish is `grants-replication-polish.md`. The `federation.md` and
`events.md` design notes were absorbed into the OpenWiki
(`openwiki/architecture/federation.md` and the domain event catalogue in
`openwiki/services/activity-lifecycle.md`). The completed Turtle-removal plan is
also removed; its remaining `n3` phase is now `reconsider-n3-package.md`. The
three per-pod storage plans are **done and removed**; their landed design is in
`openwiki/architecture/storage-isolation.md` and
`openwiki/architecture/federation.md`, with remaining follow-ups in
`pod-isolation-followup.md`. The grant-reuse work is **done and removed**; its
landed design (tree equivalence, the issuer-side grant replica, the value-based
workflow result) is in `openwiki/architecture/grant-reuse.md`, with the
remaining replica-cleanup/backfill follow-ups in the OpenWiki revocation
design (`openwiki/architecture/authorization-revocation.md`) and
`pod-isolation-followup.md` A1.

The former revocation follow-up file, `authorization-revoked.md`, and the
closed workstream/detailed-design records were all **absorbed** into the
OpenWiki (`openwiki/architecture/authorization-revocation.md`); every source
file was deleted. The post-workstream follow-ups are in
`grants-replication-polish.md`.

## Summary

| Status | Count | Plans |
|---|---|---|
| 🔶 in progress / design ready | 0 | — |
| ⬜ not started / design only | 11 | `grants-replication-polish`, `webhook-subscription-bootstrap`, `registry-set-permissions`, `components-tweaks`, `specific-instance-access-requests`, `generic-auditing`, `extract-temporal-workflows`, `update-deployment`, `pod-isolation-followup`, `reconsider-n3-package`, `npm-publishing` |
| 🧭 umbrella | 1 | `org-admin-feature` |
| 📝 design notes | 3 | `architecture`, `fixes`, `improve-fetch-json-ld` |

**15 plan files** (+ `index.md` and `CONVENTIONS.md`).

## Workstreams

### Revocation — closed, one polish plan left

The closed workstream (C0–C5, decisions D1–D21) is **done and removed**; its
landed design — source-of-truth authorizations, grant projections, the chain
closure, the `AccessRevocation` boundary, and the sweep backstop — is in
`openwiki/architecture/authorization-revocation.md`. One follow-up plan remains:

- **`grants-replication-polish.md`** ⬜ — the four post-workstream items:
  peer-side orphan scan, stranded `AuthorizationRevoked` end-state,
  role-grantee projection verification, remaining tests.

Ladder (historical capability slices, not layers):

```
C0 ✅ authorization view (read-only)
C1 ✅ chain validity + coverage
C2 ✅ authorization revocation end-to-end
C3 ✅ reconciliation for every trigger (landed with C2)
C4 ✅ typed errors + owner projection cleanup (self-revocation removed — D17)
C5 ✅ sweep backstop (runtime; scheduling in update-deployment §F)
```

**C0–C5 are landed** (package-tested; `/test` acceptance confirmed — dagger
green 2026-10-21). The workstream is closed; batch validation is out of scope
(D21). Remaining replication polish is in `grants-replication-polish.md`.

### Org-admin workstream companion docs

`org-admin-feature.md` is the umbrella for the org-admin workstream (itself not
tracked in the summary count). The landed org-context read plane and the
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

### Federation / deployment

- `webhook-subscription-bootstrap.md` — ⬜ design; channel bootstrap + healing
  for real deployments (dev/test are pre-seeded). The per-account schedules
  live in `update-deployment.md` §F.
- `update-deployment.md` — ⬜ not started; production cutover, depends on the
  landed per-pod storage code and the `pod-isolation-followup` mirror-backfill
  prerequisite.
- `pod-isolation-followup.md` — ⬜ not started; mirrors/object lifecycle and
  cross-pod tests.

## Full table

| Plan | Status | What it does | Depends on |
|---|---|---|---|
| `grants-replication-polish.md` | ⬜ not started (design ready) | Post-workstream replication polish: peer-side orphan scan (issuer-side replica), stranded `AuthorizationRevoked` end-state, role-grantee projection verification, remaining tests | closed C0–C5 workstream (OpenWiki `architecture/authorization-revocation.md`); `update-deployment.md` §F for schedules; OpenWiki federation/grant-reuse |
| `reconsider-n3-package.md` | ⬜ decision needed — keep vs drop | Reconsider the remaining `n3` dependency: Store/DataFactory footprint, `ReciprocalMirror` N-Quads/GRAPH-block and TriG test/seed sites, options A/B/C, recommended partial drop | completed Turtle-removal work (OpenWiki `data-model/json-ld-layer.md`); `fetch-sparql-endpoint` keeps `n3` transitively |
| `pod-isolation-followup.md` | ⬜ not started | Remaining per-pod isolation edge cases: mirror backfill/drift scan, unregister mirror deletion, external admin endpoint discovery, S3 orphan/account-deletion cleanup, cross-pod/mirror-freshness tests, named-graph patch guard | landed per-pod storage code (OpenWiki `architecture/storage-isolation.md`); `update-deployment.md` for production |
| `webhook-subscription-bootstrap.md` | ⬜ not done (design only) | `ensureActivityWebhookChannel` at account creation + startup/periodic healing for real deployments; admin/org channels | — |
| `registry-set-permissions.md` | ⬜ not started (design) | Scope the blanket `#fullAdminAccess` per structural registry: per-container ACRs, GrantRegistry owner-only (admins never write grants; per-grant ACRs serve reads), ActivityRegistry Read + create/append instead of blanket Write; seed ACR hygiene for the ACR-less yoyo DataGrants | `org-admin-feature` R1 |
| `components-tweaks.md` | ⬜ design only (investigation write-up) | Residual SAI domain/spec logic still in components after the reorganize phases: extract `SaiPermissionsEngine`'s grant-evaluation predicates and the 4×-duplicated `hasAdminGrant` admin-marker rule to AA session methods/predicates; move the delegation-endpoint inheritance completion and `buildAdminGrants` materialization to AA; plane-based session `findRegistration` | — |
| `update-deployment.md` | ⬜ not started | Production NixOS/Podman cutover to per-pod Fuseki + Garage, Node 26 source images, env/secrets/volumes, data/account migration, OCI/flake/hosts, deployed smoke test; **workstream F**: scheduled reconciliation (C5 runtime) + activity-webhook channel healing | landed per-pod storage code; `pod-isolation-followup.md` mirror-backfill prerequisite; `grants-replication-polish.md` (remaining C5 polish) + `webhook-subscription-bootstrap.md` |
| `npm-publishing.md` | ⬜ not started (future goal) | Move all packages to the `@hackers4peace` npm org and publish there (rename scopes, published artifact, release workflow); **not** a deployment prerequisite | landed ESM/no-build groundwork; `update-deployment.md` for the source-build path |
| `extract-temporal-workflows.md` | ⬜ not started — blocked on a cycle decision | Move all Temporal code out of `packages/components` into a private `temporal-workflows` package and shrink `components` to Components.js-only; a `components ↔ temporal` dependency cycle needs option A/B/C resolved first | overlaps `components-tweaks.md` |
| `specific-instance-access-requests.md` | ⬜ not started (design only) | Access requests targeting specific data instances (`hasDataInstance` on `AccessNeed`); deferred from the granting work — no request-side caller yet | — |
| `generic-auditing.md` | ⬜ not started (design only) | A generic auditing mechanism for creation metadata (creator agent/client, creation/modification times), replacing the removed hand-written `interop:registeredBy`/`registeredWith`/`registeredAt`/`updatedAt` writes | — |
| `org-admin-feature.md` | 🧭 umbrella | Org-admin workstream: admin markers, org context, admin grants, `AddAdmin`/`RemoveAdmin`, event catalogue references. Not a single shippable plan | landed org-context + admin code; OpenWiki `services/org-context.md` |
| `architecture.md` | 📝 design note — decided | The architectural principle: thin services/handlers, workflow-orchestrated, domain logic in `authorization-agent` | OpenWiki `services/activity-lifecycle.md`, `services/rpc-and-services.md` |
| `fixes.md` | 📝 design note — not implemented | Remove the HTTP list-and-scan invitation lookup in `agent-registry.ts`; route the duplicate check through the SPARQL `fetchSocialAgentInvitation` | — |
| `improve-fetch-json-ld.md` | 📝 design note — decision deferred | `fetchJsonLd` status-carrying error instead of regex-matching the message; options evaluated, not implemented | — |

## Dependency graph

Read `→` as "depends on / builds on". Completed lineage plans are removed; the
surviving plans are the open work items.

### Revocation (closed C0–C5)

```
closed workstream C0–C5 ✅ (OpenWiki architecture/authorization-revocation.md)
  └─ grants-replication-polish ⬜ (orphan scan, stranded, role grantees, tests)
```

The C2 producer, workflow, carrier, and UI are landed; C4's typed revocation
failures and owner-projection cleanup are landed; C5's local drift + mirror
runtime is landed. Grantee self-revocation was removed (D17); batch validation
is out of scope (D21). The remaining polish is `grants-replication-polish.md`;
`scheduling` is `update-deployment.md` §F. `grantsRevoked` /
`processGrantsRevocation` stay retired.

### Grant workflows & the activity outbox

```
C2 authorization revocation (AuthorizationRevoked producer/workflow) ✅
  └─ C3 reconciliation for every trigger (reuse/replace/revoke, requester hop) ✅
       └─ C5 sweep backstop (local drift/mirror) ✅
            └─ grants-replication-polish ⬜ (orphan scan, stranded, role grantees, tests)

update-deployment §F ⬜ (schedules/cadence) + webhook-subscription-bootstrap ⬜ (channel healing)
```

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
- `update-deployment` — production Nix/podman/OCI cutover; depends on the
  landed per-pod storage code and the `pod-isolation-followup` mirror-backfill
  prerequisite, not on the remaining design-only plans.
- `pod-isolation-followup` — mirrors/object lifecycle and cross-pod tests; the
  landed design is in the OpenWiki, not in a plan.
- `fixes` / `improve-fetch-json-ld` — small design notes, not on a workstream
  ladder.

## Federation

The single-deployment shortcuts, the reciprocal-mirror role, and what must keep
working when servers split are documented in the OpenWiki
`architecture/federation.md`; the store split is in
`architecture/storage-isolation.md`, and the production/dev divergence in
`architecture/deployment-landscape.md`. Open plan work:
`pod-isolation-followup.md` (mirror backfill/unregister + cross-pod tests),
`webhook-subscription-bootstrap.md` (channels), and `update-deployment.md`
(production, including the schedules in §F).

## Security

The enforcement boundaries themselves are documented in the OpenWiki:
`services/org-context.md` (`requireOrgAdmin`, `/.sai/proxy-admin`,
`/.sai/sparql-admin`), `architecture/storage-isolation.md` (endpoint allowlist,
fail-closed routing, endpoint-as-capability), and `architecture/federation.md`
(single-deployment shortcuts), and
`architecture/authorization-revocation.md` (revocation, typed errors, grant
ACRs, sweep). Security-relevant plan work:
`pod-isolation-followup.md`
(mirror single-writer, cross-owner isolation tests, named-graph patch guard),
`update-deployment.md` (Fuseki/Garage internal auth, Garage admin token,
`findSparqlByIri` scan), and `registry-set-permissions.md` (ACR/ACP scoping per
structural registry).

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
| `webhook-subscription-bootstrap.md` ⬜ | Reuses the existing `ActivityWebhookStore` + the **stock** CSS notification API (`SubscriptionClient` → `WebhookChannel2023`, kv-backed `KeyValueChannelStorage`) — no new components |

### No CSS components needed

Everything else — revocation (OpenWiki `architecture/authorization-revocation.md`),
`components-tweaks`,
`specific-instance-access-requests`, `generic-auditing`, `fixes`,
`improve-fetch-json-ld` — runs in the Temporal worker, the services layer, the
authorization-agent, the data model, or the UI; they neither override nor extend
the CSS server configuration.
