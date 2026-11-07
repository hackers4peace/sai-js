# LWS access grants vs current SAI functionality — feature parity

## Scope and sources

This compares the **LWS access-grant primitive in PR #126** with the **current SAI authorization functionality** exercised by the integration suite and the Temporal sequence model.

Sources:

- `test/` — 22 `*.test.ts` files, 162 `test(...)` cases. The authorization-heavy files are `policy-engine`, `authorization`, `access-request`, `delegation-endpoint`, `authorization-revocation`, `roles`, `personal-admin`, `org-context`, `admin-events`, `invitation`, `federation-mirror`, `reconciliation`, `share`, `authorizations`, `check-equivalence`.
- `docs/temporal.c4` — 20 dynamic views over the `Alice`/`Bob`/`Kim`/`Dan`/`YoYo`/`Peers`/`App` security domains, with the concrete HTTP/RDF payloads and test references in their notes. The relevant views are `authorization`, `authorization-data-app`, `request-access`, `authz-data-need-based-request`, `approve-access-request`, `deny-access-request`, `share-resource`, `role-membership-change`, `role-deletion`, `invitation` + the admin-invitation views, the org/personal admin views, `reciprocal-registration-update`, and the discovery views.
- LWS model from PR #126: `src/authorization/lws/AccessGrantUtil.ts`, `AccessGrantReader.ts`, `AccessGrantIndex.ts`, `config/ldp/handler/components/lws-access.json`, and `documentation/markdown/usage/linked-web-storage.md`.

LikeC4 check: `npx likec4 validate --json --no-layout --file docs/temporal.c4 docs` → **valid**, 0 errors (2 project files, 1 filtered file). The model and all 20 dynamic views parse cleanly.

---

## Verdict in one paragraph

LWS access grants are a **resource-level authorization decision primitive**. They can express the final “agent X may do action Y on exact resource Z, optionally constrained by client/format/type/time” decision. They **cannot** express SAI’s authorization *management* layer: shape-tree/registration scopes, inheritance, access needs, delegation chains, roles, admin/org context, invitations, federation, activity/audit, notifications with actor semantics, or the UI. So:

- **Enforcement parity: partial.** Exact-resource grants map well; SAI’s scopes/roles/admin grants do not, except by enumerating targets (which is not equivalent for new resources).
- **Management parity: none.** The entire grant lifecycle — request, mint, fan-out, register, notify, revoke, reconcile — has no LWS equivalent.
- **Practical use:** LWS grants are complementary to SAI’s policy engine, not a replacement. PR #126 itself is designed that way: `lws-access.json` unions `AccessGrantReader` with the policy engine’s `PolicyEngineReader`. Use LWS grants to let external LWS clients access SAI pods; keep SAI grants as the source of truth for SAI agents/workflows.

---

## 1. What the LWS access-grant primitive can express

From `AccessGrantUtil.ts` and the LWS usage doc:

```json
{
  "@context": "https://www.w3.org/ns/lws/v1",
  "type": "AccessGrant",
  "storage": "https://alice.data.example/",
  "inbox": "https://bob.example/inbox",
  "access": [
    {
      "type": "AccessPolicy",
      "assignee": "https://id/bob",
      "action": ["read", "modify", "delete"],
      "target": {
        "type": "DataResource",
        "value": ["https://alice.data.example/projects/p1"]
      },
      "constraint": [
        { "leftOperand": "client", "operator": "eq", "rightOperand": "https://app.example/id" },
        { "leftOperand": "format", "operator": "isAnyOf", "rightOperand": ["text/turtle", "application/ld+json"] },
        { "leftOperand": "dateTime", "operator": "lt", "rightOperand": "2027-01-01T00:00:00Z" }
      ]
    }
  ]
}
```

Capabilities:

| Capability | Detail |
|---|---|
| Assignee | A WebID/URI, or `foaf:Agent` for public access |
| Target | Exact resource URI(s); target type `DataResource`, `Container`, or `StorageResource`; must be inside the grant’s `storage` |
| Actions | `read`, `modify`, `create`, `delete` (mapped to policy-engine `Read`, `Modify`+`Append`, `Append`, `Delete`) |
| Constraints | `client`, `format`, `type`, `dateTime`, `purpose`; operators `eq`, `neq`, `isAnyOf`, `isNoneOf`, `lt`, `lteq`, `gt`, `gteq` |
| Public access | `assignee: foaf:Agent` |
| Lifecycle | POST to `.lws/grants/`; **immutable**; DELETE to revoke; no update; no automatic expiry/cleanup |
| Access requests | Any authenticated agent can POST to `.lws/requests/`; owner/UAS reads and creates a grant |
| Notifications | A grant with an `inbox` notifies that inbox; LWS webhook subscriptions notify resource changes |
| Scope | Per storage (pod); grants are **additive** to the underlying WAC/ACP |
| Caching | Grants are cached in memory; not safe across multiple workers/replicas |

Important restrictions:

- “A policy only applies to the resources listed in its `target`, so targets are not recursive.”
- Grants cannot target `.lws/` or its contents.
- No `grantedBy`, `dataOwner`, `registeredShapeTree`, `hasDataRegistration`, `hasDataInstance`, `scopeOfGrant`, `inheritsFromGrant`, or access-mode scopes.
- No roles, admin grants, org context, registrations, shape trees, access needs, or delegation.
- No activity/outbox, no pending/done status, no actor in notifications, no audit trail.

---

## 2. What SAI currently does (from tests + `temporal.c4`)

The current model is not “a grant is a permission on a resource”. It is a full authorization-management system:

### 2.1 Authorization data model

| SAI concept | Where it appears | Meaning |
|---|---|---|
| `DataAuthorization` | `authorization.test.ts`, `authorizations.test.ts`, `temporal.c4` `authorization` | The user’s approval: `grantee`, `grantedBy`, `registeredShapeTree`, `scopeOfAuthorization` (`AllFromAgent`, `AllFromRegistry`, `SelectedFromRegistry`, `Inherited`, `AllFromRole`), `accessMode`, `dataOwner`, `satisfiesAccessNeed` |
| `DataGrant` | `share.test.ts`, `delegation-endpoint.test.ts`, `federation-mirror.test.ts`, `roles.test.ts` | The materialized grant: `grantee`, `grantedBy`, `dataOwner`, `registeredShapeTree`, `hasStorage`, `hasDataRegistration`, `hasDataInstance`, `scopeOfGrant`, `inheritsFromGrant`, `hasInheritingGrant`, `accessMode` |
| `AccessNeed` / `AccessNeedGroup` | `access-request.test.ts`, `authorization.test.ts`, `temporal.c4` request/approval views | Shape-tree-scoped needs, required/optional, inheriting children, access modes |
| `AccessRequest` | `access-request.test.ts`, `temporal.c4` request/approve/deny | `NeedBasedAccessRequest` with embedded group, `grantee`, `grantedBy`, `dataOwner`; owner-minted IRI; immutable |
| `AdminAuthorization` / `AdminGrant` | `personal-admin.test.ts`, `org-context.test.ts`, `admin-events.test.ts` | Admin approval + `hasAdminGrant` marker + DataRegistry-scoped read grant |
| `Role` | `roles.test.ts`, `temporal.c4` role views | Role registry, membership, `AllFromRole` scope, grant creation/revocation on membership change |
| `Activity` | every `temporal.c4` flow | `AuthorizationGranted`, `AuthorizationDenied`, `AuthorizationRevoked`, `NeedBasedAccessRequestSent/Received/Granted`, `AdminAuthorizationGranted/Revoked`, `RoleMembershipChanged`, `RoleDeleted`, `InvitationCreated/Accepted`, `ActivityCompleted`, etc. |
| `DataRegistration` / `DataInstance` | `policy-engine.test.ts`, `temporal.c4` authorization-data view | Per-pod registrations by shape tree; instances inside them |
| `SocialAgentRegistration` / reciprocal mirror | `federation-mirror.test.ts`, `invitation.test.ts` | Peer registration, `hasDataGrant`, reciprocal registration, replica |
| `Invitation` | `invitation.test.ts`, admin invitation views | Capability URL, social agent registration, reciprocal establishment |

