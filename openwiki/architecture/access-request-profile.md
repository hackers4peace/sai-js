---
type: architecture
title: Access request wire profile and need resolution
description: The owner-scoped /.sai/access-requests endpoint — the SAI need-based and plain LWS ODRL request shapes, action and target validation, conversion into access needs, owner-side request minting, and the read facade over the owner's AccessRequestRegistry.
tags: [access-request, odrl, lws, sai-profile, need-based, http-endpoint]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-21T19:19:35.660Z
sources:
  - id: openwiki-source-f43abf593fa5899437adf71e
    resource: repo://packages/components/config/http/handler/default.json
  - id: openwiki-source-65744b7e3b32ec51ca76eecf
    resource: repo://packages/components/src/AccessRequestHandler.ts
  - id: openwiki-source-77ba5375a0817cab464d649a
    resource: repo://packages/components/src/need-based-access-request.ts
  - id: openwiki-source-b128b22e44fd4462f50345f2
    resource: repo://packages/components/src/plain-lws-access-request.ts
  - id: openwiki-source-2af133f3bbd6a57414093c5d
    resource: repo://packages/components/src/plain-lws-target-resolver.ts
  - id: openwiki-source-8200625bb0d205b062eaf257
    resource: repo://packages/components/src/SaiAccessServiceDescriber.ts
  - id: openwiki-source-0851426d2ff44a476b10b81c
    resource: repo://packages/components/src/temporal/activities/access-request.ts
generated: { by: "pi", at: "2026-11-21T19:19:35.660Z" }
---

# Access request wire profile and need resolution

A requester's authorization agent (UAS) asks a data owner for data by POSTing an
ODRL access request to the owner's `.sai` endpoint. The owner side does not store
the wire document: it validates the request, maps it onto the SAI access-need
model, mints the real request id in its own `AccessRequestRegistry`, and lets the
owner-side workflow materialize the immutable `AccessRequest`. This page covers
that wire profile and the mapping. The activity span it opens is described in
[Activity outbox and events pipeline](../services/activity-lifecycle.md); the
grant that a later approval produces is described in
[Authorization revocation and grant projections](authorization-revocation.md) and
[Grant equivalence and reuse](grant-reuse.md).

## Endpoint and routing

`AccessRequestHandler` owns the path `/.sai/access-requests/<base64url(owner)>`
([`AccessRequestHandler.ts`](../../packages/components/src/AccessRequestHandler.ts)).
The owner segment is decoded and must be an `http:`/`https:` WebID; a
malformed segment is a `400`, and every request is scoped to that single owner.

The router in the default component configuration allows only `POST`, `GET`, and
`HEAD` on the path
([`config/http/handler/default.json`](../../packages/components/config/http/handler/default.json)),
and the handler itself rejects any other method with `400`:

- `POST` — accept a new access request (both accepted shapes below),
- `GET`/`HEAD` — a read-only facade over the owner's request registry.

The POST leg ignores a trailing registry path: the target only contributes the
owner. The read leg uses the trailing path to address a member
([`AccessRequestHandler.ts`](../../packages/components/src/AccessRequestHandler.ts)).

The endpoint is discoverable, not guessed. `SaiAccessServiceDescriber` extends
the LWS storage description of a pod: it resolves the pod's account WebID through
`PodEndpointStore` and the `WebIdStore`, discovers the owner's authorization
agent from the WebID document, and advertises services on that agent's origin
([`SaiAccessServiceDescriber.ts`](../../packages/components/src/SaiAccessServiceDescriber.ts)):

| Service | Endpoint | `conformsTo` |
| --- | --- | --- |
| `AccessRequestService` | `<aa-origin>/.sai/access-requests/<base64url(owner)>` | `lws:AccessProfile`, `interop:AccessProfile` |
| `AccessGrantService` | `<aa-origin>/.sai/grants/<base64url(owner)>` | `interop:AccessProfile` |

