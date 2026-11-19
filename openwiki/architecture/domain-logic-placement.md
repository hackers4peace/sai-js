---
type: architecture
title: Domain-logic placement
description: The thin-services and workflow-orchestrated architecture — component services write activities, Temporal workflows materialize state, the authorization-agent owns SAI rules, and the residual code that still breaks that boundary.
tags: [architecture, layering, authorization-agent, temporal, refactoring]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-831634a2eec2dfc668cfae29
    resource: repo://packages/authorization-agent/src/authorization-agent.ts
  - id: openwiki-source-a53c5361cefa789231b20bc0
    resource: repo://packages/authorization-agent/src/authorization.ts
  - id: openwiki-source-0531e8ebff475ca0a556fc29
    resource: repo://packages/authorization-agent/src/grant-generation.ts
  - id: openwiki-source-7b94b7d1bbbc76b34b554505
    resource: repo://packages/components/src/AgentIdHandler.ts
  - id: openwiki-source-92862eeddb750415b0a0a89f
    resource: repo://packages/components/src/ApiHandler.ts
  - id: openwiki-source-9cd6e2280365d84a6828353d
    resource: repo://packages/components/src/SaiPermissionsEngine.ts
  - id: openwiki-source-d1409b74f54faf54952386b2
    resource: repo://packages/components/src/services/adminGate.ts
  - id: openwiki-source-452244fad48fe4fdb39195dd
    resource: repo://packages/components/src/services/Context.ts
  - id: openwiki-source-7cd34df70d8c46bce104c371
    resource: repo://packages/components/src/services/SocialAgentRegistry.ts
  - id: openwiki-source-5dc3965aa1f801077859e52f
    resource: repo://packages/components/src/temporal/activities/admin.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# Domain-logic placement

The repository follows an activity-first layering rule: **component services and
HTTP handlers are thin**, **Temporal workflows are the only place that
materializes state**, and **the authorization-agent owns the SAI rules**. This
page records the rule, the current conformance, and the residual work that is
tracked in GitHub issues #101–#107 and #136.

## 1. Principle

1. **`packages/components` services and HTTP handlers are thin.** They read,
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
problem: an admin's UAS cannot PATCH seeded closures, while the org session can.

## 2. Layers

| Layer | Owns | Never does |
|---|---|---|
| `packages/data-model` | data types (activities, registries, grants, authorizations, need groups), `dataModelContext` + JSON-LD framing | logic beyond framing |
| `packages/authorization-agent` | **all SAI rules**: structure → `DataAuthorization` building (`buildNestedDataAuthorizations`), scope semantics (`matchesScope`), recording/generation, share formatting, grant generation (`grant-generation.ts`), registry CRUD | HTTP, webhooks, RPC, Temporal |
| `components` services | RPC adapters, reads (`queries/org.ts`), validation reads, context gating, **activity writing** | mutation, SAI rules |
| `components` HTTP handlers | protocol endpoints (`InvitationHandler`, `AccessRequestHandler`, `ReciprocalWebhookHandler`, events) — authenticate + write the activity | domain rules |
| `components` temporal | orchestration only: per-class dispatch, mint sessions, call AA methods, completions (`markActivitiesDone`) | SAI rules beyond sequencing |

The AA rules are not decorative: `matchesScope` and the grant-generation chain
decide what a grant covers, and the transport layer only supplies data and
context ([`authorization-agent/src/authorization.ts`](../../packages/authorization-agent/src/authorization.ts),
[`authorization-agent/src/grant-generation.ts`](../../packages/authorization-agent/src/grant-generation.ts)).

## 3. The roll-up invariant

A code-level invariant: every registry mutation call
(`recordAuthorizationFromStructure`, `shareDataInstance`,
`generateAuthorization`, PUT/DELETE of registries/grants/ACRs) appears **only**
in `components/src/temporal/**` (or in `authorization-agent` itself); services
call `createActivity` only. The activity-first granting flow is the reference
implementation: `ApiHandler` decodes the request and writes the activity, and
`processAuthorizationGranted` materializes the embedded authorizations, fans out
per grantee, and marks the activity done
([`ApiHandler.ts`](../../packages/components/src/ApiHandler.ts),
[`temporal/workflows/grants.ts`](../../packages/components/src/temporal/workflows/grants.ts)).

## 4. Current conformance and residual work

The granting, revocation, role, invitation, admin, and account flows follow the
rule. The following exceptions are known and tracked:

| Residual | Why it matters | Issue |
|---|---|---|
| Registry CRUD/completion helpers in components: `markActivitiesDone`, the completion partition in `getPendingActivities`, `replaceAccessGrantsOnRegistration`, `storeGrantAndAcr`, `revokeGrantClosure`, `getRegistryGrantsForGrantee` | domain operations live in the workflow layer rather than the AA | #101 |
| Synchronous `shareDataInstance` session method has no production caller | dead synchronous path beside the activity-first flow | #102 |
| `SaiPermissionsEngine` grant-evaluation predicates (`findGrant`, registration/resource/inherited modes, parent chain) | the AA owns sibling rules but not the evaluation side | #107 |
| `hasAdminGrant` marker rule implemented four times (`Context.isAdminOf`, `adminGate.requireOrgAdmin`, `AgentIdHandler`, `SocialAgentRegistry.buildSocialAgentProfile`) | one org-admin rule, four transports | #104 |
| `buildAdminGrants` materializes `AdminGrant` payloads in `temporal/activities/admin.ts` | grant materialization is an AA sibling of `generateGrantsForAuthorization` | #105 |
| HTTP `AgentRegistry.findRegistration` in `getExistingGrants` / `replaceAccessGrantsOnRegistration` | the plane-based reader already exists; this is the last HTTP consumer in components | #106 |

`recordAuthorizationFromStructure` is already retired; only historical comments
remain in the data-model. The Temporal extraction (`packages/temporal-workflows`
plus the services/builders split) is a larger refactor blocked on the
`components ↔ temporal-workflows` cycle; see
[Deferred and open designs](deferred-designs.md) and issue #136.

## 5. Checklist for an activity-first change

For every new activity class:

- [ ] **data-model** — types + context rows; no logic.
- [ ] **authorization-agent** — the SAI rule, with a session method or export,
  unit-tested there.
- [ ] **service** — context gate + validation reads + `createActivity` only;
  pending ack echoing the minted id + `activityId`.
- [ ] **workflow** — materialize at the minted id find-first; derive from the
  object; one completion; bundled on `create-grants`; `reconcileActivities`
  branch.
- [ ] **handler** — one dispatch branch per class; forward-before-dispatch
  unchanged.
- [ ] **UI** — activity label + done-row refresh.
- [ ] **docs/tests** — activity catalogue and the `/test` wait-for coverage.

## 6. Tests

The package suites are the agent gate; the Dagger `/test` suite is the
user-run acceptance gate. For boundary changes, the relevant coverage is
`packages/components/test/grants-workflow.test.ts`,
`packages/components/test/authorization-revocation-workflow.test.ts`,
`packages/authorization-agent/test/grant-generation.test.ts`,
`packages/authorization-agent/test/grant-chain.test.ts`, and the org-context /
role / share integration tests.