### 2.2 Grant lifecycle

`temporal.c4` `authorization` view:

1. UI RPC `AuthorizeApp` validates and pre-mints `DataAuthorization` IRIs.
2. UI writes one `AuthorizationGranted` activity with embedded DAs (all-or-nothing per activity).
3. Registry webhook → UAS `processAuthorizationGranted`.
4. Parent workflow fans out **one child per grantee** (`processGranteeAuthorization`).
5. Child PUTs `DataAuthorization` resources at the pre-minted ids.
6. For each grant: create `DataGrant` in the registry, update the `SocialAgentRegistration` (`hasDataGrant`), possibly request delegated grants from peers.
7. Create `ActivityCompleted` once at the parent after all children succeed.
8. UI gets pending/done events; grantee sees the registration update; reciprocal webhook updates the peer replica.

This is a durable, idempotent, auditable, multi-party workflow. LWS has none of these steps; it has only “POST a JSON grant” and “DELETE it”.

### 2.3 Access requests

`request-access` + `authz-data-need-based-request` + `approve-access-request` + `deny-access-request`:

1. Requester UI RPC `RequestAccessUsingApplicationNeeds` with an embedded `AccessNeedGroup`.
2. Requester UAS writes `NeedBasedAccessRequestSent` activity (urn:uuid snapshot; no requester registry).
3. Requester workflow POSTs the need-based request to the **owner’s issuance URL** (`issuanceUrl(owner)`), as the requester.
4. Owner UAS checks the requester has a `SocialAgentRegistration`; otherwise 403.
5. Owner mints the `AccessRequest` IRI and writes `NeedBasedAccessRequestReceived`.
6. Owner stores the immutable `AccessRequest` in the owner’s `AccessRequestRegistry`; requester gets 202.
7. Owner `getAuthorizationData` resolves the request’s embedded group, finds matching registrations across own and peer data pods, and returns authorization data.
8. Owner approves → same `AuthorizeApp` grant lifecycle, with `satisfiesAccessNeed` / `satisfiesAccessRequest` back-links.
9. Owner denies → `AuthorizationDenied` with the request snapshot + `satisfiesAccessRequest`; forward-only, no requester notification.
10. Requester detects granted requests via `detectGrantedRequests` and writes `AccessRequestGranted`.

LWS access requests are local JSON documents in `.lws/requests/`; there is no issuance URL routing, registered-agent check, owner-minted IRI, access-need group, approval/denial record, status, archive, or granted-detection.

### 2.4 Delegation

`delegation-endpoint.test.ts` + `share-resource` view:

- `DelegationIssuanceEndpoint`: an agent delegates grants to an application (`grantedBy` = delegator, `dataOwner` = resource owner, `grantee` = app).
- All-or-nothing multi-grant issuance; covering upstream grant required; same `dataOwner` required; empty grants rejected; wrong client rejected.
- `DelegationRevocationEndpoint`: revokes a listed grant and its inheriting child; idempotent echo; mixed existing/already-removed; unauthorized grantor fails whole request; mixed-owner request fails as a whole; unknown registry is a typed refusal; multi-hop chain revocation.
- `share-resource` view: `ShareResource` creates a `SelectedFromRegistry` grant with `hasDataInstance`, updates registration, requests delegated grants from peers.

LWS has no delegation concept. The `client` constraint can restrict a grant to an application, but there is no `grantedBy`/upstream-grant check, no all-or-nothing issuance, no inheriting-child revocation, no multi-hop chain, no mixed-owner semantics, no unknown-registry refusal.

### 2.5 Revocation, roles, admin

- `authorization-revocation.test.ts`: `RevokeAuthorizations` removes the parent/child `DataAuthorization`s and the four derived grants; re-revoking is a no-op success.
- `roles.test.ts`: role create/update/delete; membership add/remove creates/revokes grants; `AllFromRole` scope; role usage; role deletion deletes matched authorizations and regenerates grants.
- `personal-admin.test.ts` / `org-context.test.ts` / `admin-events.test.ts`: `AdminAuthorization`, `AdminGrant`, `hasAdminGrant`, personal vs org context, last-admin guard, registry-set discovery, ACR `#fullAdminAccess` rewrite, admin event channels, cross-org isolation.

LWS can only DELETE a single grant. There is no cascade to derived grants, no authorization layer, no role registry/membership, no `AllFromRole`, no admin authorization/marker/ACR, no org context, no last-admin guard, no admin channels.

### 2.6 Invitations, federation, sharing

- `invitation.test.ts`: personal invitation, admin invitation send/receive, capability URL, social agent registration, reciprocal registration, webhook subscriptions.
- `federation-mirror.test.ts`: seeded reciprocal mirror; a grant write refreshes the peer’s replica; every linked grant body resolvable.
- `reconciliation.test.ts`: pending activity replay; drift arm re-creates grants deleted from the registry; reciprocal mirror completeness; upstream grant freshness.
- `share.test.ts`: share a data instance with a social agent; `SelectedFromRegistry` grant with `hasDataInstance`; grantee-facing `ListDataRegistries` sees the shared registration via the replica.

LWS has no invitation, social-agent registration, reciprocal registration, replica, reconciliation, drift repair, peer delegated grants, or cross-server grant propagation. LWS grants are local to one storage.

### 2.7 Notifications and UI

- `reciprocal-webhook.test.ts`, `admin-events.test.ts`, `temporal.c4`: webhook `Add`/`Update`, NDJSON UI stream, pending/done, `delegatedGrantsUpdated`, admin channel, reciprocal channel, activity completion, `waitForActivityCompletion`.
- LWS notifications are generic `Create`/`Update`/`Delete` resource notifications; the PR explicitly says they do not contain the agent that made the change. They have no activity type, no pending/done, no admin/reciprocal channel, no NDJSON UI stream, no durable delivery queue.

### 2.8 Identity, discovery, storage