Advertising the LWS profile on the request service is what makes the plain LWS
shape acceptable there; the grant service, which only serves SAI grants, does not
claim it. A pod whose owner cannot be resolved, or whose authorization agent
cannot be discovered, keeps its unchanged description — the describer logs a
warning instead of failing the description request.

## Two accepted document shapes

The handler dispatches on the document's `type` and falls through to `400`
"expected a need-based access request" for anything else
([`AccessRequestHandler.ts`](../../packages/components/src/AccessRequestHandler.ts)):

1. **SAI need-based** — `type` contains `interop:NeedBasedAccessRequest` (or the
   compact `NeedBasedAccessRequest`) and `access` is an array
   ([`need-based-access-request.ts`](../../packages/components/src/need-based-access-request.ts)).
   This is the native SAI wire: one ODRL `Request` policy per access need,
   carrying `accessNeedGroup`, `registeredShapeTree`, `inheritsFromNeed`, and
   `AccessRequired`/`AccessOptional`.
2. **Plain LWS ODRL** — `type` contains `AccessRequest`, has an `access` array,
   and is *not* marked need-based, `*DelegationRequest`, or
   `*AccessRevocationRequest`
   ([`plain-lws-access-request.ts`](../../packages/components/src/plain-lws-access-request.ts)).
   This is the LWS profile shape from
   [w3c/lws-protocol#303](https://github.com/w3c/lws-protocol/issues/303): plain
   `Request` policies whose `permission[].target` is an ODRL `Asset` or
   `AssetCollection`. It carries none of the SAI need extensions.

Delegation and revocation are deliberately not accepted here — they are
projections in the issuing agent's own context — and the integration suite pins
that both shapes are rejected with `400`
([`access-request.test.ts`](../../test/access-request.test.ts)).

The envelope in both shapes is an ODRL `AccessRequest` with an `access[]` array of
policies. Each policy has an id/uid, a type tuple, and one or more
`permission[]` entries; each permission carries `assigner`, `assignee`,
`action[]`, and a single `target`. The target carries a `type` tuple and a
`source` array of IRIs, plus optional `partOf` (the containing registration) and
`owner`.

## Authorization preconditions

Both shapes run the same preconditions; LWS permits a server to add these
policies, and the plain LWS path keeps them rather than loosening them
([`AccessRequestHandler.ts`](../../packages/components/src/AccessRequestHandler.ts)):

| Check | Failure |
| --- | --- |
| An authenticated agent credential is present | `401` |
| The credential is client-bound (`client.clientId`) | `401` |
| The client id equals the requester's discovered authorization agent | `403` |
| Content type is `application/ld+json` (params allowed) or `application/lws+json` | `415` |
| The body parses as JSON | `400` |
| The requester is a registered social agent of the owner | `403` |
| `grantedBy`/`assignee` equals the authenticated WebID (self-requests only) | `400` |
| `dataOwner` equals the owner in the endpoint | `400` |

Missing credentials are reported as an authentication failure (`401`), not as a
`403`. The "client is the requester's UAS" check is what keeps a third-party
client from posting requests in a user's name; the registration check is what
keeps an uninvited agent from opening requests at all.

## Actions

`action` is normalized before anything else looks at it
([`need-based-access-request.ts`](../../packages/components/src/need-based-access-request.ts)):
compact terms (`read`, `modify`, `create`, `delete`), prefixed terms
(`odrl:read`, `odrl:modify`, `odrl:create`, `lws:create`, `odrl:delete`), and the
full ODRL `create` IRI all map to the SAI access-mode IRIs. Results are deduped;
an empty action list or an unknown action is a `400`.

## Targets and need scope

An access need is either shape-tree scoped, registration scoped, or
instance scoped. Which one a policy produces is decided by its target type — the
same three-way mapping in both document shapes:

| Target | Need scope | Request fields |
| --- | --- | --- |
| `odrl:Asset` + `source` instances (optional `partOf`) | instance | `hasDataInstance[]`, plus `hasDataRegistration` when known |
| `odrl:AssetCollection` + `interop:DataRegistration` | registration | `hasDataRegistration`, no instances |
| `odrl:AssetCollection` + `shapetrees:ShapeTree` | shape tree | `registeredShapeTree` only |

### Parsing the need-based shape

`parsePolicy` enforces the frame rather than repairing it
([`need-based-access-request.ts`](../../packages/components/src/need-based-access-request.ts)):

- all permissions of a policy must name the requester as `assigner` and
  `assignee`;
- a policy may not mix `Asset` and `AssetCollection` targets;
- instance needs require `registeredShapeTree` and exactly one registration
  across their `partOf` values, and at least one source instance;
- collection needs may not mix registration and shape-tree targets, nor span
  multiple registrations or shape trees;
- a declared `registeredShapeTree` must match the shape tree named by the target;
- a target whose `owner` is present must match the owner endpoint, and a missing
  owner is filled from the endpoint.

Need ids come from the policy `uid`/`id` when present and a fresh `urn:uuid:`
otherwise; `inheritsFromNeed` is preserved so `needBasedAccessRequestFromOdrl`
can rebuild the recursive need group, and the request's `grantee`,
`grantedBy`, and `dataOwner` are derived from the policies and the endpoint
because the frozen wire does not repeat them in the envelope.

### Resolving the plain LWS shape

Plain LWS does not know shape trees, so the owner resolves each target against
its own registry view with `plainLwsTargetResolver`
([`plain-lws-target-resolver.ts`](../../packages/components/src/plain-lws-target-resolver.ts)):

- `Asset` — each `source` instance is loaded with `loadDataInstance`, using the
  single permitted `partOf` value as a hint; the instance's `DataRegistration`
  supplies the registration IRI and its shape tree. More than one `partOf`, an
  instance without a registration, an unresolvable instance, or an instance that
  is not contained in the named registration is a `400`. Instances that share a
  registration are grouped into one resolution.
- `AssetCollection` + `DataRegistration` — the registration is loaded and its
  `registeredShapeTree` is required; a non-registration or a registration
  without a shape tree is a `400`.
- `AssetCollection` + `ShapeTree` — the source IRIs are taken as shape trees.
- Anything else (including a container/storage-only `AssetCollection`) is a
  `400`: the SAI request profile has no container-scoped need.

`plainLwsAccessRequestToNeedBased` then folds the resolved permissions into
needs keyed by `(registeredShapeTree, hasDataRegistration, sorted action set)`:
permissions that resolve to the same scope and carry the same actions become one
need, and their instance lists are unioned
([`plain-lws-access-request.ts`](../../packages/components/src/plain-lws-access-request.ts)).
Every generated need is `AccessRequired` — plain LWS has no optionality term —
and need and need-group ids are freshly generated `urn:uuid:` values. An
unresolvable target aborts the whole request with `400` instead of being dropped,
so a client never receives a `202` for a partially narrowed request.

### Rejected in both shapes

ODRL `constraint` at the policy or permission level is rejected with `400`
("ODRL constraints are not supported by the SAI access request profile") because
the SAI need model has no constraint representation
([`need-based-access-request.ts`](../../packages/components/src/need-based-access-request.ts),
[`plain-lws-access-request.ts`](../../packages/components/src/plain-lws-access-request.ts)).
Plain LWS also rejects an `assignee` other than the requester, an empty `source`,
a missing target/permission, and a target that resolves to nothing. In the
plain LWS shape `assigner` is optional (the LWS profile allows a self-request
without it), but when present it must equal the requester.

## Acceptance and minting

`acceptNeedBasedAccessRequest` performs the write side
([`need-based-access-request.ts`](../../packages/components/src/need-based-access-request.ts)):

1. re-check that `grantedBy === grantee ===` the authenticated WebID and that
   `dataOwner` matches the endpoint;
2. confirm the requester is registered with the owner (`403` otherwise);
3. mint the request id in the owner's `AccessRequestRegistry`;
4. append one `NeedBasedAccessRequestReceived` activity whose `object` is the
   embedded request at the minted id and whose `target` is the registry;
5. return `202` immediately — the response awaits nothing beyond the activity
   write, so the owner-side workflow materializes the resource asynchronously.

The plain LWS path calls the same function after conversion and passes
`{ location: true }`, so only that path returns a `Location` header with the
minted request IRI. The native need-based path returns an empty `202` without
`Location`, so the requester does not learn the minted id from the response. Both behaviors are pinned by the integration tests
([`access-request.test.ts`](../../test/access-request.test.ts),
[`specific-instance-access-request.test.ts`](../../test/specific-instance-access-request.test.ts)).

## The read facade

`GET`/`HEAD` on `/.sai/access-requests/<owner>[/<member>]` are a thin facade over
the owner's `AccessRequestRegistry`
([`AccessRequestHandler.ts`](../../packages/components/src/AccessRequestHandler.ts)):

- only the owner may read (`403` for any other authenticated agent, `401`
  unauthenticated) — the facade performs the check the registry ACL would
  perform;
- the target is rewritten into the owner's registry set and fetched with the
  owner's session, so container listing, member reads, content negotiation, and
  conditional/range requests stay the registry's LWS reader's job;
- `accept`, `accept-language`, `prefer`, `if-none-match`, `if-modified-since`,
  and `range` are forwarded, and the upstream status and content type are
  passed back (a `HEAD` returns the metadata without a body);
- members are addressed relative to the owner's registry set when the request
  registry lives directly under it, and relative to the registry IRI otherwise.

## From request to grant

The request profile is only the inbound half. The requester-side workflow
(`forwardNeedBasedAccessRequest`) renders the same frozen wire from the stored
embedded request: instance needs become one `Asset` permission per instance with
`scopeOfGrant: SelectedFromRegistry` (the registration is an advisory `partOf`),
registration-scoped needs become an `AssetCollection` + `DataRegistration`
target with `AllFromRegistry`, and shape-tree needs become an
`AssetCollection` + `ShapeTree` target
([`activities/access-request.ts`](../../packages/components/src/temporal/activities/access-request.ts)).

On approval, an instance-scoped need becomes a `SelectedFromRegistry`
`DataAuthorization` carrying `hasDataInstance`, and the generated grant carries
one `Asset` permission per granted instance
([`specific-instance-access-request.test.ts`](../../test/specific-instance-access-request.test.ts)).
The requester-side detector only closes an open request when the union of grants
for that shape tree covers every requested instance
([`activities/access-request.ts`](../../packages/components/src/temporal/activities/access-request.ts)),
so a partial grant leaves the request open.

## Focused tests

- [`packages/components/test/plain-lws-access-request.test.ts`](../../packages/components/test/plain-lws-access-request.test.ts)
  — detection, instance/registration/shape-tree mapping, grouping by action set,
  and rejection of constraints, wrong assignees, empty sources, and
  unresolvable targets.
- [`packages/components/test/need-based-access-request.test.ts`](../../packages/components/test/need-based-access-request.test.ts)
  — multi-permission instance needs, registration and shape-tree needs,
  inherited nesting, action normalization, mixed-target rejection, and
  constraint rejection.
- [`test/access-request.test.ts`](../../test/access-request.test.ts) — the send
  leg (RPC → forwarded ODRL POST → `202`), the owner endpoint (`202` without
  `Location`, stored request), the read facade and its `401`/`403`, and the
  removal of the delegation/revocation paths.
- [`test/specific-instance-access-request.test.ts`](../../test/specific-instance-access-request.test.ts)
  — instance needs end to end, the plain LWS `Asset` POST returning a
  `Location`, and grants limited to the requested instances.
