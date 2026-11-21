---
type: architecture
title: Deferred and open designs
description: Design decisions that are recorded but not implemented — creation-metadata auditing, invitation lookup over the registry plane, the n3 dependency decision, and the components/Temporal extraction options.
tags: [design, backlog, auditing, n3, refactoring]
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-fc4b5fd3338ed5d4ced2af52
    resource: repo://packages/authorization-agent/src/agent-registry.ts
  - id: openwiki-source-9a0178ffa2620c135186d460
    resource: repo://packages/components/package.json
  - id: openwiki-source-c18acf0c50387f2e5ea026d1
    resource: repo://packages/components/src/ActivityWebhookHandler.ts
  - id: openwiki-source-f61ceb613541bbcadb627564
    resource: repo://packages/components/src/InvitationHandler.ts
  - id: openwiki-source-c4233c9bce7ccb07d3edd54a
    resource: repo://packages/components/src/services/ReciprocalMirror.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-81028398d49b5413dde247f1
    resource: repo://packages/test-utils/src/fuseki.ts
  - id: openwiki-source-a9641e35b6a54ba0aca67443
    resource: repo://packages/utils/src/namespaces.ts
  - id: openwiki-source-863d51dc4bd9535a1e557732
    resource: repo://packages/utils/test/match.test.ts
  - id: openwiki-source-04f6a81cd8f58552c8dfc86f
    resource: repo://services/id/cid.ts
