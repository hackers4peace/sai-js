---
type: data-model
title: Data model entities
description: The data-model package's JSON-LD POJO entities — registries, registrations, grants, roles, access needs, shape trees, activities — their ldp:contains containment and wrapper removals, POJO id invariants, the JSON-LD ACR builders, and the bootstrap TriG templates.
tags: [data-model, json-ld, solid, entities, typescript]
sources:
  - id: openwiki-source-1d72172ac5b4243a0342f708
    resource: repo://packages/application/src/grant.ts
  - id: openwiki-source-4882e1fd924283cc46a8913e
    resource: repo://packages/authorization-agent/src/access-description-set.ts
  - id: openwiki-source-a53c5361cefa789231b20bc0
    resource: repo://packages/authorization-agent/src/authorization.ts
  - id: openwiki-source-8b149b790c910713311c36a2
    resource: repo://packages/data-model/src/acr.ts
  - id: openwiki-source-40eb9f7315a1082fe32671da
    resource: repo://packages/data-model/src/activities.ts
  - id: openwiki-source-9d948095f3f5ea720e39040b
    resource: repo://packages/data-model/src/agent-registration.ts
  - id: openwiki-source-4c483ee0e31262852db887ef
    resource: repo://packages/data-model/src/application-registration.ts
  - id: openwiki-source-3c1f107e8ef50fc77806f71c
    resource: repo://packages/data-model/src/authorization-registry.ts
  - id: openwiki-source-5f3a5827ade0bebc11f29499
    resource: repo://packages/data-model/src/context.ts
  - id: openwiki-source-55719eab9d1c37202ec0cc48
    resource: repo://packages/data-model/src/data-authorization.ts
  - id: openwiki-source-42b7781fbb51339433b3e01d
    resource: repo://packages/data-model/src/data-instance.ts
  - id: openwiki-source-6b6976370d0cdcf6bd57cad3
    resource: repo://packages/data-model/src/grant.ts
  - id: openwiki-source-81127af59080ceff3a2cde89
    resource: repo://packages/data-model/src/index.ts
  - id: openwiki-source-baaabdb26a02bad8b3a7b3f4
    resource: repo://packages/data-model/src/registry-set.ts
  - id: openwiki-source-12dd5601be4d1b21ac977892
    resource: repo://packages/data-model/src/templates/index.ts
