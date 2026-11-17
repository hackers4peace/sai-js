# ID-JAG access claims — ODRL model migration and impersonation-only delegation

> **Status:** 🔶 in progress — **C0–C2 landed**; **C3 removed**; **C4 item 4
> implemented**; **C5 implemented** (owner-AS claim coverage checks included;
> package gate and full Dagger `/test` green).
> **Last verified:** working tree (2026-11-17) — C0–C2 verified against the
> delegation, grant, policy-engine, ID-JAG, and Dagger code; C3 delegation mode
> removed; C4 item 4 verified against a delegated grant stored in the assigner's
> registry and the full Bob -> YoYo -> ACME impersonation chain; C5 endpoint
> removal, seed/link invariant, and ID-JAG test path verified by the package
> gate.
> **Green gate:** package gate + **full** Dagger suite after every slice
> ([§ Green gate](#green-gate)); Dagger is user-run.
> **Workstream:** LWS authorization ([`lws-auth.md`](lws-auth.md)) + grants /
> revocation. This plan owns the token-carried access-claim path and the ODRL
> shape migration that precedes it.
>
> **2026-11-17 decisions (pinned):** impersonation is the only ID-JAG/delegation
> token flow; delegated grants are only projections of a `DataAuthorization`
> created in the delegator's context and are stored in the delegator's own grant
> registry; the owner access-request endpoint remains only for need-based
> requests. The owner-delegation/revocation endpoint paths are removed rather
> than kept for compatibility. See [§ C5](#c5--owner-endpoint-narrowing--seedlink-invariant-implemented-2026-11-17).
>
> **2026-11-17:** ID-JAG delegation mode (`mode=delegation`, `act`) is removed.
> The `mode` parameter is not accepted. The C3 section remains only as a removal
> note.

## Context

Historically, delegated grants were created by the grantor but **materialized in
the data owner's grant registry** through the owner-scoped access-request
endpoint. `validateDelegable` checked the chain at request time; the policy
engine later trusted the stored grants and matched them by:

- UAS credentials: `odrl:assignee = agent`
- app credentials: `interop:requester = agent` and `odrl:assignee = client`

That owner-materialization model is being removed (C5). The target end state is
one model: every ordinary access grant is a **projection of a
`DataAuthorization` in the issuing agent's context** — source grants in the
owner/grantor context, delegated grants in the delegator/assigner context.
Impersonation is the only delegation token flow; there is no nested `act` /
delegation-token mode. The access claim still uses the **same ODRL profile as
grants and access requests**, so the policy engine evaluates one shape
everywhere. C0 migrated that shape; C1–C2 added the token flow.

## Goals / non-goals

**Goals**

- Migrate ODRL to `assigner` = delegator, `assignee` = delegatee,
  `target.owner = interop:dataOwner`; remove `requester`.
- Carry an ODRL `access` claim in the ID-JAG and final access token.
- Make impersonation the **only** token flow for delegation; hidden actors never
  appear in the final ID-JAG, access token, access claim, or ACME-side policy
  evaluation.
- Make every ordinary access grant a projection of a `DataAuthorization` in the
  issuing agent's context. Delegated grants live in the **assigner/delegator's**
  grant registry and are linked from the **grantor's registration of the
  grantee**; the linked grant is always in the same registry set as that
  registration. Source grants already follow this rule.
- Keep the owner access-request endpoint for **need-based access requests only**;
  remove its delegation and revocation branches (breaking change, no stale-client
  compatibility window).
- Keep `checkEquivalence` as the projection diff: it continues to reuse only the
  grants whose projected content did not change. The seed change does not require
  an algorithm change.
- One ID-JAG access claim is for **one storage**; no `resource` claim.
- Bounded 403 recovery: invalidate the token chain for that storage and restart
  it once.
- Correct the seed/link invariant: every `interop:hasDataGrant` link resolves to
  a grant in the same registry storage owned by the same agent.

**Non-goals (explicit follow-ups)**

- Admin impersonation and removal of `ProxyAdminHandler` — future TODO.
- Replacing `/sparql-admin` — separate transport/security question.
- Owner-mediated delegation approval/audit beyond need-based access requests —
  only if a later requirement appears.
- DPoP-bound final access tokens — evaluate after the claim path works.
- Batch validation / new revocation protocol — reuse the existing revocation
  primitives where possible.
- Removing the remaining global DPoP-bound access-token use from all clients and
  test helpers — tracked as a C5 follow-up; tests use the ID-JAG chain now.

## State map

| Capability / primitive | Status | Code anchors | Verified by | Notes |
|---|---|---|---|---|
| New ODRL shape: `assigner` = delegator, `target.owner` = data owner, no `requester` | ✅ landed — package + Dagger green | `packages/data-model/src/grant.ts` (`OdrlPermission`, `OdrlTarget`, `normalize*`, `deriveFields`, `grantAccess`, `toJsonLd`); `packages/data-model/src/context.ts`; `packages/utils/src/sai-context.ts` | data-model framing/pojo tests; grant-chain/generation; `/test` policy/delegation | C0; atomic commit |
| Full grant/seed/mirror/admin migration to the new shape | ✅ landed — C5 corrects the seed/link invariant | `environments/data/registry.trig`; grant registries/mirrors; `temporal/activities/admin.ts` | package + `/test`; migration audit query | C0 shape; C5 storage/link cleanup |
| ODRL ID-JAG context URI + local copy; expand only `access` | ✅ landed — package + full Dagger green | `packages/utils/src/odrl-id-jag-context.ts`; `jsonld-parser.ts`; `accessClaimTerms` shared with `accessContext` | utils context parser test; ID-JAG tests | C1 |
| ID-JAG `access` claim carried into the access token | ✅ landed — package + full Dagger green | `IdJagIssuer`, `IdJagSubjectTokenVerifier`, `access-claim.ts`, CSS `LwsTokenHttpHandler`/`LwsAccessTokenIssuer`/`LwsAccessTokenExtractor`, `PolicyEngineReader` | package ID-JAG/LWS tests; `/test` `lws-auth.test.ts` (12) | C1 |
| Claim-first policy-engine evaluation for token `access` claims | ✅ landed — package + full Dagger green | `SaiPermissionsEngine.getPermissions`/`findAccessClaimData`/`getClaimPermissions`; CSS `PolicyEngineReader` | new package `policy-engine-claim.test.ts`; `/test` `policy-engine.test.ts` (73) | C1 |
| One storage per ID-JAG access claim; no `resource` claim; final `aud` = storage | ✅ landed — package + full Dagger green | `IdJagTokenHandler`, `IdJagSubjectTokenVerifier`, `verifyAccessClaim`, `lws-auth` cache, CSS token handler | package tests; `/test` `lws-auth.test.ts` | C1 |
| User's UAS self-issues the initial ID-JAG; CID designation is the root authority | ✅ landed — self-issued claim path + assigner-owned grant storage | `IdJagIssuer`/`IdJagTokenHandler`; `packages/lws-auth`; CID docs (the UAS mints no credentials: the caller's own token is the credential, `lws-auth` D15) | package + `/test` | C1; UAS-as-client case |
| Impersonation chain: assigner rewrite, hidden actor, final token has no delegatee | ✅ landed — package + full Dagger green | `IdJagTokenHandler`, `IdJagSubjectTokenVerifier`, `access-claim.ts`, `lws-auth` impersonation chain, CSS token issuer/extractor | new `/test/impersonation.test.ts` (2); `/test/lws-auth.test.ts`; package token/LWS tests | C2 |
| Delegated grants are projections of a `DataAuthorization`, issued/stored in the assigner registry; no owner materialization | ✅ landed — owner delegation/revocation endpoint paths removed | `grant-generation.ts` (minted ids), `workflows/grants.ts` (local store + `registryOwner`), `activities/grants.ts` (`ownGrantIds`) | package workflow/equivalence tests; `/test` `check-equivalence.test.ts`, `roles.test.ts` | C2; C5 owns the endpoint path |
| Intermediate UAS validates incoming delegated claim against its own issued grants | ✅ landed — package + full Dagger green | `DelegatedAccessClaimValidator`, `IdJagTokenHandler` (`claimValidator`), `grant-policy.ts`, `grantCoversClaim` | package ID-JAG tests; `/test` `impersonation.test.ts` (3), `lws-auth.test.ts` (14) | C4 item 4 |
| Delegation token chain (`sub` top-level, nested `act` to client) | ❌ removed 2026-11-17 | — | — | C3 withdrawn; impersonation only |
| Grant/link invariant: every `hasDataGrant` target is in the registration's own registry set | ✅ landed — seed audit test | `environments/data/registry.trig`; `replaceAccessGrantsOnRegistration`; `AccessGrantHandler` | framing audit + `/test` | C5; delegated grants now share the assigner registry |
| Owner access-request endpoint is need-based only; delegation/revocation branches removed | ✅ landed — breaking change | `AccessRequestHandler`, `need-based-access-request.ts`; removed `delegation-request.ts`/`GrantRevocationHandler` | `/test` access-request + rejection tests | C5; breaking change, no compatibility window |
| Storage-facing tests use the ID-JAG exchange | ✅ landed — `buildLwsFetch` always chains | `/test` builders, `packages/lws-auth`, test utils | package gate + full Dagger | C5; global DPoP-bound access-token removal is a follow-up |
| Claim coverage (`claim ⊆ grant`) at every hop | ✅ landed — `grantCoversClaim`; equality remains only for equivalence | `grant-policy.ts`, `DelegatedAccessClaimValidator`, `access-claim.ts` | package claim/grant tests; `/test` policy-engine | C5 |
| Storage-AS claim validation reuses the policy-engine grant source | ✅ landed — `OwnerAccessClaimValidator` | `SaiAuthorizationManager.getAuthorizationData`, `IdJagSubjectTokenVerifier`, `SaiPermissionsEngine` | package validator tests; `/test` revocation scenario | C5; owner local registry only |
| SPARQL endpoint topology documented for federated deployment | ✅ documented | `SaiAuthorizationManager`, `SaiPermissionsEngine`, `PodEndpointStore` | deployment docs | per-pod endpoints, not SPARQL federation |
| 403/401 chain refresh per storage | ⬜ open | `packages/lws-auth` fetch/cache; RPC/UI callers | package fetch tests; `/test` revocation scenario | C3/C4 |
| Admin impersonation / `ProxyAdminHandler` removal / `/sparql-admin` future | ⬜ open | `ProxyAdminHandler`, `peerFetch`, `peerProxy`, `AdminSparqlHandler` | future TODO | not in this plan’s implementation |

## Protocol decisions

### ODRL shape

New canonical permission:

```json
{
  "assigner": "https://id/yoyo",
  "assignee": "https://app.example/id",
  "action": ["http://www.w3.org/ns/odrl/2/read"],
  "target": {
    "owner": "https://id/acme",
    "storage": "https://data/acme.example/",
    "source": ["https://data/acme.example/registration/..."],
    "partOf": ["https://data/acme.example/registration/..."],
    "type": [
      "http://www.w3.org/ns/odrl/2/AssetCollection",
      "http://www.w3.org/ns/solid/interop#DataRegistration"
    ]
  }
}
```

- `assigner` is always the **delegator**.
- `assignee` is always the **delegatee**.
- `target.owner` is always the **data owner**, mapped to
  `interop:dataOwner` and exposed as `owner` in JSON-LD.
- `requester` is removed from the new shape.
- Source grant: `assigner = target.owner = dataOwner`.
- Delegated grant: `assigner = delegator`, `target.owner = dataOwner`.

Old → new migration is deterministic:

```text
new.assigner      = coalesce(old.requester, old.assigner)
new.target.owner  = old.assigner
remove old.requester
```

Chain rules become:

- root: `assigner === target.owner`
- delegated: `upstream.assignee === downstream.assigner`
- same `target.owner`, storage, shape tree, registration, scope, actions,
  instances.

Policy-engine matching after C1:

- no token `access` claim: existing registry-grant matching, with
  `assigner` replacing `requester`
- token `access` claim: evaluate the claim directly (claim-first), then apply
  target/scope/action; optionally intersect with stored grants if available.

### ID-JAG context

- Use a top-level `@context` URI in the same namespace as the existing
  interop context, e.g.
  `https://www.w3.org/ns/solid/interop-context/v1/odrl-id-jag-context`.
- Keep a local bundled copy (new module under `packages/utils/src/`, registered
  in `jsonld-parser.ts`) so token verification never needs a remote context
  fetch.
- The context defines `owner` as
  `{ "@id": "http://www.w3.org/ns/solid/interop#dataOwner", "@type": "@id" }`
  plus the ODRL/LWS/SAI terms already used by grants.
- Verify **only the `access` subtree** as JSON-LD:
  `jsonld.expand({ '@context': payload['@context'], '@graph': payload.access })`.
  Do not expand the whole JWT payload; `sub`/`aud`/`iss`/`exp` are OAuth claims,
  not RDF terms.
- Put the same context on the access token (or a compact equivalent), because
  the access token carries the same ODRL claim.

### UAS as client / self-issued initial ID-JAG

When the end user's UAS is itself the OAuth client, there is no separate
application grant:

- `client_id` is the UAS IRI.
- The UAS may self-issue the initial ID-JAG for its user; no user→UAS grant is
  needed. The CID/WebID designation of the authorization agent is the root
  authority.
- The UAS still authenticates the caller (session/DPoP) and only mints claims
  backed by the user's grants or the UAS-as-client designation.
- The access claim's `assignee` is the UAS/client; the final policy engine can
  match `assigner = subject`, `assignee = client`.
- When an external application is the client, the end-user UAS adds the
  app-specific grant to the initial ID-JAG; each next UAS validates and
  re-issues it.

### Storage binding without `resource`

- No `resource` claim in the ID-JAG.
- An ID-JAG access claim is valid for exactly one storage; reject a claim
  containing targets with different `lws:storage` values.
- Final exchange still uses `resource = storage`; the RAS must require that the
  claim has a target for that storage.
- The final access token `aud` is the storage; the ODRL target/scope still
  narrows registration/instance/action.
- Client ID-JAG cache is effectively per `(AS issuer, storage)` even though the
  ID-JAG has no `resource` claim.

### 403 / invalid_grant recovery

- Storage `401` / `invalid_token` → refresh the access token; then the chain.
- Storage `403` → invalidate the access token and restart the chain once for
  that storage; cache “already retried” to avoid loops.
- UAS `400` / `invalid_grant` at an exchange → invalidate from that hop and
  re-mint; a denial at a UAS is the revocation signal.
- Do not invalidate on every 403 (a target/claim denial is not necessarily a
  revocation).

## C0 — ODRL model migration (atomic commit, no token behaviour)

**Done when:** every grant/request/admin/seed/mirror uses the new shape;
`requester` is absent from new output; `target.owner` is `interop:dataOwner`
mapped to `owner`; the current delegation/access-request flow and policy engine
are green with the new field semantics; old stored grants are migrated or
explicitly rejected.

**Depends on:** nothing.

**Green gate:** full package gate + full Dagger suite (below). This is the
commit the user reviews and commits before C1.

**`/test` acceptance:** `policy-engine.test.ts`, `delegation-endpoint.test.ts`
(removed in C5), `check-equivalence.test.ts`, `access-grants.test.ts`,
`share.test.ts`, `roles.test.ts`, `org-context.test.ts` (user-run).

**Touchpoints**

- `packages/data-model/src/grant.ts`: remove `requester` from
  `OdrlPermission`; add `owner` to `OdrlTarget`; normalize/derive; helpers;
  `grantAccess`; `toJsonLd`.
- `packages/data-model/src/context.ts` + `packages/utils/src/sai-context.ts`:
  target owner term; keep `requester` only if needed for the migration reader.
- `packages/authorization-agent/src/grant-generation.ts`: source/delegated/
  child grants set `assigner`/`target.owner` per the new rule.
- `packages/authorization-agent/src/grant-chain.ts`: root/coverage predicates
  use `assigner`/`target.owner`.
- `packages/authorization-agent/src/sparql.ts`: `getGrantsAuthority` reads
  `permission.assigner`, `target.owner`, `permission.assignee`.
- `packages/components/src/SaiPermissionsEngine.ts`: `requester` query becomes
  `assigner`; admin helper target owner.
- `packages/components/src/delegation-request.ts`,
  `need-based-access-request.ts`, `AccessGrantHandler.ts`: dataOwner/grantedBy
  derivations.
- `packages/components/src/temporal/activities/admin.ts`: `adminAccess` target
  owner.
- `environments/data/registry.trig`, all package fixtures, `test/` fixtures.

**Migration**

- Rewrite all grant stores: owner registries, reciprocal mirrors, issuer-side
  replicas, admin grants.
- Rewrite the seed.
- No dual-read after the cutover: old grant/request envelopes are migrated
  before the new shape is emitted.
- Add an audit query proving no new-shape grant lacks `target.owner` and no
  `requester` remains in new output.
- Token versioning/expiry is introduced with the access-claim path in C1; C0
  does not change the ID-JAG/access-token shape.

**Implementation (2026-11-15)**

- Data model/context: `target.owner` → `interop:dataOwner` mapped as `owner`;
  `requester` removed; `grantAssigner` replaces `grantRequester`.
- Grant generation, chain derivation, policy-engine matching, delegation/needs
  handlers, admin grants, and equivalence comparison use the new fields.
- Seed (`environments/data/registry.trig`) and package fixtures
  (`packages/test-utils/src/data.json`) migrated; no `interop:requester`
  remains.
- `getLinkedGrantOwners` / `getAccessGrantsForGrantee` read `target.owner`; the
  delegation request mints IDs from `target.owner` (not the delegator).
- Test harness: the NDJSON notification/event streams now send
  `Accept: application/x-ndjson`; without it CSS fell through to the LDP read
  and the stream tests hung.
- Gates green: `npm run typecheck`, full `npx vitest run` (657 passed, 26
  skipped, 2 todo), component build, and full Dagger `dagger call test`
  (24 files / 206 tests passed).

**Notes**

- Historical C0: token behaviour was unchanged. The old owner-request
  delegation flow continued to work with the new shape; C5 removes it.
- Historical C0: the old `requestDelegations`/`validateDelegable` path remained
  through C0; C5 removes it.

## C1 — ID-JAG access claim foundation (self-issued, single-hop)

**Done when:** a user's UAS can self-issue an ID-JAG carrying an ODRL `access`
claim; a storage verifies it, exchanges it for an access token carrying the
same claim, and the policy engine evaluates that claim claim-first. The claim is
storage-specific; no `resource` claim is used. No multi-hop impersonation yet.

**Depends on:** C0.

**Green gate:** full package gate + full Dagger suite.

**`/test` acceptance:** `lws-auth.test.ts`, `policy-engine.test.ts`; new
package tests for ID-JAG claim/context/token propagation (user-run).

**Touchpoints**

- New `odrl-id-jag-context` module + parser registration.
- `IdJagIssuer` accepts the ODRL access claim and top-level `@context`.
- `IdJagTokenHandler`/`IdJagSubjectTokenVerifier` carry/validate `access`, one
  storage, no `resource`.
- CSS `LwsTokenHttpHandler`/`LwsAccessTokenIssuer` copy the verified claim into
  the access token; `LwsAccessTokenExtractor` exposes `access`; `PolicyEngineReader`
  forwards it.
- `SaiPermissionsEngine`: claim-first branch; no-claim path unchanged.
- `packages/lws-auth`: self-issued initial ID-JAG path; cache per AS+storage.

**Notes**

- If the UAS is the client, the claim assignee is the UAS; no app grant.
- The existing ID-token → ID-JAG path remains as the current flow.
- Policy engine must reject/ignore claims it cannot parse, not silently fall
  back to broad registry matching for impersonation-shaped tokens.

**Implementation (2026-11-15)**

- `packages/utils/src/odrl-id-jag-context.ts` defines
  `https://www.w3.org/ns/solid/interop-context/v1/odrl-id-jag-context` and the
  shared `accessClaimTerms`; `accessContext` and the ID-JAG context now compose
  the same ODRL/LWS/SAI terms. The URI is registered in `jsonld-parser.ts`, so
  verification never fetches a remote context.
- `IdJagIssuer.issue` accepts `{ access, context }`; the payload carries the
  top-level `@context` and `access` only when a claim is present. The identity-
  only shape is unchanged for requests without a claim.
- `IdJagTokenHandler` accepts an optional form `access` parameter with the
  compact ODRL policies, validates it with `verifyAccessClaim` (one storage, no
  `resource`, bundled context), and requires the C1 self-issued identity:
  `assigner` = authenticated subject, `assignee` = client (or subject for a UAS
  acting as agent). The claim is bound to a request-supplied `resource` when
  present. A client-supplied claim is validated against the assigner's grant
  registry, exactly like an incoming ID-JAG claim.
- **UAS-derived claims (2026-11-15).** The app sends `resource` (the storage)
  and no `access`; the UAS finds the grants in the user's registry-pod dataset
  (reciprocal mirrors included) for that storage and client. An app-specific
  grant (user -> client) wins; otherwise the narrowest delegated grant edge is
  used (Selected > Inherited > AllFromRegistry > AllFromAgent). The optional
  form `access` remains for clients that hold the grant themselves, but it is
  now validated against the assigner's grant registry exactly like an incoming
  ID-JAG claim. `@elfpavlik/lws-auth` sends `resource` and keys the ID-JAG cache
  per storage.
- `IdJagSubjectTokenVerifier` expands **only** the `access` subtree after the
  signature check, validates the context/storage, and binds the claim to the
  exchange `resource`. CSS passes `resource` to every subject-token verifier
  (`SubjectTokenVerifierInput.resource`).
- CSS `LwsTokenHttpHandler` copies the verified claim into
  `LwsAccessTokenIssuer.issue`; `LwsAccessTokenExtractor` exposes `access` +
  `accessContext`; `PolicyEngineReader` forwards them.
- `SaiPermissionsEngine` evaluates a token claim claim-first: the policy graph
  is given a synthetic per-policy `lws:access` root, then the existing
  target/scope/action predicates run without registry/admin/public fallbacks.
  Invalid context/claim/storage denies instead of falling back to registry
  matching. `packages/lws-auth` sends an optional `accessClaim` and caches
  grants per `(AS issuer, storage)` when a claim source is configured.
- Gates: package `typecheck`, full `npx vitest run` (674 passed, 26 skipped,
  2 todo), components build, CSS targeted Jest (37), targeted Dagger
  `lws-auth.test.ts policy-engine.test.ts` (85 passed), and the **full Dagger
  suite** (24 files / 208 tests).
- The CSS changes live in the `elf-pavlik/CommunitySolidServer` `lws-sai`
  branch (sibling `../CommunitySolidServer`). `package-lock.json` tracks the
  claim-aware CSS commit, so a fresh `npm ci` gets the access-claim support.

## C2 — Impersonation default + assigner-owned grants

> **Superseded in part by C5 (2026-11-17):** delegated grants remain
> assigner-local, but the owner access-request delegation/revocation paths are
> removed. The owner endpoint is need-based only.

**Done when:** Bob can impersonate YoYo through Bob's UAS → YoYo's UAS → ACME's
AS; ACME sees only YoYo and the narrowed ODRL claim; Bob/`act`/hidden grant
references do not appear in the final ID-JAG or access token. Delegated grants
are issued and stored in the assigner's registry; the owner access-request
endpoint is **not** used for delegation (C5).

**Depends on:** C1.

**Green gate:** full package gate + full Dagger suite.

**`/test` acceptance:** new `impersonation.test.ts`, `lws-auth.test.ts`,
`policy-engine.test.ts`, `check-equivalence.test.ts` (user-run);
`delegation-endpoint.test.ts` is removed in C5.

**Touchpoints**

- `IdJagTokenHandler`/`IdJagSubjectTokenVerifier`: multi-hop subject -> next
  ID-JAG exchange; rewrite `assigner`, keep `target.owner`/target/action/scope;
  drop hidden actors.
- `grant-generation.ts` / `activities/grants.ts` / grant registry: delegated
  grants minted/stored in the assigner's registry; no owner-side copies.
- `lws-auth`: initial self-issued ID-JAG for the next UAS; final exchange.
- CSS token issuer/extractor: copy sanitized claim; no hidden actor fields.
- C5 moves the remaining owner-side delegated seed grants into assigner
  registries; the owner-side endpoint/workflow is removed.

**Notes**

- The first ID-JAG is the end user's app/UAS authorization (most narrow).
- At the impersonation hop, the outgoing claim has `assigner = requester` and
  no delegatee identity; permission/target/action/scope stay unchanged.
- ACME cannot validate the hidden delegatee's grant; it validates the final
  claim against its own grant to the visible subject. This is the accepted
  strict-hiding trade-off.
- Admin impersonation remains a TODO; `ProxyAdminHandler` stays.

**Implementation (2026-11-15)**

- **Impersonation token chain.** `IdJagTokenHandler` now accepts an ID-JAG as
  the subject token at a UAS (the `auth` config prepends
  `IdJagSubjectTokenVerifier` to the subject-token waterfall) and re-issues it
  under the visible actor: incoming claim `assigner` becomes `sub`, the UAS
  issuer becomes `client_id`, and the hidden subject/client are dropped.
  `rewriteAccessClaim` preserves permission/target/action/scope but replaces
  grant ids with fresh opaque ids, strips policy/permission/target `uid`/`id`
  references, `inheritsFromGrant`, and any `act` chain. The first hop
  (Bob's UAS -> YoYo's UAS) self-issues the delegated claim; the final ID-JAG
  and access token contain only YoYo and the narrowed ODRL claim.
- **Request audience.** `IdJagTokenHandler` accepts a configured
  `authorizationServerOrigins` list next to `storageOrigins`, so the first
  ID-JAG can target the next UAS rather than a storage.
- **`packages/lws-auth`.** `requestIdJag` accepts `subjectTokenType` (ID token
  or ID-JAG) and `createLwsAuthFetch` has an `impersonation` option: it first
  self-issues an ID-JAG for the intermediate UAS, then uses that UAS's re-issued
  ID-JAG for the storage. The claim cache is keyed by
  `(AS issuer, storage, impersonation UAS)`.
- **Assigner-owned delegated grants.** Delegated generation mints parent and
  child ids in the grantor's registry. The reconciliation workflow stores
  delegated trees locally (`storeAccessGrant`/`createAcr` with
  `registryOwner = grantedBy`) instead of POSTing to the data owner. The owner
  access-request delegation path was still present at C2 but is removed by C5;
  no owner-side copies are kept. Removal uses the own-registry closure; C5
  migrates the remaining legacy owner-side seed grants.
- **Equivalence.** `checkEquivalence` takes `ownGrantIds`; a delegated tree is
  reusable only when it is in the actor's own registry. The algorithm remains the
  projection diff after C5 — only the seed/fixtures move to the correct local
  layout. The owner-side → assigner-side migration is no longer a seed fixture;
  use a synthetic legacy fixture if that migration path still needs coverage.
- **Trust boundary.** The intermediate UAS validates the incoming ID-JAG
  signature, audience, claim shape, and that the hidden delegatee is the token
  subject/client before re-issuing. It does not yet re-check the hidden claim
  against its own grant registry; that hardening is tracked under C4, alongside
  the owner-visible audit story.
- **Tests/gates.** Package `typecheck`, full `npx vitest run` (679 passed, 26
  skipped, 2 todo), components build, `npm run check`, and the **full Dagger
  suite** (25 files / 211 tests) are green. `/test` includes the new
  `impersonation.test.ts`, the C2 `lws-auth` chain, `check-equivalence`, and
  `roles`; `delegation-endpoint` is removed in C5.

## C3 — Delegation via token exchange (removed 2026-11-17)

**Withdrawn.** Impersonation is the only delegation token flow. There is no
`mode=delegation`, no `act` actor chain, and no nested delegation token. The
former C3 implementation is retained in git history only; do not reintroduce it
from this plan.

**Acceptance:** the UAS rejects delegation-mode requests / delegation-shaped
tokens, and the impersonation chain remains green. `/test/delegation-token.test.ts`
is not part of the suite.

## C4 — Coexistence decisions / follow-ups

C4 item 4 landed; the remaining coexistence questions are resolved by C5.

**C4 item 4 — implemented (2026-11-15).** The intermediate UAS now performs an
independent check before re-issuing an ID-JAG: the incoming claim's `assigner`
must be a local user, each claim policy must map to a grant issued by that user
and stored in their own grant registry (semantic fields + ODRL permissions,
ids ignored), and the grantee must be the incoming subject/client bound to the
requested storage. The auth config wires `DelegatedAccessClaimValidator` into
`IdJagTokenHandler`; a mismatch returns `invalid_grant`. The seed provides the
YoYo -> Bob delegated grant in YoYo's registry; the tests prove the positive
impersonation chain and the negative no-backing-grant rejection. The seed still
contains legacy owner-stored delegated grants (for example the ACME registry
grants `qwvbcu`/`wwp4j6` assigned by Alice); C5 moves/removes them, after which
they must not be used.

**C4 decisions resolved (2026-11-17).**

- Request/approval mode selection: none. Impersonation is the only delegation
  flow.
- Owner materialization/mirroring: not required for delegated grants or their
  revocation; local projections + reconciliation/mirror propagation are the
  model.
- Owner access-request endpoint: need-based requests only; delegation/revocation
  branches are removed. No owner copy/approval path for delegation.
- Admin impersonation + `ProxyAdminHandler` removal; `/sparql-admin` future.
- DPoP-bound final access token: open.
- Audit/visibility mapping for hidden actors: open.

## C5 — Owner endpoint narrowing + seed/link invariant (implemented 2026-11-17)

**Decision (2026-11-17, pinned).** The owner endpoint is no longer a delegation
or revocation boundary. `/.sai/access-requests/<owner>` keeps only
`NeedBasedAccessRequest`. Delegated grants and their revocation are projections
in the issuing/delegator context.

**Done when**

- `AccessRequestHandler` accepts only `NeedBasedAccessRequest`: it does not
  implement `DelegationRequest` or `AccessRevocationRequest`.
- `issueDelegationRequest`, `requestDelegations`, `requestRevocations`,
  `GrantRevocationHandler`, and their message/vocab/context entries and tests are
  removed. This is a breaking change; no stale-client compatibility is needed.
- `environments/data/registry.trig` contains no owner-side delegated grant. Every
  `interop:hasDataGrant` link is on a registration whose registry owner is the
  grantor/assigner and points to a grant in that same registry set.
- `checkEquivalence` is unchanged as an algorithm: it still pairs generated trees
  with existing local bodies and reuses unchanged source/delegated IDs. Only its
  fixtures change; the owner-side migration case is no longer a seed fixture (use
  a synthetic legacy fixture if that migration path still needs coverage).
- Delegated grants and their revocation are generated/removed only by
  `reconcileGrantsForGrantee` / `processAuthorizationRevoked`.
- The final exchange must be denied when the owner revoked the original grant
  that was delegated and re-delegated downstream. Mirror/
  `delegatedGrantsUpdated` + reconciliation is the accepted propagation path.
  **Open:** the storage AS verifier currently checks token/claim shape only; the
  policy engine denies access claim-first, but exchange-time subset validation
  against the owner's grants is not implemented yet.
- `/.sai/grants/<owner>` reads by registry/assigner ownership, so delegated
  grants in the delegator's registry are visible.
- Storage-facing `/test` access uses the ID-JAG chain (`createLwsAuthFetch`);
  `buildLwsFetch`'s direct credential-to-storage mode is not used by tests.
  `buildOidcSession` / `buildSessionManager` remain for setup, RPC, and owner-side
  reads.

**Seed/link invariant**

- Source grant: grantor = data owner; the grant body and the `hasDataGrant`
  registration share the owner's registry set.
- Delegated grant: grantor = delegator/assigner; the grant body and the
  `hasDataGrant` registration share the delegator's registry set; `target.owner`
  remains the data owner.
- Concretely, the seed now stores `https://registry/alice/wwp4j6` and
  `https://registry/alice/qwvbcu` (Alice -> test-client, data owner ACME) in
  Alice's registry, linked from Alice's registration of the client;
  `https://registry/yoyo/q7w2nz` was already correct.
- Grant ACRs and `meta:partOf` use the new registry owner; the owner-side bodies
  and replica path are gone. A framing test audits the invariant.

**Revocation decision**

- Revocation is local: deleting the delegator's `DataAuthorization` removes its
  delegated grant closure.
- When the data owner revokes the source grant, the chain is invalid. The owner
  side must refuse the final ID-JAG exchange once the original grant that was
  delegated (and re-delegated) is revoked. Reconciliation/mirror refresh is
  sufficient; no owner-side delegated grant copy is required.
- `IdJagSubjectTokenVerifier` wires `OwnerAccessClaimValidator` at the storage
  AS. It reads the same owner-registry grants as the policy engine and rejects
  an exchange when no owner grant covers every claim policy. Existing access
  tokens still live until expiry; the policy engine remains the resource-time
  denial point.
- No `AccessRevocationRequest` endpoint path remains.

**Claim coverage at every hop (implemented 2026-11-17)**

A grant may be narrowed at each delegation step, so claim validation is
**coverage**, not equality:

- the first ID-JAG may be narrower than the grant held by the next UAS that
  exchanges it;
- an intermediate UAS must accept any claim that is a subset of its locally
  issued grant;
- the data-owner AS must accept any final claim that is a subset of its own
  source grant.

`grantCoversClaim(grant, claim)` covers scope, target/source/partOf, action
subset, assignee, and the parent/child `Inherited` relation. Both the UAS
validator and the owner validator use it; `checkEquivalence` keeps using exact
equality.

**Grant source for the owner AS (implemented 2026-11-17)**

The storage AS reuses the policy engine's grant access path:
`SaiAuthorizationManager.getAuthorizationData(resource)` (same owner-registry
query used by `SaiPermissionsEngine`), then applies `grantCoversClaim` in
`OwnerAccessClaimValidator` before issuing an access token. This binds
exchange-time revocation to the same source grants the policy engine already
uses.

**SPARQL topology**

Current policy-engine grant reads are targeted, not federated:

- resolve the target storage through `StorageLocationStrategy`;
- resolve its owner through `PodStore`;
- resolve `registryId(owner)` through `PodEndpointStore.findSparqlByPodUrl`;
- run the grant `SELECT`/`CONSTRUCT` against that **single owner-registry pod
  endpoint**;
- evaluate in memory with Comunica.

The data pod endpoint is used separately for target type/parent metadata. This
works with per-pod endpoints when the owner/registry records are present, and it
is sufficient for the owner AS validating its own source grant. It does **not**
federate across registry pods: delegated grants now live in delegator
registries, so the owner policy engine cannot see them through this query (and
does not need to under claim-first impersonation). UAS-side validation relies on
the subject's own registry plus reciprocal mirrors.

**Tests**

- Keep and update `access-request.test.ts`, `authorization.test.ts`,
  `check-equivalence.test.ts`, `roles.test.ts`, `impersonation.test.ts`,
  `lws-auth.test.ts`, `policy-engine.test.ts`, `access-grants.test.ts`, and
  `reconciliation.test.ts` for the new seed/link/token assumptions.
- Replace `delegation-endpoint.test.ts` with rejection coverage for the removed
  message types (or remove it if the remaining endpoint assertions live
  elsewhere).
- Add: link-invariant audit, owner-source-revocation -> final-exchange denial,
  local delegated-grant revoke, and `/grants/<delegator>` visibility.

**Follow-ups**

- Remove the remaining use of global DPoP-bound access tokens over time; use the
  ID-JAG chain for storage-facing access. Track separately from this slice.
- `packages/lws-auth` stays a product client library. Move test-only helpers
  (self-issued CSS credential, CSS `/.account/` interaction driver, fixture login)
  into test utils; keep generic token-chain/OIDC/credential logic in
  `packages/lws-auth`.

**Implementation (2026-11-17)**

- Removed the owner-endpoint delegation/revocation paths:
  `delegation-request.ts`, `GrantRevocationHandler`, `messages.ts`, the
  data-model `AccessRevocation` exports, the `DelegationRequest`/
  `AccessRevocationRequest` vocab/context terms, `requestDelegations`,
  `requestRevocations`, the grant-replica service, and their tests.
  `AccessRequestHandler` now dispatches `NeedBasedAccessRequest` only.
- Reconciliation removes every non-reused grant through the own-registry
  closure; there is no peer-owned/replica branch left.
- Seed: `wwp4j6`/`qwvbcu` moved from ACME's to Alice's grant registry, including
  their meta `partOf` and ACR owner; ACME's registration of Alice now links the
  inherited `wpqyds` too, so reciprocal mirrors carry the full tree into UAS
  claim derivation. A framing test audits every registration → grant link for
  the same registry owner and assigner.
- `buildLwsFetch` always uses `createLwsAuthFetch` (ID-JAG chain); the
  test-only OIDC login helper moved to `packages/test-utils`, so
  `packages/lws-auth` stays product-only.
- `/.sai/grants/<owner>` filters by assigner/registry ownership, so delegated
  grants in the delegator's registry are visible.
- Inherited claim regression fixed: claim derivation now preserves the
  parent/child policy link, impersonation rewrite remaps it to fresh policy ids,
  and `SaiPermissionsEngine.findAccessClaimData` maps it to synthetic parent
  roots. Package tests cover both the rewrite and the claim-graph mapping.
- Claim validation uses coverage (`grantCoversClaim`) at both the UAS and the
  storage AS. `OwnerAccessClaimValidator` reuses
  `SaiAuthorizationManager.getAuthorizationData(storage)`; `id-jag-accept.json`
  wires it into `IdJagSubjectTokenVerifier`.
- Package gate: `npm run typecheck`, full `npx vitest run` (666 passed, 26
  skipped, 2 todo), `npm run build -w @elfpavlik/sai-components`, and
  `npm run check`.
- Full Dagger `/test`: 24 files / 196 tests passed. CSS dependency is pinned to
  `195c682eddd5afcd2d224f34b7818ac42782e596` on the `lws-sai` branch.

## Green gate

Run from the repo root. The Dagger module is `.dagger/src/index.ts`
(`dagger call test`); its runner env comes from [`devbox.json`](../../devbox.json):

```bash
export _EXPERIMENTAL_DAGGER_RUNNER_HOST="docker-container://dagger-engine-v0.21.9"

npm run typecheck
npm run check
npx vitest run

# runtime/config changes: rebuild components before Dagger
npm run build -w @elfpavlik/sai-components

# full integration suite (user-run; devbox shell already carries the env)
devbox run -- bash -lc 'dagger call test'
```

Narrow a Dagger run when iterating, but **each completed slice ends with the full
suite**:

```bash
devbox run -- bash -lc 'dagger call test --testFile="lws-auth.test.ts policy-engine.test.ts"'
```

`/test` is user-run per `CONVENTIONS.md` §7; package tests are the agent gate.

## Decision log

**D1 — ODRL shape: `assigner` = delegator, `assignee` = delegatee,
`target.owner` = data owner; no `requester`.** *pinned.* This makes every
policy one delegation edge and makes `upstream.assignee === downstream.assigner`
the chain rule.

**D2 — `target.owner` maps to `interop:dataOwner`, exposed as `owner` in JSON-LD.**
*pinned.* Avoid a new owner vocabulary; the old→new migration is exact.

**D3 — Full migration to the new shape; no long-term dual-read.** *pinned.*
Old grants/seed/mirrors/replicas are migrated; token versioning/expiry lands
with the access-claim path in C1.

**D4 — Top-level ID-JAG `@context` uses
`https://www.w3.org/ns/solid/interop-context/v1/odrl-id-jag-context`, with a
local bundled copy.** *pinned.* Only the `access` subtree is expanded; the JWT
payload is not treated as one JSON-LD document.

**D5 — An ID-JAG access claim is valid for one storage only; no `resource`
claim.** *pinned.* The ODRL `lws:storage` targets bind the claim; final exchange
requires the requested storage and the final access token `aud` is the storage.

**D6 — The user's UAS may self-issue the initial ID-JAG.** *pinned.* The CID
designation is the root authority; no user→UAS grant is required. The UAS must
still authenticate the caller.

**D7 — UAS-as-client is a first-class case.** *pinned.* When the UAS is the
OAuth client, `client_id` is the UAS IRI and the access claim's `assignee` may
be that UAS; no separate application grant is involved.

**D8 — Impersonation is the only delegation token flow.** *pinned 2026-11-17.*
No `mode=delegation`, no nested `act`; hidden actors never appear in the
owner-facing token or claim.

**D9 — Delegated grants are projections of a `DataAuthorization` in the
delegator's context, stored in the delegator's own grant registry and linked from
the grantor's registration of the grantee.** *pinned 2026-11-17.* The owner
access-request endpoint handles need-based requests only; the delegation and
revocation endpoint paths are removed.

**D10 — Claim-first policy engine for tokens with `access`; registry matching
only when no claim is present.** *pinned.* This supports app and agent cases
uniformly and avoids hidden-assignee special cases.

**D11 — 403 recovery invalidates the access token/chain for that storage and
retries once.** *pinned.* Bounded, per-storage, no loops; `invalid_grant` at a
UAS is the revocation signal.

**D12 — Admin impersonation, `ProxyAdminHandler` removal, and `/sparql-admin`
replacement are future TODOs.** *pinned (deferred).* The proxy stays until
explicit admin impersonation authority and client/network support exist.

**D13 — There is no request/approval mode selection.** *resolved 2026-11-17.*
Impersonation is the only delegation flow; need-based requests ask for source
access, not delegated grants.

**D14 — Old ID-JAG/access tokens must not be silently interpreted under the new
semantics.** *pinned.* Use short TTL plus a version/required-claim gate; old
policy engines must not ignore `access` for impersonation-shaped tokens.

**D15 — Grant/link invariant: every `hasDataGrant` link targets a grant in the
same registry set as the linking registration.** *pinned 2026-11-17.* Source
grants: owner/grantor. Delegated grants: assigner/delegator. The owner does not
store delegated grant copies.

**D16 — Delegation revocation is local projection closure; upstream revocation
invalidates the chain.** *pinned 2026-11-17.* The data owner's AS refuses the
final ID-JAG exchange when the original delegated/re-delegated grant is revoked;
mirror/`delegatedGrantsUpdated` + reconciliation propagation is accepted. No
`AccessRevocationRequest` endpoint path remains.

**D17 — Storage-facing tests use the ID-JAG exchange; `packages/lws-auth` remains
a product client library.** *pinned 2026-11-17.* Test-only helpers move to test
utils. Removing global DPoP-bound access-token use is a follow-up.

**D18 — `checkEquivalence` remains the projection diff.** *pinned 2026-11-17.*
The seed/link change updates fixtures, not the algorithm; unchanged source and
delegated trees continue to be reused.

**D19 — Claim validation is coverage, not equality.** *pinned 2026-11-17.*
A claim may be narrower than the grant it is checked against at every hop.
`checkEquivalence` keeps exact equality; validation uses a separate
`grantCoversClaim` predicate.

**D20 — The storage AS reuses the policy-engine grant source.** *pinned
2026-11-17.* Validate the final claim against
`SaiAuthorizationManager.getAuthorizationData(resource)` rather than adding a
second owner-registry query.

**D21 — The policy engine reads one owner-registry endpoint; it is not a SPARQL
federation layer.** *pinned 2026-11-17.* Per-pod endpoint resolution is
sufficient for owner-local source grants; delegated grants in other registries
are not queried by the owner policy engine.

## Hazards / verification

- **Seed/link invariant:** owner registries, reciprocal mirrors, issuer-side
  replicas, admin grants, seed, and test fixtures must move together. Add an
  audit query proving every `hasDataGrant` target shares the registration's
  registry owner.
- **Breaking endpoint removal:** every caller (UI/RPC/repl/tests) must stop using
  `DelegationRequest`/`AccessRevocationRequest`; no stale-client compatibility
  window is provided.
- **Upstream revocation:** the final exchange must deny after the owner revokes
  the original delegated/re-delegated grant. Mirror/reconciliation propagation is
  eventually consistent; do not reintroduce an owner-side delegated grant copy
  just to make revocation immediate.
- **Narrowing at every hop:** an equality check rejects a valid claim that is
  narrower than the exchanging UAS's grant. Use coverage semantics, including
  scope/target/action subsets and the parent/child relation.
- **Federation assumption:** `SaiAuthorizationManager` reads the owner's
  registry endpoint resolved from local pod records. A deployment without those
  records denies; a cross-registry query needs a separate federation/mirroring
  design.
- **Test-harness extraction:** `packages/lws-auth` must stay product-only; do not
  make it depend on `components` or test utilities (avoid a dependency cycle).
- **Context scope:** expanding the whole JWT as JSON-LD will pull OAuth claims
  into RDF; only expand `access`.
- **Hidden actor leakage:** final impersonation tokens/claims must not contain
  delegatee `assignee`, `act`, requester, or resolvable grant references.
- **Claim-first rollout:** old policy engines must not ignore `access`; new
  impersonation tokens require the claim-aware engine.
- **Token size:** ODRL claims with selected instances can be large; enforce
  policy/target limits and non-identifying final claims.
- **Final `client_id`:** do not use a personal UAS client ID when impersonation
  must hide the delegatee; use the shared app/UAS or a pseudonymous client.
- **403 loops:** cache retry state per storage/target; do not restart on every
  deny.
- **Admin future:** `ProxyAdminHandler` also serves org-own data content and is
  a network/JSON-LD boundary; impersonation only replaces its credential reason.

## Open questions

- Exact context URI path/filename and whether the access token reuses the same
  context or a compact subset.
- Whether the final access token should be DPoP-bound for impersonation.
- Whether final access claims keep the full ODRL policy or a filtered
  single-storage subset (recommended: filter to the requested storage at the
  final exchange).
- Audit/visibility mapping for hidden actors.
- Cutover mechanics for old grants/tokens and the migration audit gate.
- Exact split of reusable LWS helpers between `packages/lws-auth` and test utils.
