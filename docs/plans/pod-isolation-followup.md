# Pod isolation follow-up — mirror lifecycle, object lifecycle, cross-pod tests

> **Status:** 📋 not started. Extracted from the now-landed per-pod storage work
> (the former `isolated-s3-buckets`, `fuseki-per-pod-sparql`, and
> `isolated-datasets-and-sparql` plans are done and removed). The landed design
> is documented in the OpenWiki
> (`architecture/storage-isolation.md`, `architecture/federation.md`,
> `services/org-context.md`, `testing/integration-tests.md`). Production
> deployment/hardening is in [`update-deployment.md`](update-deployment.md).

## Context

Dev/test already runs one Fuseki dataset per registry/data pod (plus `id`),
`PodEndpointStore`, the routed SPARQL/S3 and hybrid accessors, the session/
context endpoint allowlist, `/sparql-admin` → the org's registry pod, per-pod
Garage buckets/keys, the account-bootstrap workflow, and active + serialized
reciprocal-mirror syncs. What remains is the **edge-case lifecycle** around
mirrors and object storage, plus the end-to-end isolation tests.

## A — Reciprocal mirror lifecycle

### A1. Live-registration backfill + drift scan

- The fixture is backfilled at seed time (`applyReciprocalMirrors` in
  `packages/test-utils/src/fuseki.ts`); there is no tool for existing
  deployments.
- Implement a **drift scan**: reciprocal-linked registrations whose mirror
  graph is missing or incomplete.
- Backfill each pair through `updateReciprocalMirror` (or the existing
  `syncReciprocalMirror` activity), idempotently; reuse the fixture splitter or
  a Temporal workflow.
- This is a prerequisite for the production cutover (`update-deployment.md`).
- **Staleness policy:** decide whether to re-poll on a webhook gap. The
  `reconcileActivities` sweep already re-drives a pending `delegatedGrantsUpdated`
  through the delegated-grants consumer, and that consumer syncs the mirror
  before regenerating (`openwiki/architecture/federation.md`) — so a *recorded but
  unprocessed* delivery self-heals once the sweep has a schedule. What remains
  here is the case with **no** pending activity: a delivery that never arrived,
  and pairs whose mirror was never written. The drift scan is that check.

### A2. Unregister mirror deletion

- `deleteReciprocalMirror` exists as an activity
  (`temporal/activities/reciprocal.ts`) but has **no workflow/caller**; there is
  no unregister flow today.
- When the unregister/removal flow lands, run the mirror deletion as one
  compensable Temporal step while the org's registration of the peer still
  exists (the reciprocal IRI is read from it); make it idempotent.

### A3. External admin endpoint discovery

- Add the org's admin/SPARQL endpoint to the agent-id discovery surface:
  a third `Link` header (candidate rel `hasSparqlEndpoint`) or a field in the
  agent-id document next to `hasDelegationIssuanceEndpoint` — **term/rel name is
  open**.
- `AgentIdHandler` serves it admin-only; the admin's AA resolves and caches it
  like `getRegistrySet`; `ResolvedContext` carries it for org-context reads.
- `/sparql-admin` stays the enforced gate; discovery only tells an external
  admin where the org's endpoint is.

## B — Object-plane lifecycle

### B1. S3 orphan reconciliation

- Reconcile `objectEndpoint` records against Garage buckets/keys: drop
  buckets/keys with no record and recreate records for existing buckets; run as
  an idempotent reconcile activity/job.
- Covers the `sai-dev`-era leftovers and interrupted account provisioning.

### B2. Account deletion cleanup

- No account-deletion flow exists today. When one lands, delete the data pod's
  bucket/key and its `objectEndpoint`/`sparqlEndpoint` records as part of the
  same compensable operation.

## C — Tests

- **SPARQL cross-pod isolation** (`/test`): an admin querying another owner's
  endpoint gets 403 by the gate; even at the caller's own endpoint, queries
  never see another pod's graphs; org-context flows stay green against per-pod
  stores.
- **Mirror freshness e2e**: peer update → webhook → `waitFor` → view reflects the
  change; unregister → mirror deleted.
- Backfill/drift-scan test (a reciprocal-linked registration with a missing
  mirror is detected and restored).
- S3 orphan reconciliation and account-deletion unit tests.

## D — Hardening

- **Named-graph patch guard:** `insertPatch`/`deletePatch` currently serialize a
  named-graph document to N-Quads, which Fuseki rejects inside
  `INSERT DATA`/`DELETE DATA` (4-term lines). No caller hits it today; normalize
  named graphs to `GRAPH <g> { … }` blocks or reject explicitly.
- (Fuseki/Garage internal auth, the Garage admin token boundary, and the
  `findSparqlByIri` full-scan optimization are in `update-deployment.md`.)

## Out of scope

- Production Nix/podman/OCI cutover, secrets/volumes, data/account migration,
  Fuseki/Garage auth hardening, and the endpoint-registry scan optimization —
  [`update-deployment.md`](update-deployment.md).
- Peer-instance **content** in org-context mirrors — mirrors cover registry
  metadata only today; revisit separately if content listing enters scope.
- npm publishing.

## Sequencing

1. **A1** backfill/drift scan (prerequisite for the production cutover).
2. **A3** external discovery and **A2** unregister deletion.
3. **C** cross-pod isolation + mirror-freshness tests.
4. **B** object lifecycle and **D** hardening can proceed in parallel.

## Gate

- Drift scan finds and restores a missing mirror; backfill is idempotent.
- Unregister removes the mirror; external admin discovery resolves the org
  endpoint without weakening `/sparql-admin`.
- Cross-pod isolation + mirror-freshness `/test` cases pass.
- S3 orphan reconciliation and account-deletion cleanup are idempotent and
  tested.
- Named-graph patch documents are normalized or rejected instead of producing
  Fuseki-invalid `INSERT DATA`.

## References

- OpenWiki: `architecture/storage-isolation.md`, `architecture/federation.md`,
  `services/org-context.md`, `testing/integration-tests.md`.
- Production cutover: [`update-deployment.md`](update-deployment.md).