generated: { by: "pi", at: "2026-10-18T21:45:34.463Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-10-18T21:45:34.463Z
---

# Data model entities

`@janeirodigital/interop-data-model` (`packages/data-model`) is the pure,
dependency-light JSON-LD POJO layer shared by the `application` and
`authorization-agent` packages. It owns entity data types, `fromJsonLd` readers,
a single shared `dataModelContext`, ACP/ACR JSON-LD builders, and the bootstrap
TriG templates. It imports neither of the other SAI packages (the shared
`DataModelDependencies` type lives in `authorization-agent/src/types.ts`).

The public surface is `packages/data-model/src/index.ts`, which re-exports
entities both as `type` (the data shape) and as namespaces (helpers such as
`fromJsonLd` / `toDataset`), to avoid name collisions between e.g. a `RoleData`
type and its helpers.

## Entity groups

- **Registries and registrations** — `RegistrySetData` lists every registry a
  context owns (authorization, grant, social-agent, application, invitation,
  role, data, plus optional activity and access-request registries); the agent
  registries and registrations are the `SocialAgentRegistryData` /
  `ApplicationRegistryData` / `InvitationRegistryData` and
  `SocialAgentRegistrationData` / `ApplicationRegistrationData` /
  `SocialAgentInvitationData` shapes.
- **Authorization and grants** — `DataAuthorizationData`, `AdminAuthorizationData`,
  `GrantData` (with scope fields `inheritsFromGrant`, `delegationOfGrant`,
  `hasInheritingGrant`), and the authorization/grant registry shapes.
- **Data** — `DataRegistryData`, `DataRegistrationData`, and the read-only
  `DataInstanceData` (with `isBlob` and `frameDataInstance` helpers; there is no
  write-side `DataInstance` class).
- **Access needs** — `AccessNeedData` (recursive `children`, a `required`
  derived from `interop:accessNecessity`), `AccessNeedGroupData`, and the
  `*Description` shapes (`AccessDescriptionData`, `AccessNeedDescriptionData`,
  `AccessNeedGroupDescriptionData`).
- **Roles** — `RoleData` with a language-mapped `label` and `members`.
- **Shape trees** — `ShapeTreeData` (with `references` via `viaPredicate`) and
  `ShapeTreeDescriptionData`. Shape trees are read through `frameNode` plus an
  expanded-document walk for `references`/description languages — there is no
  quad-based `fromDataset`/`toDataset` pair anymore.
- **Activities** — `ActivityData`, a discriminated union of one member per RDF
  activity class (including the terminal `AccessRequestGranted` and
  `AccessRequestArchived`), with `isActivityClass(activity, cls)` membership
  checks. The wire form is flat: `type` is the class tuple and fields are plain
  IRIs/literals (no nested `payload`, no `{ id, type }` ref objects stored in
  registries).
- **Messages and identity** — `AccessRequestMessage` / `NeedBasedAccessRequest*`
  / `AccessRevocationMessage`, `WebIdProfileData`, `ClientIdDocumentData`, and
  `DataOwnerData`.

## Containment and wrapper removal

The registry wrappers are gone; members are enumerated directly from the
container:

- `AgentRegistrationData` links its grants through `hasDataGrant` (an
  `interop:hasDataGrant` string array) — there is no `AccessGrant` wrapper
  resource. `ApplicationRegistrationData.granted` is **derived** (the
  registration has any data grants), never a persisted field.
- The authorization registry is a bare `{ id }` container whose members are
  `ldp:contains` children framed straight into `DataAuthorizationData` — there
  is no `AccessAuthorization` wrapper resource. Containment is
  **server-managed `ldp:contains`**: no client-managed
  `interop:hasDataAuthorization` writes.
- Deny/revoke/replace **physically DELETE** data-authorization resources via
  `replaceDataAuthorizationsForGrantee` (which computes the IRIs to delete and
  issues `DELETE` requests), rather than orphaning them.

## POJO invariants

- Most resource POJOs require `id: string`. The exceptions are `GrantData.id?`
  and `DataAuthorizationData.id?`, whose "final" forms
  (`FinalGrantData`, `FinalDataAuthorizationData`) add the required `id` back.
- `type` is always `string[]` (the shared `dataModelContext` maps `@type` to a
  set container, and the POJO types declare `type: string[]`).
- The access-description set is a **derived, read-only split**: there is no
  `AccessDescriptionSetData` POJO and no set-level round-trip; `forAccessNeed`
  and `forAccessNeedGroup` partition the set document into
  `AccessNeedDescriptionData` and `AccessNeedGroupDescriptionData` at load time.
- `DataInstanceData` is read-only: only the frame helpers
  (`frameDataInstance`, `frameDataInstanceFromDoc`, `labelFromNode`,
  `childIris`) exist; blob upload and description patching belong to the
  application. Grant iteration yields **instance IRIs** (an
  `AsyncIterable<string>`), not `DataInstance` objects.

## JSON-LD framing

`fromJsonLd` readers uniformly take a JSON-LD document (expanded, compacted, or
flattened), frame it through the shared `dataModelContext` (a JSON-LD 1.1
context that aliases `id` to `@id` and forces `type` into a set container), and
project it into a typed POJO. This is the payload contract anchor between the
wire format and the typed layers above it. The raw GET/PUT helpers that carry
these documents are documented in
[JSON-LD read/write layer](json-ld-layer.md).

## ACR builders and bootstrap templates

Access Control Resources are built as **JSON-LD**, not Turtle.
`packages/data-model/src/acr.ts` exports:

- `agentRegistrationAcrJsonLd({ id, owner, peer })` — the owner
  (read/write/control) plus peer (read) ACR for an agent registration.
- `dataGrantAcrJsonLd({ id, resource, owner, grantor?, peer?, client? })` — the
  owner full-access ACR plus optional delegating-grantor read and peer/client
  read matchers.
- `rewriteFullAdminAccess(doc, acrId, matchers)` — a pure function that removes
  the existing `#fullAdminAccess` control (its policies and matchers,
  transitively) and its `#root` wiring, then adds a fresh control plus wiring
  from the supplied admin matchers; an empty matcher list drops the control.

Callers PUT these compacted documents through `putJsonLd`, so ACP no longer
crosses a Turtle boundary. The remaining `packages/data-model/src/templates/`
exports are the **bootstrap TriG** fragments used when provisioning an account:

- `RegistrySet.ts` — the registry set plus its registry containers.
- `WebId.ts` — the WebID profile (issuer, authorization agent, delegation
  issuance endpoint).
- `DataRegistry.ts` — the data registry/storage descriptor.
- `types.ts` — the shared `AgentAndClient` type.

These templates are posted to the per-pod Fuseki datasets during account
bootstrap (see [Per-pod storage and isolation](../architecture/storage-isolation.md)).