- `account-creation.test.ts`: signup creates WebID, both pods, endpoint records.
- `services.test.ts`: auth/registry/data/id services.
- `agents.test.ts` / `agent-discovery.test.ts` / `discovery.test.ts`: agent discovery, social/application registrations, description resource, storage description, authorization redirect, web push.
- `key-scoping.test.ts`: per-pod S3 bucket/key isolation.

LWS adds LWS token exchange and storage description/authorization-server metadata. It does not create accounts/pods, provision per-pod S3 keys, or provide SAI agent/registration/registry-set/web-push discovery.

---

## 3. Parity matrix

Legend: ✅ supported, 🟡 partial/emulatable with extra work, ❌ not supported.

### 3.1 Enforcement layer (final allow/deny)

| Capability | SAI today | LWS access grant | Verdict |
|---|---|---|---|
| Public access | `foaf:Agent` in policy engine | `assignee: foaf:Agent` | ✅ |
| Agent identity | WebID / UAS / client | `assignee` + `client` constraint | ✅ (no UAS distinction) |
| Client restriction | `credentials.client` in policy engine | `client` constraint | ✅ |
| Read/Modify/Delete on exact resource | `accessMode` + grant scope | `read`/`modify`/`delete` + exact target | ✅ |
| Create in container | `Create`/`Append` | `create` on container target | ✅ |
| Format/type/time constraints | Not first-class | `format`/`type`/`dateTime` | ✅ (LWS is richer) |
| Public/agent grant on a specific instance | `SelectedFromRegistry` | exact target value | 🟡 (permission yes; no registration/instance metadata) |
| All resources of a shape tree for an agent | `AllFromAgent` | no scope; exact targets only | ❌ (enumeration is not equivalent for new resources) |
| All instances in a registration | `AllFromRegistry` | no registration concept | ❌ |
| Child resources of a parent | `Inherited` | targets are non-recursive | ❌ |
| Role-based access | `AllFromRole` | no roles | ❌ |
| Admin read over a registry | `AdminGrant` (`DataRegistry` scope) | no admin/scope concept | ❌ (broad exact grants only) |
| Shape-tree/registration/instance targeting | `registeredShapeTree`, `hasDataRegistration`, `hasDataInstance` | no SAI vocabulary | ❌ |
| UAS vs agent vs client | `SaiPermissionsEngine` | agent + client only | 🟡 |

### 3.2 Management layer (create/maintain/revoke)

| Capability | SAI today | LWS access grant | Verdict |
|---|---|---|---|
| Grant issuance endpoint / UAS RPC | `AuthorizeApp`, pre-minted DAs, activity | POST `.lws/grants/` | 🟡 (only the final document) |
| All-or-nothing multi-grant issuance | Parent activity + per-grantee children | one document at a time | ❌ |
| Grant equivalence/reuse (same IRIs) | `checkEquivalence` | no equivalent | ❌ |
| Access needs / need group | `AccessNeedGroup`, `satisfiesAccessNeed` | none | ❌ |
| Access request routing to owner’s UAS | `issuanceUrl(owner)`, registered-agent check | local `.lws/requests/` only | ❌ |
| Access request status/approve/deny/archive | `NeedBasedAccessRequest*`, `AuthorizationDenied`, archive RPC | immutable request; no status | ❌ |
| Granted-request detection | `detectGrantedRequests` | none | ❌ |
| Delegation to application | `DelegationIssuanceEndpoint`, covering upstream grant | no delegation | ❌ |
| Delegation revocation / multi-hop chain | `DelegationRevocationEndpoint` | single grant DELETE | ❌ |
| Revocation cascade to derived grants | `RevokeAuthorizations` | no cascade | ❌ |
| Idempotent revocation echo | re-revoke returns empty success | HTTP DELETE idempotency only | 🟡 |
| Roles / membership changes | role registry, `AllFromRole`, grant create/revoke | no roles | ❌ |
| Admin authorization / org context | `AdminAuthorization`, `hasAdminGrant`, last-admin guard | no admin/org | ❌ |
| ACR rewrite (`#fullAdminAccess`) | `syncAdminAcr` | underlying ACP/WAC only | ❌ |
| Invitations / social-agent registration | capability URL, reciprocal registration | none | ❌ |
| Federation mirror / peer delegated grants | replica, `delegatedGrantsUpdated`, proxy | none (storage-local) | ❌ |
| Reconciliation / drift repair | `reconcileActivities`, drift arm | none | ❌ |
| Grant update | replace grants + registration | immutable; DELETE+POST only | ❌ (no atomic replace/identity) |
| Grant expiry | revocation workflows | `dateTime` constraint; no cleanup | 🟡 |
| Activity/audit/outbox | Activity resources + Temporal | none | ❌ |
| Pending/done notifications | webhook + NDJSON, activity types | generic resource notifications; no actor | ❌ |
| Durable delivery / retries | Temporal `webhook-delivery` | LWS retries 2x, no queue | ❌ |
| UI RPC/events | `.sai/api`, `.sai/events` | none | ❌ |
| Account/pod creation | signup workflow | LWS token exchange only | ❌ |
| Per-pod S3 key scoping | `key-scoping` | storage infrastructure | ❌ |
| SAI discovery (authorization agent, registry set, web push) | `Discovery`, AgentIdHandler | LWS storage description/AS metadata | 🟡 (different model) |
| Multi-worker / multi-replica | Postgres/SPARQL/S3 shared | in-memory grant cache | ❌ |

---

## 4. Detailed gaps

### 4.1 Scopes and inheritance

SAI’s scopes are the core of its authorization model:

- `AllFromAgent`: every registration/instance of a shape tree for an agent.
- `AllFromRegistry`: every instance in a data registration.
- `SelectedFromRegistry`: specific instance(s) in a registration.
- `Inherited`: child grants that inherit from a parent grant (`inheritsFromGrant`/`hasInheritingGrant`).
- `AllFromRole`: every resource granted to a role’s members.

LWS targets are **exact URIs**. There is no recursive target and no registration/shape-tree/role concept. You can enumerate current resources, but:

- New instances added later are not covered.
- Enumeration is O(resources) per grant and must be kept in sync.
- `Inherited` chains and `AllFromRole` membership changes have no representation.

This is the biggest enforcement-layer gap. It means LWS grants can express a *snapshot* of a scope, not the scope itself.

### 4.2 Access needs and access requests

SAI’s request is a **need-based** request: an `AccessNeedGroup` with shape trees, required/optional needs, access modes, and inheriting children. The owner approves by mapping needs to authorizations (`satisfiesAccessNeed`) and grants. LWS’s `AccessRequest` is a grant-shaped document: `access` policies with assignee/target/action/constraints. It has no shape tree, no need, no group, no inheritance, no approval status.

The transport is also different:

- SAI: requester UAS → owner’s `issuanceUrl` → registered-agent check → owner-minted IRI → owner’s `AccessRequestRegistry` → approve/deny activity → granted detection.
- LWS: requester → owner’s `.lws/requests/` container → owner reads → owner POSTs a grant. No routing, no registration check, no status, no archive, no detection.

### 4.3 Delegation