generated: { by: "pi", at: "2026-11-21T19:19:35.660Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-21T19:19:35.660Z
---

# Deferred and open designs

This page records design decisions that are **not implemented** so they do not
get mistaken for current behavior. Each section states what exists today, what
was decided or recommended, and where the work is tracked. The GitHub issue
numbers refer to `hackers4peace/sai-js`; they are not API contracts.

The repository keeps its design notes in this wiki now: the former
`docs/plans/` tree and `docs/plan.md` were deleted once their content landed in
code and pages, so links below point at wiki pages rather than plan files. The
last remaining design note, `docs/sai-access-profile.md`, was folded into
[Access request wire profile and need resolution](access-request-profile.md) and
deleted.

## 1. Generic creation-metadata auditing

sai-js used to write `interop:registeredBy`, `interop:registeredWith`,
`interop:registeredAt`, and `interop:updatedAt` on every container create via
`setTimestampsAndAgents`. The write was removed: nothing in the repository read
the properties, and `updatedAt` was stale the moment anything changed. The terms
survive as vocabulary and test fixtures only
([`utils/src/namespaces.ts`](../../packages/utils/src/namespaces.ts),
[`utils/test/match.test.ts`](../../packages/utils/test/match.test.ts)).

The intended replacement is server-side or Solid-server-provided audit metadata
rather than application-written properties. Open questions: whether ACR
documents should also stop writing agent/client data, what consumes the metadata
once it exists, and whether the source is a server audit log or RDF metadata.
Tracked as issue #103.

## 2. Invitation lookup over the registry plane

The runtime accept path uses the registry-plane SPARQL reader: `InvitationHandler`
calls `sai.findSocialAgentInvitation` on the authorization-agent session
([`InvitationHandler.ts`](../../packages/components/src/InvitationHandler.ts)).
The **write-path duplicate check** in `addSocialAgentInvitation` still uses the
HTTP list-and-scan twin: `socialAgentInvitations` lists the agent-registry
container with `linkedIrisJsonLd`, then `findSocialAgentInvitation` loads one
invitation per candidate until the capability URL matches
([`agent-registry.ts`](../../packages/authorization-agent/src/agent-registry.ts)).

The two implementations can drift on containment semantics and flat storage, and
the HTTP path is O(n) requests. The design is to route the duplicate check
through the SPARQL `fetchSocialAgentInvitation` and delete the HTTP scan if no
caller remains. Tracked as issue #115.

## 3. The `n3` dependency

`n3` remains a direct dependency of the `utils`, `test-utils`, `data-model`,
`components`, and `authorization-agent` workspace packages, plus the
non-workspace `services/id` service
([`components/package.json`](../../packages/components/package.json),
[`utils/package.json`](../../packages/utils/package.json),
[`services/id/package.json`](../../services/id/package.json)). It is still used
for:

- RDF/JS `Store`/`DataFactory` in `utils`, `data-model`, `authorization-agent`,
  `SaiPermissionsEngine`, and the id service;
- a parser/writer in `ReciprocalMirror` (N-Quads → `GRAPH` blocks) and in the
  test/seed TriG splitter;
- the n3 rule reasoner behind CID resolution in `services/id`

([`utils/src/jsonld.ts`](../../packages/utils/src/jsonld.ts),
[`components/src/services/ReciprocalMirror.ts`](../../packages/components/src/services/ReciprocalMirror.ts),
[`test-utils/src/fuseki.ts`](../../packages/test-utils/src/fuseki.ts),
[`services/id/cid.ts`](../../services/id/cid.ts)).

This inventory is unaffected by the authentication cleanup: the browser OIDC
client `@uvdsl/solid-oidc-client-browser` is gone from
`packages/components/package.json`, and the root `@solid/access-token-verifier`
override is gone from `sai-js/package.json`, but no `n3` manifest changed (see
[SAI endpoint authentication](sai-endpoint-authentication.md) for that
migration).

`fetch-sparql-endpoint` keeps `n3` in `node_modules` regardless, so removing
direct manifests is dependency hygiene, not a functional requirement. The
recommended option is a **partial drop**: swap `Store`/`DataFactory` to
`@rdfjs/dataset`/`@rdfjs/data-model`, keep `n3` for the reciprocal-mirror, TriG,
and id-service tooling, and drop the remaining unused manifests. The
`application` manifest already dropped it; `services/id` is the one package that
cannot drop `n3` without replacing its reasoner. A full drop needs a replacement
N-Quads/TriG parser and writer. Tracked as issue #128.

## 4. Components and Temporal extraction

`packages/components` still contains both the non-component glue and all
Temporal code: 9 workflows and 9 activities under
`packages/components/src/temporal/`, plus `temporal/client.ts` and
`workers/main.ts`. There is no `packages/temporal-workflows` package
([`temporal/workflows/grants.ts`](../../packages/components/src/temporal/workflows/grants.ts),
[`workers/main.ts`](../../packages/components/src/workers/main.ts)).

Moving `temporal/*` out as-is creates a `components ↔ temporal-workflows`
cycle: handlers import the Temporal client and workflow definitions, while
activities import `builders/*` (which construct `SessionManager`,
`EnvJwkGenerator`, `PostgresKeyValueStorage`) and `ReciprocalWebhookStore`.
The recorded options are:

- **A (cleanest):** inject a `WorkflowStarter` port via Components.js; move
  services/builders and the builder-constructed component classes to a shared
  services package, re-exported by components for the generator.
- **B (smallest):** accept the circular workspace dependency; components keeps
  services/builders.
- **C (medium, not sufficient alone):** invert builders as factories taking
  component instances; must be combined with A for the workflow-start edge.

The same boundary discussion covers moving residual SAI rules out of components
(the `SaiPermissionsEngine` grant-evaluation predicates, the four copies of the
`hasAdminGrant` marker rule, `buildAdminGrants`, and the HTTP
`findRegistration` calls). See
[domain-logic-placement](domain-logic-placement.md) and issues #104–#107 and
#136.

## 5. Status summary

Specific-instance access requests (#135) are implemented and therefore no longer
listed here; see
[Access request wire profile and need resolution](access-request-profile.md).

| Design | Current state | Where |
|---|---|---|
| Creation-metadata auditing | properties removed; replacement undesigned | #103 |
| Invitation duplicate check | HTTP list-and-scan in the write path; SPARQL reader in the accept path | #115 |
| `n3` reduction | direct dependency in five workspace packages plus `services/id`; partial drop recommended | #128 |
| Temporal extraction | all Temporal code still in components; cycle decision open | #136 |
| Residual components logic | engine predicates, admin marker, admin-grant materialization, plane `findRegistration` | #104–#107 |

## Related pages

- [Access request wire profile and need resolution](access-request-profile.md) —
  the implemented specific-instance and plain LWS request paths.
- [Architecture overview](overview.md) — package topology and the dependency
  changes already made.
- [Domain-logic placement](domain-logic-placement.md) — service/workflow/AA
  boundary.
- [Federation constraints](federation.md) — what is still single-deployment.
- [Authorization revocation and grant projections](authorization-revocation.md)
  — reconciliation/backfill behavior.
