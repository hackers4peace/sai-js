# Components SAI-logic tweaks — residual domain/spec logic still in components

> **Status:** design only — investigation write-up. No code changed. The four
> phases of `reorganize-authz-agent-logic.md` are done; this plan tracks the
> **residual SAI domain/spec logic that still lives in components** — the
> items explicitly deferred in that plan's §9 plus two new findings surfaced
> by re-investigating `packages/components/` against the AA-owned domain
> layer.

## 1. Problem

After `reorganize-authz-agent-logic.md` (Phases 1–4, ✅ done) the
authorization-agent owns the SAI domain layer — `sparql.ts` (registry-plane
queries incl. `findDelegableGrant`/`getGrantsAuthority`/`findInheritingChildren`),
`authorization.ts` (`matchesScope`, `buildNestedDataAuthorizations`),
`grant-generation.ts` (`dataInstanceIrisForGrant`, the grant-generation chain),
session methods (`recordAuthorizationFromStructure`, `revokeGrants`,
`findAffectedGrantees`, `findRoleUsage`, `getGrantees`, admin-authorization
block, reciprocal federation) — and components keeps CSS handlers, storage,
RPC adapters, webhooks, admin gate, proxy/mirror, and Temporal orchestration.

A re-investigation of `packages/components/` found the following **SAI
domain/spec logic still embedded in components**, in three buckets:

1. **No AA counterpart exists for it** (new findings): the data-plane
   grant-**evaluation** predicates in `SaiPermissionsEngine`, and the
   admin-marker (`hasAdminGrant`) rule — implemented four times across
   components with different transports.
2. **It mirrors already-moved AA logic** (new findings): the
   delegation-endpoint inheritance completion in `GrantIssuanceHandler` and
   the AdminGrant **materialization** rule in `temporal/activities/admin.ts`
   mirror AA's `generateDataAuthorizations` / `generateGrantsForAuthorization`
   respectively.
3. **Explicitly deferred in plan §9**: org-context registry reads + UI
   shaping (`services/Authorization.ts`, `services/DataRegistry.ts`),
   the admin-marker reciprocal read (`buildSocialAgentProfile`), HTTP
   `AgentRegistry.findRegistration` in `getExistingGrants` /
   `replaceDataGrantsOnRegistration`.

## 2. Current state (as-is)

### 2.1 `SaiPermissionsEngine` — the data-plane grant-evaluation rules

`packages/components/src/SaiPermissionsEngine.ts` implements the SAI
"which grant authorizes this request" semantics entirely as inline SPARQL
over the shared store (data sourced by `SaiAuthorizationManager`, which
collects grants by `INTEROP.hasStorage`):