SAI’s delegation is a chain: an agent (`grantedBy`) delegates a subset of its grants to an application (`grantee`) while the `dataOwner` stays the resource owner. The endpoint enforces a covering upstream grant, all-or-nothing multi-grant issuance, same data owner, and a revocation endpoint that cascades to inheriting children and multi-hop chains.

LWS has no `grantedBy`, no upstream grant, no inheritance, no all-or-nothing, no delegation revocation. The `client` constraint is not delegation: it restricts which client may use a grant, but does not model who granted it or whether the grantor had authority.

### 4.4 Revocation, roles, admin

LWS revocation is “DELETE the grant resource”. SAI revocation is a workflow:

- `RevokeAuthorizations` removes `DataAuthorization`s and the derived grants.
- Delegation revocation removes a grant and its inheriting child, with idempotent echo and multi-hop handling.
- Role deletion removes matched authorizations and regenerates grants for affected agents.
- Admin revocation removes `AdminAuthorization`, `AdminGrant`, the `hasAdminGrant` marker, and rewrites the ACR.
- All of these emit activities and update registrations/reciprocals.

LWS cannot cascade, cannot revoke a role, cannot update an admin marker/ACR, and cannot emit the corresponding activities.

### 4.5 Invitations, federation, mirroring

SAI is a multi-server system: social-agent registrations, reciprocal registrations, capability-URL invitations, webhook subscriptions, delegated grants from peers, replica mirrors, reconciliation, drift repair, and peer proxying. LWS grants are **storage-local**. There is no cross-server grant propagation, no peer registration, no mirror, no reconciliation. LWS notifications can tell a subscriber that a resource changed, but they do not carry the SAI registration/grant semantics.

### 4.6 Notifications, activity, UI

SAI notifications are activity events: `AuthorizationGranted`, `AccessRequestReceived`, `delegatedGrantsUpdated`, `AdminAuthorizationGranted`, `RoleMembershipChanged`, etc., with pending/done status and actor, delivered to the UI as NDJSON and to peers via webhooks. LWS notifications are generic resource `Create`/`Update`/`Delete` events; the PR explicitly omits the actor. There is no activity type, no pending/done, no admin/reciprocal channel, no UI RPC/events. LWS cannot drive the current UI.

### 4.7 Identity, discovery, storage

LWS adds LWS access tokens and a storage/authorization-server description. SAI’s identity/account layer (WebID, pods, endpoint records, per-pod S3 keys), agent discovery (authorization agent, social/application registrations, registry set, web push), and data model (registrations/instances/shape trees) remain SAI-specific. LWS grants do not replace them.

---

## 5. What LWS grants *can* do for SAI today

With the PR #126 integration and the fixes from `first-look.md`, LWS grants can:

1. **Add external LWS clients** (did:key, CID, OIDC) to SAI data/registry pods with resource-level permissions, alongside SAI’s Solid-OIDC DPoP clients (`solid-lws` accepts both).
2. **Express permissions SAI does not currently express**: client restriction, format/type constraints, dateTime constraints, public `foaf:Agent` grants.
3. **Provide a lightweight external access-request channel**: an LWS client POSTs to `.lws/requests/`; the SAI UAS (admin) reads it and creates a grant.
4. **Share a specific resource with an external LWS agent** (exact target), without going through the full SAI registration/grant workflow.
5. **Notify external subscribers** of resource changes via LWS webhooks (if the subscription storage is adapted to Postgres; see `first-look.md` §4.3).

What it cannot do is replace the SAI UAS/registry/Temporal/UI authorization management. The realistic architecture is:

```
SAI policy engine (source of truth for SAI agents/registrations/roles/admin)
        ∪
LWS AccessGrantReader (external LWS clients, resource-level grants)
        ↓
PermissionReader → AuthorizingHttpHandler → data/registry pods
```

This is exactly the shape PR #126’s `lws-access.json` provides: `UnionPermissionReader([PolicyEngineReader, AccessGrantReader])`.

---

## 6. What full parity would require

### Option A — Keep SAI as source of truth, project to LWS grants

