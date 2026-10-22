# SAI architecture — thin services/handlers, workflow-orchestrated, domain logic in `authorization-agent`

> **Status: design — decided (2026-09).** The architectural principle the
> activity-first refactors (now documented in the OpenWiki
> `services/activity-lifecycle.md` and `services/rpc-and-services.md`; the
> former `authorization-granting.md` was removed once its design landed there)
> follow. Companion to the OpenWiki `services/activity-lifecycle.md` (the
> activity catalogue and wire contract).

## 1. Principle (decided)

1. **`packages/components` services + HTTP handlers are thin.** They read,
   validate, gate the context, and **write the activity** — nothing else. They
   never mutate registries and never implement a SAI rule.
2. **Temporal workflows are the only place that materializes state** — a
   durable, retried, idempotent run as the context/org session
   (`getSession(webId)`, `workers/main.ts`).
3. **All SAI spec/domain logic lives in `packages/authorization-agent`**
   (pure data types in `packages/data-model`). Workflows call the AA; the AA
   never calls workflows.

Rationale: RPC sessions are credential-limited and short-lived; workflow
sessions are the org owner with full authority and get durability/idempotency
for free. Moving mutation into workflows also fixes the org-context ACR 403
debt (an admin's UAS cannot PATCH seeded closures; the org session can).

## 2. Layering (rules)

| Layer | Owns | Never does |
|---|---|---|
| `packages/data-model` | data types (activities, registries, grants, authorizations, need groups), `dataModelContext` + JSON-LD framing | logic beyond framing |
| `packages/authorization-agent` | **all SAI rules**: structure → `DataAuthorization` building (`buildNestedDataAuthorizations`), scope semantics (`matchesScope`), recording/generation (`generateAuthorization`, `recordAuthorizationFromStructure`), share formatting (`shareDataInstance`/`formatAuthorization`), grant generation (`grant-generation.ts`), registry CRUD | HTTP, webhooks, RPC, Temporal |
| `components` **services** | RPC adapters (message ↔ structure mapping), reads (SPARQL `queries/org.ts`), validation reads, context gating, **activity writing** | mutation, SAI rules |
| `components` **HTTP handlers** | protocol endpoints (`InvitationHandler`, `GrantIssuanceHandler`, `ReciprocalWebhookHandler`, events) — authenticate + write the activity | domain rules |
| `components` **temporal** | orchestration only: per-class dispatch, mint sessions (`getSession(webId)`), call AA methods, completions (`markActivitiesDone`) | SAI rules beyond sequencing |

**The "roll-up" test** — a code-level invariant:
- every registry mutation call (`recordAuthorizationFromStructure`,
  `shareDataInstance`, `generateAuthorization`, PUT/DELETE of registries/grants/
  ACRs) appears **only** in `components/src/temporal/**` (or in
  `authorization-agent` itself);
- services `createActivity` only.

## 3. Current state (inventory — as-is)

| Concern | Today |
|---|---|
| structure → DataAuthorization rules | ✅ `authorization-agent/src/authorization.ts` |
| scope semantics | ✅ `authorization-agent/src/authorization.ts` `matchesScope` |
| share formatting | ✅ `authorization-agent/src/authorization-agent.ts` `formatAuthorization` (private) |
| grant generation | ✅ `authorization-agent/src/grant-generation.ts` |
| session method `recordAuthorizationFromStructure` | ✅ `authorization-agent/src/authorization-agent.ts` |
| synchronously materialized by services | ❌ `services/Authorization.ts` `recordAuthorization` and `services/ShareResource.ts` `shareResource` call the AA **in the RPC** and write the activity after (thick) |
| read-side rule `agentsWithAccessMatching` | ⚠️ in `services/ShareResource.ts` (re-exports AA `matchesScope`) — a rule in the wrong layer |
| activity decode / completions | ⚠️ `temporal/activities/grants.ts` (`markActivitiesDone`) — registry CRUD that could be AA methods |
| orchestration | ✅ `temporal/workflows/*` dispatching per class |

Target: move the ⚠️ rows to their layer as the activity-first steps land;
delete the ❌ row by making the granting leg activity-first (§4).

## 4. Decision — one dedicated workflow per activity class

For the granting/revoke pair, **dedicated workflows** (not the coalescing
per-grantee consumer):

- `processAuthorizationGranted` — materialize the embedded
  `DataAuthorizationData`(s) at the pre-minted ids (find-first, as
  `getSession(ctx.webId)`) → regenerate grants → single `ActivityCompleted`.
- `processAuthorizationRevoked` — symmetric (revocation plan).
- Rationale: matches the one-workflow-per-class convention (`createRole`,
  `processRoleMembershipChange`, `processAdminAuthorizationGranted`,
  `createInvitation`, `processNeedBasedAccessRequest*`); keeps services
  thin (no mutation at all); regeneration stays in one module. The per-grantee
  consumer's fate (retire vs keep as regenerator) is an open item (§6).

## 5. Compliance checklist for new steps (the invariants)

For every activity-first step (from the design now documented in the OpenWiki
`services/activity-lifecycle.md`, tightened):

- [ ] **data-model** — types + context rows for the class; **no logic**.
- [ ] **authorization-agent** — the SAI rule (if any) lands here, with a
  session method or static export; unit-tested here.
- [ ] **service** — context gate + validation reads + `createActivity` only;
  pending ack echoing the minted id + `activityId`.
- [ ] **workflow** — signature `(webId, object-pojo, activity ref)`;
  materialize at the minted id find-first; derive from the object; single
  completion; bundled on `create-grants`; `reconcileActivities` branch.
- [ ] **handler** — one dispatch branch per class (schema-decode +
  `client.workflow.start`); forward-before-dispatch unchanged.
- [ ] **UI** — activity label + done-row refresh.
- [ ] **docs** — OpenWiki `services/activity-lifecycle.md` rows, c4 view.
- [ ] **tests** — packages vitest (agent-run) + `/test` wait-for (user-run).

## 6. Open items (current-plan scope)

1. Regeneration shape of `processAuthorizationGranted` — self-contained
   (materialize → `executeChild(createGrantsForAgent)` → completion) vs
   materialize-only + signal the consumer. Lean: self-contained.
2. ~~Deny/revoke sequencing~~ — **DECIDED (c)**: decline only. The UI's
   `granted:false` becomes a pure `AuthorizationDenied` (the delete was
   accidental); no revoke producer in the granting plan. The revocation leg
   landed separately with C2 — see
   [`architecture/authorization-revocation.md`](../../openwiki/architecture/authorization-revocation.md).

## 7. Follow-ups — principle conformance (decide per case, as we reach them)

Candidates that would conform better to §1 but are **not** in scope for the
current steps. Each is discussed and decided when a concrete change arrives;
no change happens on the basis of this list alone.

1. ~~**Retire the per-grantee consumer** for the authorization pair~~ —
   **done in C2**: `processGranteeActivities`, `granteeActivitiesSignal`,
   `getPendingGranteeActivities`, `resolveActivityGrantee` and the
   start-or-signal branch were removed; `AuthorizationRevoked` carries refs +
   `grantee` and runs the dedicated `processAuthorizationRevoked` workflow.
2. **Move registry CRUD helpers out of components into `authorization-agent`:**
   `markActivitiesDone` + the completion partition in `getPendingActivities`,
   `replaceDataGrantsOnRegistration`, `storeGrantAndAcr`, and the C2/C3 GC
   activities (`revokeGrantClosure`, `getRegistryGrantsForGrantee`,
   `dropGrantReplicas`). (`getGrantees` already delegates to the AA session.)
3. **Move the read-side rule `agentsWithAccessMatching`** from
   `services/ShareResource.ts:40-60` into `authorization-agent` — it is a rule
   (uses AA `matchesScope`), not transport.
4. **Domain call sites** — whether a service may *invoke* AA rules to build
   the embedded carrier (e.g. `buildNestedDataAuthorizations`) and which AA
   surface the workflow needs to record pre-built DataAuthorizations at
   pre-minted ids. Decide on the concrete example when it arrives.
   **TODO (current step, Step 2):** move the embedded-node →
   `DataAuthorizationData` normalization (`dataAuthorizationFromNode` in
   `authorization-agent/src/activity-registry.ts`) into data-model — it
   duplicates the private `compactNodeToDataAuthorizationData` in
   `data-model/src/data-authorization.ts`; export a `fromNode` there and
   reuse it from the `AuthorizationGranted` decode case.
   **✅ DONE:** `compactNodeToDataAuthorizationData` is now exported from
   `data-model/src/data-authorization.ts` (+ index re-export) and hardened to
   unwrap nodes embedded in the same document (the activity POJO form);
   `activity-registry.ts` imports it — the local copy is deleted.
5. **Transport reads** (`services/queries/org.ts` SPARQL) — stay in
   components as thin queries; revisit per case.
6. **Retire the synchronous `shareDataInstance` session method** — after the
   `shareResource` unification (Step 3) it has no prod caller; only the AA
   unit test (`authorization-agent.test.ts` `describe('shareDataInstance')`)
   keeps it. Decide when the sync granting path is fully gone.
7. **Retire the synchronous `recordAuthorizationFromStructure` session method**
   (`authorization-agent/src/authorization-agent.ts`) — after Step 4 no prod
   caller exists in components (granting is the activity-first workflow;
   declines are `AuthorizationDenied`); only docs and the data-model
   structures reference it. Decide when the sync authorization path is fully
   gone (it also owns the accidental-delete deny behavior — keep it out of
   reach until the revocation action lands).