- `findGrant` — grant→request matching: the UAS branch
  (`grantee: agent` with the requester's UAS as client) vs the
  non-UAS branch (`grantedBy: agent` + `grantee: client`), scope dispatch,
  and `SelectedFromRegistry` ⇒ `hasDataInstance` containment;
- `findRegistrationModes` / `findResourceModes` / `findInheritedModes` —
  `AllFromRegistry` / `SelectedFromRegistry` / `Inherited` evaluation;
- `findParentResource` — the Inherited-grant chain: resolve the parent grant
  (`inheritsFromGrant`), find the parent *instance* via the parent shape
  tree's reference predicate (`viaPredicate`) in the instance graphs, then
  recursively evaluate the parent's permissions;
- `findAdminModes` — admin detection per storage (`AdminGrant` +
  `scopeOfAdminGrant: DataRegistry`, §2.8 of org-admin-feature.md);
- `determineTargetType` — Registry/Registration/Resource classification from
  the storage hierarchy.

The AA owns the sibling rules (`matchesScope`, `findDelegableGrant`,
`dataInstanceIrisForGrant`) but nothing on the **grant-evaluation** side.
`reorganize-authz-agent-logic` §4 Phase 4's keep-list says the engine
"stays a server concern" (a policy-engine integration) **but** "grant-matching
rules may share AA predicates" — the predicates were never extracted.

### 2.2 The `hasAdminGrant` admin-marker rule — four duplicated implementations

The org-admin rule — "a registration with non-empty `hasAdminGrant` links ⇒
admin" — is implemented independently in:

| Location | Variant |
|---|---|
| `services/Context.ts` `isAdminOf` | reciprocal-based: the user's registration of the org → the org's registration of the user (`reciprocalRegistration`) → `getAdminGrantIris` (personal context) |
| `services/adminGate.ts` `requireOrgAdmin` | the **org's** session's registration of the caller → `getAdminGrantIris` (shared by `AdminSparqlHandler` + `ProxyAdminHandler`) |
| `AgentIdHandler.ts` | the org's session's registration of the caller → `getAdminGrantIris`, gates the `Link: rel="interop:hasRegistrySet"` header (§2.3) |
| `services/AgentRegistry.ts` `buildSocialAgentProfile` | display variant with the `personal` (reciprocal) vs `!personal` (direct) asymmetry |

`getAdminGrantIris` (data-model) is just a predicate extractor; the **rule**
(which registration to read, and that non-empty ⇒ admin) is org-admin domain
logic with no AA session method. Plan §9 flags the `buildSocialAgentProfile`
variant as deferred; the re-investigation found the other three.

### 2.3 Delegation-endpoint inheritance completion — `GrantIssuanceHandler`

`packages/components/src/GrantIssuanceHandler.ts` `issue`/`buildInheritingGrant`:

- assigns grant IRIs via `iriForContained(sai.registrySet.hasGrantRegistry, ...)`;
- completes the child grants embedded by the requester (AA's
  `generateDelegatedDataGrants` / `generateChildDelegatedGrantData` produce
  the `Inherited` payload with no id) into `FinalGrantData`, wiring
  `inheritsFromGrant` and the parent's `hasInheritingGrant` list;
- then validates every grant with `findDelegableGrant` (AA) before the
  Temporal store.

The IRI-assignment + inheritance wiring is the exact grant-side mirror of
AA `generateDataAuthorizations` (`authorization.ts`, which does the same for
authorizations), and the completing half of the AA's grant-generation chain.

### 2.4 AdminGrant materialization — `temporal/activities/admin.ts`

`buildAdminGrants` constructs the admin's grant payloads: one
`RegistrySet`-scoped `AdminGrant` (the marker, linked on the registration)
+ one **Read-only** `DataRegistry`-scoped `AdminGrant` per data registry
(`hasStorage`, `accessMode: [acl:Read]`) — the org-admin R1 rule for what an
admin's grants look like. The AA owns the *Authorization* side
(`recordAdminAuthorization`/`findAdminAuthorization`/`deleteAdminAuthorization`)
but the grant-materialization sibling of
`generateGrantsForAuthorization` (relocated in Phase 3) was left in
components. The ACR write (`createAdminGrantAcr`, the `#fullAdminAccess`
rewrite in `syncAdminAcr`) is WAC/ACP automation and stays.

### 2.5 Deferred by plan §9 (reaffirmed, with one overlap worth reusing)

- `services/Authorization.ts` — `findUserDataRegistrations`,
  `findSocialAgentDataRegistrations`, `getDescriptions`, `formatAccessNeed`:
  org-context registry reads + UI shaping over `queries/org.ts`. Note
  `findSocialAgentDataRegistrations` re-implements scope counting (skip
  `Inherited`, `SelectedFromRegistry` via `hasDataInstance`,
  `AllFromRegistry` via `contains`) — display-shaping over the registry
  plane, but it could reuse AA's `dataInstanceIrisForGrant`/`matchesScope`
  predicates instead of its own conditions.
- `services/DataRegistry.ts` — `dataGrantIndexForAgent`, registry/instance
  listings; role/registration listings: same deferral (context transport +
  display shapes).
- `temporal/activities/grants.ts` `getExistingGrants` /
  `replaceDataGrantsOnRegistration` — still HTTP `AgentRegistry.findRegistration`
  (already AA module code) instead of the registry plane; a session
  `findRegistration` over the plane would replace it.

## 3. Candidate moves (design)

### 3.1 Extract the policy-engine *predicates* to AA (engine stays a plugin)

Move the pure grant-evaluation semantics out of `SaiPermissionsEngine` into
AA predicates (siblings of `matchesScope` / `findDelegableGrant` /
`dataInstanceIrisForGrant`), e.g.:

- a grant→request coverage predicate over the loaded grant dataset
  (`findGrant`'s matching: UAS vs `grantedBy`/`grantee`, scope dispatch,
  `SelectedFromRegistry` instance containment);
- the Inherited-chain resolution (`findParentResource`: parent grant, parent
  instance via the shape-tree reference predicate) — the evaluation-side
  inverse of the AA's `getChildInstanceIris`;
- the admin-mode rule (`AdminGrant` + `DataRegistry` scope ⇒ admin of a
  storage — the evaluation twin of §3.2).

`SaiPermissionsEngine` keeps the CSS `PolicyEngine` adapter: target-type
classification input, SPARQL data source (`SaiAuthorizationManager`), and
calling the predicates with the collected dataset.

### 3.2 Consolidate the admin-marker rule in an AA session method

Add an AA session method (or two, since the registration side differs by
context):

- `isAdminOf(orgWebId)` — resolve the org's registry set
  (`getRegistrySet`) + the org's registration of this session's webId over
  the plane → non-empty `hasAdminGrant`. Serves `resolveContext`,
  `requireOrgAdmin`, and `AgentIdHandler` (the reader side differs: personal
  contexts test the caller's *own* registration of the org and its
  reciprocal — i.e. the marker on the peer's registration of *us*);
- or a small predicate `adminMarker(registration)` documenting the
  personal/reciprocal vs direct asymmetry.

Components keep only the transport glue: which registration to load from
which context. This removes the four duplicated implementations and gives
`AgentIdHandler`/`adminGate`/`Context`/`buildSocialAgentProfile` one rule.

### 3.3 Delegation-endpoint completion → AA session method

Move the IRI assignment + `hasInheritingGrant`/`inheritsFromGrant` wiring
(2.3) into an AA session method, e.g. `finalizeIncomingGrants(grants)`:
assigns IRIs in `registrySet.hasGrantRegistry`, completes embedded child
grants, and validates each via `findDelegableGrant`. `GrantIssuanceHandler`
keeps the HTTP envelope (message dispatch, all-or-nothing dataOwner check is
arguably part of it — decide when implementing), Temporal scheduling, and
the response. Complements AA's `generateDelegatedDataGrants`.

### 3.4 AdminGrant materialization → AA session method

Move `buildAdminGrants`' payload construction into an AA session method,
e.g. `generateAdminGrants(admin)`: the `RegistrySet` marker + Read-only
`DataRegistry` grants, mirroring `generateGrantsForAuthorization`. The
temporal activities keep the store/ACR/link writes
(`storeAdminGrant`, `createAdminGrantAcr`, `replaceAdminGrantLink`,
`syncAdminAcr`).

### 3.5 Plane-based session `findRegistration`

Add a session `findRegistration` over the registry plane
(`listContained` + `getSocialAgentRegistration` +
`listApplicationRegistrations` + `getApplicationRegistration`, reusing the
AA's `typeGrantee` typing) and switch `getExistingGrants` /
`replaceDataGrantsOnRegistration` to it — closes the last HTTP
`AgentRegistry.findRegistration` consumer in components.

## 4. Design decisions

- **Engine stays a plugin; predicates move (3.1).** Follows the Phase-4
  keep-list wording — no new CSS dependency for the AA; the AA stays
  `api-messages`-free and fetch/SPARQL only.
- **The admin-marker rule is the single highest-value move (3.2):** four
  independent implementations of one org-admin rule is exactly the
  duplication Phases 1–4 eliminated elsewhere; the rule is small, pure, and
  fully testable in the AA suite.
- **UI-shaping reads stay in components (2.5).** `getDescriptions`,
  `formatAccessNeed`, `dataGrantIndexForAgent`, listings run over the
  context transport (`queries/org.ts`) and produce display shapes — plan §9's
  deferral stands; only the *predicates* they re-implement (scope counting)
  should be reused from the AA, not the reads moved.
- **The `AdminPermissionReader` divergence is out of scope** (see §6): it is
  a deliberate storage-owner ("pod owner") data-plane gate, a different
  notion from the registry-plane `hasAdminGrant` org-admin marker.

## 5. Testing

Behavior-preserving gate for any moved predicate/method: full build +
package vitest (AA + components) + the `/test` integration suite, matching
the `reorganize-authz-agent-logic` convention.

- **Engine predicates:** `peer-proxy.test.ts` / `grants.test.ts` engine
  paths already cover AllFromRegistry / SelectedFromRegistry / Inherited /
  admin modes; after extraction they exercise the AA predicates through the
  engine adapter.
- **Admin marker:** `org-context` / admin workflow integration
  (`/test`) covers `requireOrgAdmin`, `AgentIdHandler` registry-set link, and
  `Context.resolveContext`; AA-level unit tests for the session method
  (marker present/absent, reciprocal vs direct).
- **Delegation completion:** `grants.test.ts` plus the delegation-endpoint
  `/test` flows (yoyo delegation with inheriting children) — unchanged
  behavior through the AA session method.
- **AdminGrants:** org-admin `/test` flows (add/remove admin → grant
  materialization + ACR rewrite) — unchanged through the AA session method.

## 6. Observation — not a move

`packages/components/src/AdminPermissionReader.ts` grants full data-plane
permissions based on **pod ownership** (`podStore.getOwners`: storage owner
⇒ all permissions when the request comes from the owner's UAS) — a different
"admin" notion than the registry-plane `hasAdminGrant` marker used
everywhere else. Under the current single-deployment shared-store design this
is presumably intentional (`openwiki/architecture/federation.md` shortcut 3: "pod/storage ownership
is local"), but the divergence (data-plane owner vs registry-plane org-admin)
is worth confirming deliberately; it is **not** a candidate for the AA.

## 7. Out of scope / follow-ups

- Org-context transport and mirror/proxy infra (`queries/org.ts`,
  `ReciprocalMirror.ts`, `peerProxy.ts`/`peerFetch.ts`) — stays (see
  `openwiki/architecture/storage-isolation.md`).
- ACR/ACP automation (`createAcr`, `createAdminGrantAcr`, `syncAdminAcr`) —
  stays in components.
- Temporal workflow orchestration, storage accessors, OIDC session,
  `AccountService` bootstrap, `SaiAuthorizationManager` (engine data source)
  — stays.
- `checkEquivalence` (real equivalence comparison) — tracked by
  `check-equivalence.md`, unrelated to boundaries.
- Repo-wide biome baseline (~208 pre-existing diagnostics) — gate is
  build + tests; changed files should be biome-clean.