- Materialize LWS grants for each SAI grant/scope.
- `AllFromAgent`/`AllFromRegistry`/`Inherited`/`AllFromRole` become either:
  - one LWS grant per resource (enumeration; stale for new resources), or
  - a new LWS target/scope extension (not in PR #126; interop risk).
- Add a sync workflow: on every SAI grant/role/admin/registration change, create/delete the corresponding LWS grants.
- Keep SAI access requests/activities/notifications/UI.
- **Result:** external LWS clients see a projection; SAI remains authoritative. This is feasible but the projection is lossy and operationally heavy.

### Option B — Rebuild SAI management on LWS primitives

- Add access needs/requests, delegation, revocation cascade, roles, admin/org, invitations, federation, activities, notifications, UI on top of LWS grants.
- Essentially reimplement the SAI UAS/registry/Temporal layer with LWS as the storage model.
- **Result:** full LWS-native parity, but a large rewrite; not provided by PR #126.

### Option C — Hybrid (recommended)

- Keep SAI grants/policy engine for SAI agents, registrations, roles, admin, invitations, federation, activities, UI.
- Add LWS grants as a second `PermissionReader` for external LWS clients and resource-level sharing.
- Add LWS access requests as an external intake channel; the UAS translates them to SAI access requests or directly to grants.
- Add LWS notifications only if external LWS subscribers are needed; otherwise keep SAI notifications.
- **Result:** interoperability without losing SAI functionality; partial parity by design.

---

## 7. Test-by-test coverage map

| Test file | What it proves | LWS grant parity |
|---|---|---|
| `policy-engine.test.ts` | Public/protected resources; agent/client/UAS; scopes `AllFromRegistry`, `SelectedFromRegistry`, `Inherited`; admin `DataRegistry` read; CRUD | 🟡 exact-resource + agent/client yes; scopes/admin no |
| `authorization.test.ts` | `AuthorizeApp` → pre-minted DAs → activity → grants; deny is forward-only | ❌ management/workflow; only final grant document |
| `authorizations.test.ts` | List authorizations incl. inherited children | ❌ no authorization model |
| `access-request.test.ts` | Need-based request sent/received; embedded group; owner-minted request | 🟡 transport only; no need/group/status/routing |
| `delegation-endpoint.test.ts` | Delegation issuance/revocation; covering grant; all-or-nothing; multi-hop; mixed owner | ❌ no delegation |
| `authorization-revocation.test.ts` | Revoke authorizations + derived grants; idempotent | 🟡 single grant delete; no cascade |
| `roles.test.ts` | Role create/update/delete; membership → grant create/revoke; `AllFromRole` | ❌ no roles |
| `personal-admin.test.ts` | Add/remove personal admin; AA + grants + marker + ACR; reciprocal event | ❌ no admin/ACR |
| `org-context.test.ts` | Org discovery, registry set, admin gating, last-admin guard, peer proxy | ❌ no org/admin |
| `admin-events.test.ts` | Admin channel, pending/done, ACR rewrite, cross-org isolation | ❌ no admin channel/activity |
| `invitation.test.ts` | Personal/admin invitations; capability URL; reciprocal registration | ❌ no invitations/registration |
| `federation-mirror.test.ts` | Reciprocal mirror; grant write refreshes replica; grant bodies resolvable | ❌ no federation/mirror |
| `reconciliation.test.ts` | Pending replay; drift re-create; mirror completeness; upstream freshness | ❌ no reconciliation |
| `reciprocal-webhook.test.ts` | `delegatedGrantsUpdated` pending/done | ❌ no activity semantics |
| `share.test.ts` | Share instance with social agent; `SelectedFromRegistry` + `hasDataInstance`; grantee view | 🟡 final resource permission; no registration/workflow |
| `check-equivalence.test.ts` | Unchanged regeneration reuses IRIs; delegated subtree reuse | ❌ no equivalence/reuse |
| `account-creation.test.ts` | WebID, pods, endpoint records | ❌ identity/account layer |
| `services.test.ts` | auth/registry/data/id services | ❌ not authorization grants |
| `agents.test.ts` / `agent-discovery.test.ts` / `discovery.test.ts` | Agent discovery, registrations, storage description, redirect, web push | 🟡 storage description overlap; no SAI discovery |
| `key-scoping.test.ts` | Per-pod S3 bucket/key isolation | ❌ storage infrastructure |
| `policy-engine` + `temporal.c4` | The full end-to-end flows | See matrix |

---

## 8. Protocol vs data model: can SAI ride on LWS access requests/grants?

**Short answer:** yes as a **container/transport**, no as a **semantic replacement**.

LWS fixes the *protocol* (where the document lives, what shape it must have, how it is validated, who may create it, and what the built-in reader enforces). It does not fix the *meaning* beyond the LWS `access` policies. SAI's model is richer; it can be carried inside an LWS document, but the LWS server will not enforce it.

### 8.1 What the LWS protocol fixes

`AccessGrantUtil.validateAccessDocument` requires:

- `@context` includes `https://www.w3.org/ns/lws/v1`
- `type` includes `AccessGrant` or `AccessRequest`
- `storage` equals the storage of the target
- `access` is a non-empty array of LWS `AccessPolicy` objects
- each policy has an `assignee` URI, at least one action, an optional `target` inside the storage (`DataResource`/`Container`/`StorageResource`), and optional constraints (`client`, `format`, `type`, `dateTime`, `purpose`)

`AccessDocumentOperationHandler` stores the original JSON text and restricts methods/targets (`.lws/` cannot be granted). `AccessGrantIndex` parses each member with `validateAccessDocument`; `AccessGrantReader` evaluates only `grant.access`. This is the **current CSS implementation of the ODRL Access Profile**. The spec's `access` property is profile-based: the ODRL profile is only one profile, and “Other profiles could use a different conceptual framework.” A SAI profile can define its own `access` objects, additional target types, and additional properties. The current CSS reader only knows the ODRL profile; a SAI reader would know the SAI profile.

### 8.2 What is free-form

The spec explicitly says “Other properties MAY be present on access requests and access grants”, additional `type` values MAY be included, and “A server MAY support additional type values” for targets. The CSS validator also ignores extra properties, and `AccessDocument` is declared with `[key: string]: unknown`. The handler writes the original text (`new BasicRepresentation(text, ...)`) and the index keeps the parsed object. Therefore you can add:

- SAI `@context`/`@type`
- `DataGrant`/`DataAuthorization` fields (`grantedBy`, `dataOwner`, `registeredShapeTree`, `hasDataRegistration`, `hasDataInstance`, `scopeOfGrant`, `inheritsFromGrant`, ...)
- `AccessNeedGroup`/`AccessNeed` for requests
- links/back-links (`satisfiesAccessRequest`, `satisfiesAccessNeed`)
- role/admin/invitation metadata

Those fields survive storage/retrieval, but **LWS's built-in `AccessGrantReader` ignores them**. Only a custom SAI reader/engine would interpret them. If you also include a valid LWS `access` array, standard LWS clients see the LWS projection; SAI clients see the extra model.

### 8.3 SAI → LWS mapping

| SAI | LWS | Fit |
|---|---|---|
| `DataGrant.grantee` | `AccessPolicy.assignee` | good for WebID/app; a role IRI does not expand to members |
| `DataGrant.accessMode` | `action` (`read`/`modify`/`create`/`delete`) | good |
| `DataGrant.hasDataInstance` (SelectedFromRegistry) | `lws:DataResource` target | good only for selected instances; it is not a general mapping |
| `DataGrant.hasDataRegistration` (AllFromRegistry) | `lws:Container` target with member/recursive scope | the registration is an LWS Container; needs container-member scope |
| `DataGrant.registeredShapeTree` | `st:ShapeTree` target | the shape tree is the scope; the target value is the shape tree IRI |
| `DataGrant.scopeOfGrant` = AllFromAgent/AllFromRegistry/Inherited/AllFromRole | `lws:StorageResource`/`lws:Container`/`lws:DataResource`/`st:ShapeTree` + `assignee`/`sai:dataOwner`/`inheritsFromGrant` | use LWS/ST target types; role is `assignee`, not target |
| `DataGrant.grantedBy` / `dataOwner` | none | embed as extra; LWS has no delegation/authority check |
| `DataAuthorization.scopeOfAuthorization` | none | no |
| `AccessNeedGroup` / `AccessNeed` | none; request is grant-shaped | embed as extra; LWS requires a valid `access` array |
| `Role` | assignee URI | no membership expansion |
| `AdminGrant` / `AdminAuthorization` | none | no admin/org/ACR semantics |
| `Activity` / pending-done / actor | none | no |

### 8.4 Gaps to close in a SAI profile

- **Per storage vs per owner/registry.** LWS grants/requests are scoped to one `storage` and live under that pod's container endpoint. SAI grants/requests are owner/registry-scoped and `AllFromAgent` can span multiple storages. A SAI profile needs one LWS document per storage plus an SAI-side group/index (`sai:grantGroup`).
- **No recursion/inheritance in the ODRL target types.** `AllFromRegistry`, `AllFromAgent`, `Inherited`, and `AllFromRole` cannot be represented by `DataResource`/`Container`/`StorageResource` targets. The spec allows additional target types, so a SAI profile can define `sai:ShapeTree`, `sai:DataRegistration`, `sai:DataInstance`, `sai:Role`, etc., with recursive/inherited matching. Without those, enumeration is a snapshot, not a scope. See §8.9 for the target-selector design and issue #280.
- **No `grantedBy`/delegation in the ODRL profile.** The LWS `client` constraint is not delegation; it restricts the client, not the grantor or upstream authority. A SAI profile adds `sai:grantedBy`/`sai:dataOwner` and a SAI reader/engine for the authority check.
- **No access needs/status in the ODRL profile.** LWS access requests are immutable; there is no `AccessNeedGroup`, approval/denial record, archive, or granted-detection. The spec allows other profiles and additional properties, so a SAI profile can add `sai:hasAccessNeedGroup` and keep status in SAI activities/resources. The `access` array can contain SAI-profile objects; the current CSS handler only accepts ODRL `AccessPolicy` objects.
- **Immutability.** The spec keeps grants as immutable records; SAI role/membership changes replace grants. You can DELETE+POST with `sai:replaces`, but the LWS grant IRI changes and there is no atomic replace/audit. This is a spec-level trade-off, not just CSS.
- **Open request creation.** The spec says an agent creates an access request by POST; SAI requires a registered social agent. The SAI profile/server can enforce the registration check; it is not a protocol limitation.
- **Constraint evaluation on SAI's store.** LWS `format`/`type` constraints read the stored representation metadata. SAI's hybrid store may expose `internal/quads` for RDF resources and metadata-only types, so these constraints need verification; `client`/`dateTime` are safe.

### 8.5 Three integration patterns

1. **LWS as transport + custom SAI reader.** Embed the SAI JSON-LD in the LWS document; include a valid LWS `access` projection (or a no-target policy if you only want transport). Add a `SaiLwsGrantReader` to the `UnionPermissionReader`; it reads the embedded SAI model from `.lws/grants/` and enforces SAI semantics. LWS clients see only the LWS projection; SAI clients see the full model. This is the only way to keep full SAI semantics over the LWS protocol, but it is a custom profile, not standard LWS.
2. **Projection.** Map each SAI `DataGrant` to LWS policies at issuance; keep the SAI model in the registry as the source of truth. Standard LWS clients get permissions; SAI semantics are lossy (scopes/roles/inheritance need enumeration; new resources are not covered; re-project on change). Good for external LWS clients, not for replacing SAI grants.
3. **Extend LWS.** Add SAI target types/scopes/roles/needs to the LWS Access Profile and teach the reader; not in PR #126, interop risk. This is the only path to standard LWS clients understanding SAI semantics.

### 8.6 Verdict

- **Can SAI's data model be carried over LWS access requests/grants?** **Yes.** The spec allows other properties, additional types, additional target types, and other access profiles. A SAI Access Profile can make the SAI model the `access` profile rather than merely extra JSON-LD.
- **Can LWS enforce SAI's data model?** The **current CSS reader** does not; it only knows the ODRL profile. A **SAI profile reader** can enforce SAI semantics, and the spec leaves policy enforcement out of scope. So this is an implementation gap, not a protocol limit.
- **Can SAI's model replace the LWS `access` policies?** **Yes, as a SAI access profile inside the required `access` array.** The current CSS implementation only supports the ODRL profile, but the spec explicitly allows other profiles. For standard LWS clients, include a projected ODRL `access` object alongside the SAI profile object (or use a separate ODRL endpoint).
- **Can standard LWS clients understand SAI semantics?** **No**, unless they support the SAI profile or you include a projected ODRL profile object.
- **Practical answer:** use LWS as the **container/transport** and define a SAI Access Profile; add a SAI reader/handler in CSS; project to ODRL for standard LWS clients. Or keep SAI's model in the registry and use LWS grants only as a projection for external LWS clients.

---

### 8.7 If the spec/CSS can change: a SAI Access Profile

The “no” above is about the **current** LWS draft and CSS reader. If both are changeable, the LWS core protocol is a viable substrate for SAI's model as a **profile**. The core gives you the containers (`.lws/requests/`, `.lws/grants/`), LWS authorization server + token exchange (did:key/CID/OIDC), immutable grant documents, request creation, inbox notification, and JSON-LD documents with extensible properties. The data model can be extended without changing the transport.

A SAI profile would add:

1. **Profile identity.** `@context` includes LWS + SAI; `type: ["AccessGrant", "sai:DataGrant"]` and `type: ["AccessRequest", "sai:NeedBasedAccessRequest"]`; optionally a `profile`/media-type parameter.
2. **SAI fields.** `sai:grantee`, `sai:grantedBy`, `sai:dataOwner`, `sai:registeredShapeTree`, `sai:hasDataRegistration`, `sai:hasDataInstance`, `sai:scopeOfGrant`, `sai:inheritsFromGrant`, `sai:accessMode`, `sai:satisfiesAccessNeed`, `sai:satisfiesAccessRequest`, `sai:grantGroup`, `sai:replaces`, `sai:activity`.
3. **Target/scope types.** `sai:ShapeTree`, `sai:DataRegistration`, `sai:DataInstance`, `sai:Role`, `sai:Agent`, `sai:Registry`, with defined matching:
   - `ShapeTree`: all instances of the tree for the data owner, current and future.
   - `DataRegistration`: all instances in the registration, current and future.
   - `DataInstance`: exact instance.
   - `Role`: all resources granted to the role's members, current and future.
   - `Agent`: all resources granted to the agent.
   - `Registry`: all registrations/instances in a registry.
4. **Actions.** Keep `read`/`modify`/`create`/`delete`; map `acl:Read/Create/Update/Delete`. Add `control`/`grant` only if SAI needs them.
5. **Access needs.** Allow `sai:hasAccessNeedGroup` in an `AccessRequest`. Either keep a no-target LWS policy as the projection, or make `access` optional for the profile. Keep the request immutable; put status/approval/denial in SAI activities/resources.
6. **Lifecycle.** Keep LWS immutability; use `sai:replaces`/`sai:revokes` plus delete-old for role/membership changes. If you allow profile-specific updates, you trade away the “grants cannot be modified” security property.
7. **Cross-storage.** One LWS grant per storage, grouped by `sai:grantGroup`/`sai:dataAuthorization`; the SAI reader aggregates. This keeps the LWS core storage-scoped.
8. **Roles/admin.** `sai:Role`/`sai:AdminGrant` fields; the SAI reader expands them. Standard LWS clients get projected individual grants, or nothing.
9. **Notifications.** Add `sai:activity`/`sai:actor` to LWS notifications, or keep SAI notifications separate. Standard LWS clients ignore unknown fields.
10. **CSS.** Add `SaiAccessDocumentOperationHandler` (profile validation), `SaiAccessGrantReader` (profile enforcement), `SaiAccessRequestHandler` (UAS intake), profile context/components, and a shared grant cache for multi-worker.
11. **UAS/AS bridge.** The SAI UAS uses LWS token exchange (OIDC ID token → LWS access token for the storage) to write `.lws/grants/`/`.lws/requests/`, or keeps writing to the registry and projects. The LWS AS is per-storage; the SAI UAS is per-agent; token exchange bridges the two.
12. **Interop.** Standard LWS clients only understand the LWS `access` projection. If you need both SAI semantics and standard LWS clients, include a projected LWS `access` array alongside the `sai:*` fields, or standardize the profile.

What remains hard even with a profile:

- **Cross-storage scopes.** LWS core is storage-scoped; `AllFromAgent` across storages needs one grant per storage plus a group/index.
- **Immutability vs role/membership changes.** Replacement links + delete-old are workable but not atomic; grant IRIs change unless you use stable `sai:grantGroup`/`sai:dataAuthorization` identifiers.
- **Access requests are grant-shaped.** Need-based requests need a profile extension; the core validator currently requires a non-empty `access` array.
- **Standard LWS interop.** A SAI profile is not standard LWS; standard clients need the projection or profile support.
- **Authority model.** The LWS AS issues storage access tokens; the SAI UAS issues grants. The profile must define who may write `.lws/grants/` and how the UAS proves authority (owner/admin via the data pod's policy engine, or a delegated grant).

Two viable architectures:

- **A. LWS as substrate (SAI profile).** SAI grants/requests live in `.lws/` documents with `sai:*` fields; a `SaiAccessGrantReader` enforces SAI semantics; a projected LWS `access` array keeps standard LWS clients working. This makes LWS the grant/request store, with SAI as a profile. Larger spec/CSS change, but the SAI model is first-class.
- **B. SAI as source of truth, LWS as projection.** SAI keeps grants/requests in the registry and workflows; LWS grants are projected for external LWS clients. Minimal spec/CSS change; SAI semantics stay intact; external clients get a lossy snapshot.

If the goal is “SAI model over LWS protocol” rather than “LWS grants only”, **A** is the coherent design: keep the LWS core invariants, define a SAI profile, implement it in CSS, and project to the LWS `access` array for interoperability. **B** is the lower-risk incremental path if you want to keep the current SAI architecture.

### 8.8 Spec check: what the current LWS draft already allows

The current LWS core draft (`w3c/lws-protocol`, `lws10-core/lws-access-requests.html`) is more permissive than the CSS implementation suggests:

- **Endpoints are LWS containers.** The spec says: “The access request and access grant endpoints are LWS containers and MUST conform to the rules defined in this specification.” GET and POST are required; DELETE is recommended. The URL is not fixed: the storage description advertises `AccessRequestService` / `AccessGrantService` service objects with a `serviceEndpoint` and `conformsTo` profile URIs. CSS's `.lws/requests/` and `.lws/grants/` are an implementation choice, not a spec requirement. You can use SAI-specific container endpoints, as long as they are LWS containers and are advertised.
- **Other profiles are explicitly allowed.** The spec's ODRL-based profile is “one profile”; “Other profiles could use a different conceptual framework.” The `access` property is a collection of one or more objects whose shape is determined by the supported profile(s). A SAI Access Profile can define `sai:DataGrant` / `sai:NeedBasedAccessRequest` objects inside `access`.
- **Other properties and types are allowed.** “Other properties MAY be present on access requests and access grants.” Additional `type` values MAY be included. “A server MAY support additional type values” for targets. So SAI fields, additional types, and generalized target types are spec-compatible.
- **Targets are extensible.** The spec defines `DataResource`, `Container`, and `StorageResource` target types, but explicitly allows additional ones. A SAI profile can define `sai:ShapeTree`, `sai:DataRegistration`, `sai:DataInstance`, `sai:Role`, `sai:Agent`, `sai:Registry`, with recursive/inherited matching. Standard LWS clients need the profile or a projected ODRL target.
- **Access grants are records, not tokens.** “An agent does not present an access grant to a server as an authorization token. Rather, the access grant serves as a record of what was authorized...” and “The interaction between an access grant endpoint and a particular policy enforcement layer is out of scope.” This is the key decoupling: the owner/controller can issue SAI authorizations, project them to access grants, and a SAI policy engine can enforce SAI semantics. LWS does not require the grant to be the only policy source.
- **Notifications are inbox-oriented but not exclusive.** The `inbox` property is optional. The access request/grant section says the server SHOULD notify the request's inbox on grant creation, but the section itself says it “needs to align with the yet-to-be-defined notification section of LWS.” The separate LWS notification suite defines webhook subscriptions; subscription authorization requires read access to all topics, and delivery-time authorization requires read access to the changed resource. A grantee can therefore subscribe to the access grant container or to specific grant resources if the access control lets them read those resources. Caveats: a subscription to the whole grant container exposes every grant the grantee can read (privacy); prefer per-grant read access or a filtered per-grantee container. The grantee also needs to discover the grant IRI (via the container listing, an SAI activity, or a notification). The notification data model already has an optional `actor` and ActivityStreams activities, so SAI can add activity/actor semantics.
- **Access requests can be need-based.** The `AccessRequest` document can carry `sai:hasAccessNeedGroup` as an additional property or as part of a SAI profile object in `access`. The owner/controller reads it, issues SAI authorizations, projects them to access grants, and makes them available. The `access` array is required, but a SAI profile object (or a no-target ODRL policy for pure transport) satisfies it.

What still needs changing:

- **CSS:** a SAI profile validator/handler, a `SaiAccessGrantReader` with SAI target matching, a SAI request intake handler, profile context/components, a shared grant cache for multi-worker, and the grant-container access control/subscription plumbing.
- **Spec:** define the SAI profile URI, its `access` object shape, additional target types and matching semantics, the need-based request profile, and align the access request/grant notification section with the webhook notification suite (including per-grantee filtering/read semantics).
- **Interop:** include a projected ODRL `access` object alongside the SAI profile object (or a separate ODRL endpoint) for standard LWS clients; advertise the SAI profile in `conformsTo`.
- **Architecture:** decide whether the LWS access grant container is the canonical SAI grant store or a projection of the registry; if canonical, the registry's `hasDataGrant` links and replica/federation logic must follow.

### 8.9 Target abstraction (discussion #283, issue #280)

`hasDataInstance -> target` is a category error. `hasDataInstance` is only the `SelectedFromRegistry` case. SAI’s other scopes are dynamic: `AllFromRegistry`, `AllFromAgent`, `Inherited`, and `AllFromRole` cover resources that may not exist at grant time and may change during the grant’s life. Flattening them to a `hasDataInstance` list turns a scope into a snapshot.

The current LWS target is `{ type, value[] }` with `DataResource`/`Container`/`StorageResource` matchers. The spec allows additional target type values, but the CSS `matchesTarget` requires an exact path, and issue #280 notes that granting to container members is not possible today. Discussion #283’s resource-type-constraints point and issue #280’s “container members / type-based access” point are the same problem: **the target needs to be a selector, not an instance list.**

#### A target selector

```json
{
  "type": "AccessPolicy",
  "assignee": "https://id/bob",
  "action": ["read"],
  "target": {
    "type": "st:ShapeTree",
    "value": ["https://data/shapetrees/trees/Project"]
  },
  "constraint": [
    { "leftOperand": "type", "operator": "eq", "rightOperand": "https://www.w3.org/ns/lws#DataResource" }
  ]
}
```

- `target.type` — the matcher kind (term or URI).
- `target.value` — the matcher parameters (shape tree, registration, instance, type, storage root).
- `constraint` — a sibling of `target` on the **AccessPolicy**, not a property of `target`. It narrows the access being requested/granted (resource type, format, client, dateTime, …) and applies to **all targets in that policy**. Use separate `AccessPolicy` objects if different targets need different constraints.
- Optional `recursive`/`depth` on the target for container/storage scopes; optional `include`/`exclude` for composition. These are profile extensions; the current spec target object is only `{ type, value }`.

The key semantic change: **the selector is stored in the grant and resolved at authorization time**, not expanded to a resource list at grant creation. The reader asks “does this resource match the selector?” — so new instances, new container members, and new role members are covered.

#### Matcher kinds

Prefer existing LWS and Shape Tree terms; SAI-specific meaning belongs in the `sai:*` fields, not in new target types.

| Matcher | Value | SAI use |
|---|---|---|
| `lws:DataResource` | resource URI | `SelectedFromRegistry` (`DataInstance`); exact resource |
| `lws:Container` | container URI | `AllFromRegistry` (`DataRegistration`) with member/recursive scope; registry containers; exact container when not recursive |
| `lws:StorageResource` | storage URI | `AllFromAgent`/whole-storage scopes; `sai:dataOwner` identifies the agent |
| `st:ShapeTree` | shape tree URI | shape-tree-scoped grants; resources whose registration has that shape tree |
| `lws:ResourceType` | type URI | generic type scope (optional) |
| `lws:Query` | type-search query | optional; search-index integration |

**Role is not a target.** In SAI, `AllFromRole` puts the role in `assignee`; the target remains the data scope (`st:ShapeTree`, `lws:Container`, or `lws:DataResource`). The SAI reader expands role membership. Likewise `AllFromAgent` uses the owner's storage/container target plus `sai:dataOwner`; the agent is the owner/assignee, not the target. `Inherited` uses `sai:inheritsFromGrant` plus the parent's target; no separate target type. `sai:DataRegistration` is `lws:Container`; `sai:DataInstance` is `lws:DataResource`; `sai:Registry` is the registry container; no SAI-specific target types are needed.

SAI scope → LWS target:

| SAI scope | Target selector | Assignee / fields |
|---|---|---|
| `AllFromAgent` | `lws:StorageResource` (owner storage) or `lws:Container` | `assignee` = grantee; `sai:dataOwner` = owner |
| `AllFromRegistry` | `lws:Container` (registration) with member/recursive scope | `assignee` = grantee; `sai:dataOwner` = owner |
| `SelectedFromRegistry` | `lws:DataResource` (instance) | `assignee` = grantee; `sai:dataOwner` = owner |
| `Inherited` | parent grant's target + `sai:inheritsFromGrant` | `assignee` = grantee; `sai:dataOwner` = owner |
| `AllFromRole` | `st:ShapeTree` / `lws:Container` / `lws:DataResource` | `assignee` = role IRI; reader expands members |
| `AllFromAgent` + shape tree | `st:ShapeTree` | `assignee` = grantee; `sai:dataOwner` = owner |

`st:ShapeTree` is a property-based matcher, not a resource `rdf:type` filter: it matches resources whose registration has `interop:registeredShapeTree` equal to the value. `lws:ResourceType` is the `rdf:type`-based matcher; the Type Search Service can resolve it directly. The Type Search Service can resolve `st:ShapeTree` only if the server indexes the shape-tree relation (it allows additional indexed relations); otherwise the SAI reader resolves it from the registry.

This is a matcher registry, not a closed enum. A server advertises supported target types/profile in the storage description (`conformsTo`), and rejects unsupported matchers with a clear error.

#### Requests, grants, and interop

- **Requests:** a requester can ask for `st:ShapeTree`/`lws:Container`/`lws:ResourceType` without knowing instance URIs. The owner resolves the selector against their own data and issues the grant. “Storage root as target + resource type constraint” is a valid request shape once `lws:StorageResource` is defined as a scope (not an exact root) and `constraint` narrows it.
- **Grants:** the owner can issue a grant with the same selector. The SAI reader resolves it at authorization time; the grant is not invalidated by new instances/members. `AllFromRole` keeps the role in `assignee`, not in `target`.
- **Standard LWS clients:** they will not understand `st:ShapeTree` unless the profile is standardized. Include a projected ODRL target (concrete current resources) alongside the SAI selector, or expose a separate ODRL endpoint. The `conformsTo` profile tells clients which matchers the server supports.
- **Search index:** `lws:ResourceType`/`st:ShapeTree` can be resolved through the Type Search Service (`application/lws-query+json`, type CNF, indexed relations). The search index is an implementation aid; the grant reader must resolve with the owner/storage authority, not the requester’s filtered view. Eventual consistency of the index must not weaken authorization: the authoritative registry/store should be the final check.
- **Revocation:** target abstraction does not solve delegation-chain revocation. The discussion’s POST revocation request is a separate, compatible change: a revocation request can name the grant/group/chain and the owner/controller cascades the revocation; DELETE on a single grant is too local.
- **Terminology:** align SAI with the discussion’s `storage controller`, `delegator`, `delegatee`: `assignee` is the delegatee, `sai:delegator`/`sai:grantedBy` is the requesting agent/grantor, `sai:dataOwner`/storage controller is the resource owner. This supports delegation and auto-approved attenuated grants.
- **Client constraints:** SAI’s attenuated delegation to a client needs the client to read the grant (for discovery and for the grant’s own constraints). The LWS `client` constraint is one mechanism; the SAI profile can add `sai:delegatedTo`/`sai:attenuatedFrom` and a grant-read rule. The client can then subscribe to the grant container/grant resource via webhook notifications.

#### What to change

- **Spec:** define target matchers as an extensible registry; define `StorageResource`/`Container` scope and recursion; define selector resolution at authorization time; define `conformsTo` profile advertisement; align resource-type matchers with the Type Search/Index service; define revocation-as-request for delegation chains; clarify `assignee` vs `delegator`/`delegatee`.
- **CSS:** replace the exact-path `matchesTarget` with a matcher registry; allow additional target types in `validatePolicy`; add SAI matchers (`ShapeTree`, `DataRegistration`, `Role`, …) resolved against the registry/store; add a projected ODRL target for standard clients; add grant-read rules for delegatees/clients; add webhook subscription support on grant containers/resources.
- **SAI:** express scopes as target selectors, not `hasDataInstance` lists; keep `hasDataInstance` only for `SelectedFromRegistry`; carry the selector in the grant document and resolve it in the SAI policy engine; use `delegator`/`delegatee`/`dataOwner` terminology.

## 9. Bottom line

- **Can LWS access grants support all current functionality?** **No.**
- **Can they express the final resource-level permission?** Mostly yes, for exact resources, agents, actions, and client/format/type/time constraints.
- **Can they express SAI’s scopes, roles, admin, registrations, delegation, access needs, invitations, federation, activities, or UI?** No. Those are the majority of the current functionality.
- **What is the best use?** Complementary: keep SAI’s policy engine and management layer as the source of truth; add LWS grants as a second reader for external LWS clients and resource-level sharing. PR #126 already supports this via `UnionPermissionReader`.
- **If the goal is “LWS clients can access SAI data with grants issued by the UAS”**, that is achievable with PR #126 plus the `first-look.md` fixes (child metadata, JSON document preservation, subscription storage, `.lws` policy paths).
- **If the goal is “replace SAI’s grant system with LWS access grants”**, that is not achievable without either a lossy projection layer or a significant LWS extension/rewrite. Feature parity at the management layer is effectively zero today.
