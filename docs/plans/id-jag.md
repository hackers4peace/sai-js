# ID-JAG access claims — ODRL model migration and impersonation-only delegation

> **Status:** ✅ implemented — **C0–C6 landed**; **C3 removed**; **C4 item 4
> implemented**; **C5 implemented**; **C6 implemented** (token-carried storage
> authorization; owner/admin `scope`; public reader; ID-JAG-only storages; no
> runtime grant matching).
> **Last verified:** working tree (2026-11-18) — C6 verified against
> `LwsTokenHttpHandler`/`LwsAccessTokenIssuer`, `LwsAccessTokenExtractor`,
> `SaiPermissionsEngine`, `PublicPermissionReader`,
> `StorageExchangeAccessPolicy`, the auth/data/registry configs, and the full
> Dagger `/test` suite (24 files / 199 tests). Package gate: `typecheck`,
> `check`, full `vitest` (680 passed, 26 skipped, 2 todo), components build.
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
>
> **2026-11-17 C6 decisions (pinned, design):** a data storage authorizes only
> from the access token its own AS issued — an ODRL `access` claim, a `scope`
> minted for the storage owner / org admin (each with their own UAS as client;
> `owner`/`admin`), or a public grant.
> `AdminPermissionReader` is removed; storages accept only ID-JAG subject
> tokens; the first ID-JAG exchange uses only a DPoP-bound access token (no
> CID/did:key suites) whose only `aud` is the user's UAS. The ID-JAG and access
> token share one claim context URI; the final access token is a bearer token
> with the storage as its only `aud`; DPoP is used only at the first hop, not at
> the storage exchange. The registry storage is
> ID-JAG only and claimless because ACP authorizes it; revocation is eventual,
> bounded by token TTLs; there is no old-token/grant compatibility. See
> [§ C6](#c6--token-carried-storage-authorization-planned-2026-11-17).

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
- Bounded token recovery: refresh the access token on `401`; C6 revisits the
  `403` semantics (a target/claim denial is not a revocation signal).
- Correct the seed/link invariant: every `interop:hasDataGrant` link resolves to
  a grant in the same registry storage owned by the same agent.
- Make the storage-issued access token the **only** storage authorization
  input: an ODRL `access` claim, a storage-AS `scope` (`owner`/`admin`), or a
  public grant. No runtime registry grant matching on data storages.
- Accept only ID-JAG subject tokens at storage authorization servers; the auth
  service is the only place a DPoP-bound access token is exchanged.

**Non-goals (explicit follow-ups)**

- Admin impersonation and removal of `ProxyAdminHandler` — future TODO.
- Replacing `/sparql-admin` — separate transport/security question.
- Owner-mediated delegation approval/audit beyond need-based access requests —
  only if a later requirement appears.
- DPoP-bound final access tokens — deferred; the final token is a bearer token
  with the storage as its only `aud` (D32).
- Batch validation / new revocation protocol — reuse the existing revocation
  primitives where possible.
- Removing the remaining global DPoP-bound access-token use from all clients and
  test helpers — **C6 owns this** (D25); storages will accept only ID-JAG.
- Immediate revocation for claim/scope tokens — C6 accepts re-validation at
  exchange only, bounded by the token TTLs.
- RPC/`.sai` authorization changes — the RPC API keeps the cookie session and
  the UAS acting as its own client; it is a client implementation detail, not a
  storage credential class.

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
| Storage-facing tests use the ID-JAG exchange | ✅ landed — `buildLwsFetch` always chains | `/test` builders, `packages/lws-auth`, test utils | package gate + full Dagger | C5; C6 owns the remaining DPoP-bound removal (D25) |
| Claim coverage (`claim ⊆ grant`) at every hop | ✅ landed — `grantCoversClaim`; equality remains only for equivalence | `grant-policy.ts`, `DelegatedAccessClaimValidator`, `access-claim.ts` | package claim/grant tests; `/test` policy-engine | C5 |
| Storage-AS claim validation reuses the policy-engine grant source | ✅ landed — `OwnerAccessClaimValidator` | `SaiAuthorizationManager.getAuthorizationData`, `IdJagSubjectTokenVerifier`, `SaiPermissionsEngine` | package validator tests; `/test` revocation scenario | C5; owner local registry only |
| SPARQL endpoint topology documented for federated deployment | ✅ documented | `SaiAuthorizationManager`, `SaiPermissionsEngine`, `PodEndpointStore` | deployment docs | per-pod endpoints, not SPARQL federation |
| 403/401 chain refresh per storage | ✅ landed — C6 | `packages/lws-auth` fetch/cache (`noToken`, retry-once) | package fetch tests; `/test` revocation scenario | `401` refreshes; storage `invalid_grant` = no token, retry tokenless once; `403` is a target/claim denial (D11) |
| Admin impersonation / `ProxyAdminHandler` removal / `/sparql-admin` future | ⬜ open | `ProxyAdminHandler`, `peerFetch`, `peerProxy`, `AdminSparqlHandler` | future TODO | not in this plan’s implementation |
| Storage authorization is token-carried only (claim or `scope: owner`/`admin`) | ✅ landed — C6 | CSS `LwsAccessTokenIssuer`/`LwsTokenHttpHandler`/`LwsAccessTokenExtractor`, `PolicyEngineReader`, `SaiPermissionsEngine`, `PublicPermissionReader` | package token/permission tests; `/test` policy-engine matrix | no runtime grant matching on data storages |
| Exchange mints `scope` for the storage owner and `DataRegistry` admins, both with their own UAS as client | ✅ landed — C6 | `StorageExchangeAccessPolicy`, `PodStore`, `SaiAuthorizationManager` | package policy/exchange tests; `/test` owner/admin matrix | owner = full modes; admin = read-only; owner/admin + non-UAS → `invalid_grant` |
| Public access is credential-independent (no token or any valid token) | ✅ landed — C6 | `PublicPermissionReader`, `SaiAuthorizationManager.getAuthorizationData` | package public tests; `/test` public matrix | separate read-only reader, never a claim fallback |
| `AdminPermissionReader` removed; claimless non-owner/non-admin exchange rejected | ✅ landed — C6 | removed `AdminPermissionReader`, `readers/admin.json`; `readers/default.json` = token ∪ public; `StorageExchangeAccessPolicy` | package + `/test` | owner+UAS check moves to exchange |
| Storages accept only ID-JAG; auth service accepts only the user's DPoP-bound access token and incoming ID-JAGs | ✅ landed — C6 | `id-jag-accept*.json`, `id-jag.json`, `IdJagTokenHandler`, `packages/lws-auth`, `SessionManager` | package token tests; `/test` chain + session suites | CID/did:key/OIDC storage suites removed; CID/WebID discovery stays |
| First ID-JAG exchange is a DPoP-bound access token (`cnf.jkt` + `…:access_token`), not an unbound token | ✅ landed — C6 | `IdJagTokenHandler`, `OidcSubjectTokenVerifier.requireSenderConstrained`, `packages/lws-auth` `subjectTokenType`, `buildSelfIssuedCredential` | package token tests; `/test` chain | `…:id_token` rejected; `cnf` required; audience = UAS only |
| ID-JAG and access token share one claim context URI (local copy) | ✅ landed — C1; pinned C6 | `packages/utils/src/odrl-id-jag-context.ts`, `access-claim.ts`, CSS `LwsAccessTokenIssuer` | package context/claim tests | D4; no compact variant |
| Final access token is bearer, `aud` = storage only | ✅ landed — C6 | CSS `LwsAccessTokenIssuer`/`LwsAccessTokenExtractor` | package token tests; `/test` chain | D32; storage exchange is a bearer grant exchange |
| First-hop access token `aud` = user's UAS only; `solid` audience removed | ✅ landed — C6 | `id-jag.json` (`IdTokenVerifier`), `SelfIssuedSession`, `packages/lws-auth` | package token tests; `/test` chain | D33; `.sai` session login keeps `solid` separately |
| No Solid-OIDC issuer fallback; `acceptSolidOidcIssuer: false` | ✅ landed — C6 | `id-jag.json`, `id-jag-accept.json`; seed/template add `lws:OpenIdProvider` | package token tests; `/test` chain | D34; `trustedIssuers`/`lws:OpenIdProvider` only |
| No old grant/token compatibility; atomic cutover | ✅ landed — C6 | deployments, token TTLs | — | D3/D14; no version gate |
| Storage description advertises `sai:DataStorage` / `sai:RegistryStorage` | ✅ landed — C6 | `SaiStorageTypeDescriber`, `data.json`, `registry.json`, SAI context aliases | package describer/discovery tests; `/test` `services.test.ts` | open-world replacement for the local claimless origin list |
| Registry exchange is ID-JAG only and claimless (ACP authorizes) | ✅ landed — C6 | `id-jag-accept-registry.json` (`copyAccessClaim: false`), `SaiStorageTypeDescriber` (`RegistryStorage`), `IdJagTokenHandler.isRegistryStorage` | package claimless/description tests; `/test` registry read | no access claim required or copied; discovery replaces the local origin allowlist |

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
- Put the same context URI on the access token; parsing always uses the local
  bundled copy (D4). There is no compact/equivalent variant.

### UAS as client / self-issued initial ID-JAG

When the end user's UAS is itself the OAuth client, there is no separate
application grant:

- `client_id` is the UAS IRI.
- The UAS may self-issue the initial ID-JAG for its user; no user→UAS grant is
  needed. The CID/WebID designation of the authorization agent is the root
  authority (document discovery, not a credential).
- The UAS is the issuer, never a client of another UAS for the token flow: it
  mints the ID-JAG itself. The DPoP-bound access token appears only at the
  user's own UAS (first hop); a UAS never presents it to a storage or another
  UAS.
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
- Storage `403` → do not restart the chain; it is a target/claim denial, not a
  revocation signal. A later exchange returns `invalid_grant` if the grant is
  gone; the client then falls back tokenless for public data.
- UAS `400` / `invalid_grant` at an exchange → invalidate from that hop and
  re-mint; a denial at a UAS is the revocation signal.
- Do not invalidate on every 403 (a target/claim denial is not necessarily a
  revocation).

### Token-carried storage authorization (C6)

A data-storage access token is self-contained for storage authorization:

- `access` claim → the claim engine (target/scope/action only, no identity
  matching, no registry or public fallback).
- `scope: owner` → all modes; minted only when `sub` is the storage owner and
  `client_id` is `sub`'s authorization agent.
- `scope: admin` → read-only; minted only when `sub` holds a
  `DataRegistry`-scoped `AdminGrant` for the storage **and** `client_id` is
  `sub`'s authorization agent (same UAS binding as the owner).
- no claim and no owner/admin scope → the exchange returns `invalid_grant`;
  nothing is issued.
- Public grants are independent of the token: no token or any valid token gets
  a public read; the public reader is not a claim fallback.

Storages accept only ID-JAG subject tokens. The auth service's ID-JAG endpoint
accepts only the user's DPoP-bound access token (the IdP/UAS access token or
the SAI self-issued `at+jwt`) and incoming ID-JAGs, and exchanges them for an
ID-JAG. CID/did:key token suites are not used anywhere in the SAI configs (the
storage default waterfall is removed; the auth service never had them).
CID/WebID document discovery is not a credential and remains. The registry
storage is ID-JAG only and requires no access claim; it does not copy one into
the token because ACP authorizes registry resources. The claim requirement is
per-server config.

The ID-JAG and the access token use the same `@context` URI (local bundled
copy). The final access token is a bearer token with the storage as its only
`aud` (D32); the first-hop DPoP-bound access token has only the user's UAS as
`aud` (D33). ID-JAG issuer verification uses `trustedIssuers` or an
`lws:OpenIdProvider` service; `acceptSolidOidcIssuer` is false, so the
`solid:oidcIssuer` fallback is removed too (D34). DPoP is used only at the
first hop; the storage exchange is a bearer grant exchange (D32).

`scope` values are pinned to `owner` (all modes) and `admin` (read-only), both
with the subject's own UAS as client; see
[§ C6](#c6--token-carried-storage-authorization-planned-2026-11-17).

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
- The existing ID-token → ID-JAG path remains the current flow until C6; C6
  pins the first exchange to a DPoP-bound access token (`…:access_token`, D30).
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
- DPoP-bound final access token: deferred; bearer with `aud` = storage (D32).
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
  **Implemented 2026-11-17:** `OwnerAccessClaimValidator` checks the claim
  against the owner's grants (`grantCoversClaim`); C6 bounds the remaining
  revocation window by the token lifetimes.
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
  tokens still live until expiry; with C6 the storage no longer re-reads grants
  per request, so revocation is eventual and bounded by the token TTLs (D26).
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
  ID-JAG chain for storage-facing access. **C6 owns this** (D25).
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

## C6 — Token-carried storage authorization (planned 2026-11-17)

**Decision (2026-11-17, design pinned).** A data storage authorizes only from
the access token its own authorization server issued: an ODRL `access` claim, a
`scope` minted at the exchange for the storage owner or an org admin (both with
their own UAS as client), or a public grant. The registry storage is ID-JAG
only and requires no access claim; ACP authorizes it. No runtime registry grant
matching on data storages; `AdminPermissionReader` is removed.

**Credential classes (data storage)**

| Presented credential | Authority | Runtime |
|---|---|---|
| no `Authorization` header | public grants | public reader (read-only) |
| access token with `access` claim | AS exchange (`grantCoversClaim`) | claim engine |
| access token with `scope: owner` | storage owner + own UAS at exchange | all modes |
| access token with `scope: admin` | `DataRegistry` `AdminGrant` + own UAS at exchange | read-only |
| invalid / expired token | — | 401, never anonymous |
| claimless token without owner/admin scope | none | deny (must not be issued) |

The storage exchange (ID-JAG → access token) is a bearer grant exchange: no
DPoP proof is used or required, and the final access token is bearer (D32).
DPoP applies only to the first hop at the user's UAS (D30).

**Done when**

- A data-storage exchange with no `access` claim and without an owner/admin
  match is rejected with `invalid_grant`; claimless non-owner/non-admin tokens
  are never issued.
- Owner/admin are minted as separate `scope` values at the storage exchange,
  each bound to the subject's own UAS as client; `AdminPermissionReader`
  (class, config, export) is removed and its owner+UAS predicate moves into the
  exchange policy.
- `SaiPermissionsEngine` is claim-only: the no-claim `getPermissions` switch,
  `findAdminModes`, `findGrant` identity matching, and the public fallback are
  removed. Target type/registration/`Inherited` resolution stays.
- Public access is a separate read-only reader and works with no token or any
  valid token, independently of the `access` claim.
- Data and registry authorization servers accept only ID-JAG subject tokens;
  the auth service accepts only the user's DPoP-bound access token (IdP/UAS
  access token or self-issued `at+jwt`) plus incoming ID-JAGs. CID/did:key
  token suites are removed everywhere in the SAI configs.
- The ID-JAG and the access token carry the same `@context` URI; parsing uses
  the local bundled copy.
- The final access token is a bearer token with the storage as its only `aud`;
  the first-hop DPoP-bound access token has only the user's UAS as `aud` (no
  `solid`).
- `SessionManager` uses the ID-JAG chain; no production path exchanges a raw ID
  token at a storage.
- Registry exchange is ID-JAG only, requires no access claim, and copies none;
  data exchange requires a claim or owner/admin scope.
- No old grant/token compatibility: changes land atomically; old tokens expire.
- Revocation is documented as eventual, bounded by the ID-JAG and access-token
  lifetimes.

**Depends on:** C1–C5.

**Order**

1. Token shape + exchange: `scope` in `LwsAccessTokenIssuer`/extractor/reader,
   exchange policy (claim required unless owner/admin), owner/admin detection,
   same claim context in both tokens, final token `aud` = storage only.
2. Runtime: claim-only engine, public reader, remove `AdminPermissionReader`.
3. Credential surface: ID-JAG-only storage verifier, first-hop
   `subject_token_type=…:access_token`, first-hop `aud` = UAS only (drop
   `solid`), remove CID/did:key suites, `SessionManager` migration,
   `invalid_grant` → tokenless client behavior.
4. Cleanup: remove `findAdminModes`/registry branches, update config/docs, full
   `/test`.

**Green gate:** full package gate + full Dagger suite.

**`/test` acceptance:** `policy-engine.test.ts` (owner/admin/public/claim
matrix), `lws-auth.test.ts` (claimless registry; tokenless public;
`invalid_grant` fallback), `impersonation.test.ts`, session-backed suites
(`check-equivalence`, `roles`, `reconciliation`, `authorization`,
`org-context`, `personal-admin`), plus package token/permission tests.

**Touchpoints**

- CSS fork `LwsAccessTokenIssuer.issue`/`verify`: optional `scope` claim;
  `LwsTokenHttpHandler.exchange`: an injectable exchange access policy that
  mints `scope` (owner/admin) and rejects claimless non-owner/non-admin
  requests; `LwsAccessTokenExtractor`: expose `scope` in credentials.
- CSS `LwsAccessTokenIssuer.issue`/`LwsAccessTokenExtractor`: bearer final
  token, single storage `aud`, same claim context URI as the ID-JAG; no DPoP
  binding (D32).
- CSS `PolicyEngineReader`: forward `scope` next to `access`/`storage`.
- `packages/components/src/SaiPermissionsEngine.ts`: split into a claim-only
  engine (scope branch + claim branch) and a public reader; remove the no-claim
  registry switch, `findAdminModes`, the `uas` special case, and the public
  fallback; keep the target/registration helpers.
- New `SaiStorageTypeDescriber`/storage-description types (`DataStorage`,
  `RegistryStorage`) and `IdJagTokenHandler.isRegistryStorage` discovery; remove
  `claimlessStorageOrigins`.
- New `PublicPermissionReader` (read-only) over
  `SaiAuthorizationManager.getAuthorizationData(storage)`, unioned with the
  token reader (`UnionPermissionReader`).
- Remove `packages/components/src/AdminPermissionReader.ts`,
  `config/ldp/authorization/readers/admin.json`, the wrapper in
  `config/ldp/authorization/readers/default.json`, and the export.
- `OwnerAccessClaimValidator` or a new exchange policy: owner check
  (`PodStore.getOwners` + `discoverAuthorizationAgent`, cached) and admin check
  (`AdminGrant` with `scopeOfAdminGrant DataRegistry`, policy assignee =
  subject, client = subject's authorization agent).
- `packages/components/config/identity/id-jag-accept.json`: replace the storage
  `SubjectTokenVerifier` waterfall with the ID-JAG verifier only (CSS
  `OverrideParameters` on the `handlers` array); split the data and registry
  config for the claim requirement.
- `packages/components/config/identity/id-jag.json` / `IdJagTokenHandler`:
  accept only the DPoP-bound access-token credential; pin
  `subject_token_type` to `…:access_token` in
  `packages/lws-auth/src/{credential,tokens}.ts` and
  `buildSelfIssuedCredential` (the current default is `…:id_token`).
- `packages/components/config/identity/id-jag.json` and `id-jag-accept.json`:
  set `acceptSolidOidcIssuer: false` and `additionalAudiences: []`;
  `requireRestrictedTokens: true` enforces the UAS audience. Keep the `cnf`
  check for DPoP. `SelfIssuedSession.generateSelfIssuedAccessToken` uses the
  UAS as the self-issued `at+jwt` `aud` (D33).
- `packages/components/src/SessionManager.ts`: `createLwsAuthFetch` (ID-JAG
  chain) instead of `createLwsFetch` with the raw session access token.
- `packages/utils/src/lws-auth.ts`: the storage exchange helper accepts ID-JAG
  subject tokens only; `packages/lws-auth` treats storage `invalid_grant` as
  “no token” and retries tokenless for public data.
- `packages/lws-auth/src/tokens.ts`: `requestIdJag` sends the DPoP proof;
  `requestAccessToken` sends none (the storage exchange is a bearer grant
  exchange, D32).
- Tests: `test/policy-engine.test.ts`, `test/lws-auth.test.ts`,
  `packages/components/test/policy-engine-claim.test.ts`, and every
  owner-session suite.

**Exchange algorithm (data storage)**

1. Verify the subject token (ID-JAG only; bearer grant exchange, no DPoP
   proof).
2. `subject.access` present → `verifyAccessClaim` (one storage, requested
   `resource`) + owner-grant coverage (`OwnerAccessClaimValidator`) → issue with
   `access`.
3. else owner + own UAS → issue with `scope: owner`.
4. else admin + own UAS → issue with `scope: admin` (read-only).
5. else `invalid_grant`.

A claim always wins over `scope`: an owner/admin who presents a narrower claim
gets the claim, not the broad scope.

**Runtime (data storage)**

1. `AuxiliaryReader` → `PathBasedReader` → `ReadDeleteReader` →
   `UnionPermissionReader(token, public)`.
2. Token reader: `scope: owner` → all modes; `scope: admin` → read; `access`
   claim → claim engine; nothing else. No registry grant matching.
3. Public reader: public grants for the target storage, read-only. Public is
   credential-independent: anonymous and any valid token (with or without an
   `access` claim) get it. It is never a claim fallback.

**Scope claim (pinned 2026-11-17)**

- The claim is `scope`; values are `owner` (all modes) and `admin` (read-only).
  Both are minted only with `client_id` = `sub`'s authorization agent; `owner`
  wins if both would apply.
- Honor `scope` only from this server's issuer. Tokens from `trustedIssuers`
  must not be able to mint `owner`/`admin`.
- `scope` is a storage authorization input, not an ODRL grant; do not treat it
  as a claim or look up a grant for it.
- Current behavior (verified 2026-11-17): `findAdminModes` matches only
  `odrl:assignee = agent`, so the engine today grants admin read with **any**
  client; `test/policy-engine.test.ts` “admin, some agent/client” (line ~606)
  asserts that with the public test client. C6 changes it: “admin using UAS”
  (line ~650) stays 200, admin + other client is `invalid_grant`/denied. The
  registry ACP already binds the admin to `agent` + `client` (own UAS) in
  `environments/data/registry.trig`, and `org-admin-feature.md` specifies admin
  reads “with their own UAS credentials”, so C6 brings the data engine in line
  with ACP and the design.

**First ID-JAG exchange (user's UAS)**

| Subject token presented at the UAS | Accepted |
|---|---|
| DPoP-bound OIDC access token of the user's IdP/UAS (`cnf.jkt`, `aud` = UAS) | yes |
| SAI self-issued `at+jwt` (`cnf.jkt`, `aud` = UAS) | yes |
| unbound token (no `cnf`), even with `aud` = UAS | no — C6 keeps the `cnf`/DPoP check; `requireRestrictedTokens` only enforces the audience |
| CID / did:key | no (suite not configured for the ID-JAG endpoint) |
| incoming ID-JAG (impersonation hop) | yes |

- The credential must be sender-constrained: `cnf.jkt` plus a `DPoP` proof for
  the token request. A regular ID token (client-only audience, no `cnf`) is
  refused, and a claimed `…:access_token` type is not the security boundary.
- The only audience is the user's UAS (`aud` = UAS). The `solid` audience is
  removed from `IdTokenVerifier.additionalAudiences` and the self-issued
  `at+jwt`; no external IdP/UAS is trusted for the first hop (D33).
- `subject_token_type` is pinned to `…:access_token`. The current client default
  is `…:id_token` (`packages/lws-auth/src/tokens.ts`) and
  `buildSelfIssuedCredential` does not set the type; both must be aligned so the
  declared type matches the DPoP-bound access-token rule. The UAS handler must
  reject `…:id_token` (the `OidcSubjectTokenVerifier` accepts both types).
- Audience: use `requireRestrictedTokens: true` with `audience` = UAS and no
  `additionalAudiences`. It rejects unbound tokens whose `aud` does not include
  the UAS, but it also accepts an unbound token whose `aud` = UAS; keep the
  `cnf`/DPoP check (and/or reject `…:id_token`) for DPoP-bound-only.
- Current gap: `OidcSubjectTokenVerifier.verifyRestriction` accepts an unbound
  token whose `aud` includes the UAS (`requireRestrictedTokens`). The `cnf`
  check is what closes the DPoP gap; `requireRestrictedTokens` handles the
  audience only.
- The UAS is the issuer, not a client: it mints the ID-JAG itself and never
  presents a DPoP-bound access token to a storage or another UAS. The
  impersonation hop presents an ID-JAG, not a DPoP-bound access token.
- CID and did:key are not subject-token suites anywhere in the SAI configs.
  CID/WebID **document discovery** (`interop:hasAuthorizationAgent`, CID
  service documents) is not a credential and remains.
- DPoP applies only to this first hop. The storage AS exchange (ID-JAG →
  access token) is a bearer grant exchange with no DPoP proof; the final token
  is bearer (D32).

**Registry server**

- The token endpoint on the registry service accepts only ID-JAG, requires no
  access claim, and does not copy one into the access token: ACP authorizes
  registry resources and needs only `sub`/`client_id`.
- The storage subject-token restriction still applies (ID-JAG only); the owner
  session migration covers the registry reads.

**Client behavior**

- A storage `invalid_grant` at exchange means “no token for this storage”, not
  a crash: cache it per storage and retry the request without `Authorization`
  (public data). Bounded, once.
- DPoP is only for the first hop; the storage request carries the bearer access
  token, and the storage AS exchange does not send or require a DPoP proof.
- A stale/invalid token is a 401, not anonymous; the client must drop it, not
  silently fall back.
- RPC/`.sai` stays on the cookie session with the UAS as client; no token or
  claim change.

**Removal / migration**

- Remove the CID/did:key/OIDC handlers from the storage `SubjectTokenVerifier`;
  the auth service keeps only the OIDC access-token and ID-JAG suites (it never
  had CID/did:key).
- Migrate `SessionManager` before removing OIDC at storages; owner-side data
  and registry reads then use ID-JAG (owner scope on data, claimless on
  registry).
- Remove `AdminPermissionReader` and `findAdminModes`; keep
  `SaiAuthorizationManager` (exchange validators, admin detection, public
  reader).
- No old grant/token migration: breaking changes land atomically; short token
  TTLs bound the overlap. Do not add a version or dual-read gate.

**Hazards / open**

- `scope` shape is pinned (separate `owner`/`admin`, both own-UAS-bound). The
  current engine does not check the admin's client; update
  `test/policy-engine.test.ts` “admin, some agent/client” to the new denial and
  keep “admin using UAS” green.
- Admin grants carry no client field; the UAS binding is an exchange-time
  check. An admin using a non-UAS client needs a normal access claim.
- Public reader cost: one owner-registry query per request; cache per storage
  and target.
- Service paths (`.notifications/lws/`) accept a token for any storage on the
  server; confirm the claim/scope rule covers them.
- Final token is bearer (D32): replayable until expiry; keep the 300 s TTL.
  DPoP binding is a later slice, not part of C6; the storage exchange does not
  use or require DPoP.
- Same context URI (D4): a token whose `@context` differs from the bundled
  `ODRL_ID_JAG_CONTEXT` is malformed and denied; no compact/alternate context.
- First-hop audience (D33): only the user's UAS is `aud`; remove `solid` from
  the config and the self-issued token. Use `requireRestrictedTokens: true` for
  the audience; it does not enforce `cnf`, so keep the DPoP check.
- No Solid-OIDC issuer fallback (D34): `acceptSolidOidcIssuer: false`; trust
  ID-JAG issuers via `trustedIssuers` or `lws:OpenIdProvider` only.
- 403 recovery: with token-carried authorization a 403 is a target/claim
  denial, not a revocation signal; keep the bounded retry only for 401 (or
  refresh after `invalid_grant` → tokenless public).

### Implementation (2026-11-18)

- **CSS fork.** `LwsAccessTokenIssuer` mints a space-delimited `scope` (claim
  and scope are mutually exclusive); `LwsTokenHttpHandler` has an injectable
  `LwsTokenExchangePolicy`, `copyAccessClaim`, and maps
  `LwsExchangeAccessDeniedError` to `invalid_grant`; `LwsAccessTokenExtractor`
  exposes `scope` only for tokens signed by its own issuer;
  `PolicyEngineReader` forwards it. `OidcSubjectTokenVerifier` gains
  `requireSenderConstrained`, so the first hop needs `cnf.jkt` even when the
  audience is the UAS. The CSS token handler has a named `@id` so SAI configs
  can override its access policy/copy flag.
- **Exchange.** `StorageExchangeAccessPolicy` mints `owner` (all modes) for the
  storage owner with their own UAS as client, and `admin` (read-only) for a
  `DataRegistry`-scoped `AdminGrant` holder with their own UAS; every other
  claimless exchange is `invalid_grant`. A claim always wins over a scope.
  Registry config is ID-JAG-only, requires no claim, and sets
  `copyAccessClaim: false`. Data config wires `OwnerAccessClaimValidator` and
  the exchange policy.
- **Runtime.** `SaiPermissionsEngine` is claim/scope only and reports granted
  modes as positive permissions, so `UnionPermissionReader` cannot let a token
  veto the credential-independent `PublicPermissionReader`. `AdminPermissionReader`
  and `findAdminModes` are removed; `readers/default.json` is
  `ReadDeleteReader` → `UnionPermissionReader(token, public)`.
- **Credentials.** Storages replace the subject-token waterfall with only the
  ID-JAG verifier (`acceptSolidOidcIssuer: false`); the auth endpoint accepts
  only `…:access_token` and `…:id-jag` and rejects `…:id_token`. The first hop
  uses `…:access_token` with `aud` = the UAS; the self-issued default token is
  the UAS audience, while `.sai` login keeps `solid` for the session bearer.
  Seed/template WebID documents gain an `lws:OpenIdProvider` service (CID
  discovery) instead of the Solid-OIDC issuer fallback.
- **Client.** `packages/lws-auth` defaults to `…:access_token`; a storage
  `invalid_grant` returns “no token”, caches it briefly, and `createLwsFetch`
  retries once without `Authorization` (public data). Storage exchanges are
  bearer grant exchanges (no DPoP). `SessionManager` uses the two-step ID-JAG
  chain instead of a raw session token.
- **Registry claimless guard.** The storage description advertises
  `sai:DataStorage` / `sai:RegistryStorage` (SAI context aliases), and
  `IdJagTokenHandler.isRegistryStorage` skips claim derivation only for a
  discovered `RegistryStorage`. This replaces the local
  `claimlessStorageOrigins` allowlist and stays open-world. A
  per-resource in-flight guard plus the identity-only fallback keeps the
  `getSession` → registry bootstrap → claim derivation path from recursing or
  returning 500.
- **Tests/gates.** Package `typecheck`, `check`, full `vitest` (680 passed, 26
  skipped, 2 todo), components build, CSS targeted Jest (76), and the full
  Dagger suite (24 files / 199 tests) are green. The CSS fork needs its commit
  and the `package-lock.json` update after review; the suite above was run
  against the updated sibling checkout mounted into `node_modules`.

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

**D3 — Full migration to the new shape; no backward compatibility.** *pinned;
revised 2026-11-17.* Old grant stores/seed/mirrors are rewritten or dropped
atomically; no dual-read and no compatibility window. Breaking changes are
accepted.

**D4 — The ID-JAG and the access token use the same `@context` URI
(`https://www.w3.org/ns/solid/interop-context/v1/odrl-id-jag-context`), with a
local bundled copy.** *pinned; clarified 2026-11-17.* The access token carries
the same URI; verification/parsing always uses the local copy and never fetches
the context. Only the `access` subtree is expanded; the JWT payload is not
treated as one JSON-LD document.

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

**D10 — Claim-first policy engine; no identity or registry fallback for a
claim.** *pinned; narrowed by C6.* The claim path never falls back to registry
matching or public grants. C6 removes the no-claim registry branch from data
storages entirely: owner/admin are carried by the token `scope`, public by a
separate reader, and a claimless non-owner/non-admin exchange is rejected.

**D11 — `401` refreshes the access token; `403` is a target/claim denial.**
*pinned; revised 2026-11-17.* A `401` refreshes the token (then the chain if
needed). A `403` does not restart the chain: with token-carried authorization it
means the claim/scope does not cover the target (or the grant was revoked; the
next exchange returns `invalid_grant`). `invalid_grant` at a UAS is the
revocation signal.

**D12 — Admin impersonation, `ProxyAdminHandler` removal, and `/sparql-admin`
replacement are future TODOs.** *pinned (deferred).* The proxy stays until
explicit admin impersonation authority and client/network support exist.

**D13 — There is no request/approval mode selection.** *resolved 2026-11-17.*
Impersonation is the only delegation flow; need-based requests ask for source
access, not delegated grants.

**D14 — No compatibility for old ID-JAG/access tokens or grants.** *pinned;
revised 2026-11-17.* Short token TTLs and an atomic deployment cutover are the
only migration; there is no version gate or dual-read. Old tokens simply
expire.

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

**D22 — Storage authorization is token-carried only.** *pinned 2026-11-17.*
A data storage evaluates the access token it issued — an ODRL `access` claim, a
`scope` minted for the owner/admin, or a public grant — and never matches
registry grants at request time.

**D23 — Owner/admin are exchange-minted `scope`, not request-time checks.**
*pinned 2026-11-17.* `AdminPermissionReader` is removed; the owner+UAS predicate
moves to the exchange. Owner is `sub` = storage owner with `client_id` =
`sub`'s authorization agent; admin is a `DataRegistry` `AdminGrant` holder with
the same `client_id` binding. Either with a non-UAS client needs a normal
access claim.

**D24 — Public access is credential-independent.** *pinned 2026-11-17.* Public
grants grant read to any request, with no token or any valid token, and are
evaluated in a separate reader. An access claim never covers public and the
claim path never falls back to public.

**D25 — Storages accept only ID-JAG subject tokens; no CID/did:key suites
anywhere.** *pinned 2026-11-17.* The auth service accepts only the user's
DPoP-bound access token (IdP/UAS access token or self-issued `at+jwt`) and
incoming ID-JAGs. `SessionManager` moves to the ID-JAG chain. CID/WebID document
discovery is not a credential and remains.

**D26 — Revocation is eventual for claim/scope tokens.** *pinned 2026-11-17.*
The claim (and owner/admin state) is re-evaluated at ID-JAG mint and access-token
exchange; the bound is `max(ID-JAG TTL, access-token TTL)` plus renewal margin
(≈5.5 min with the 300 s defaults). Public stays request-time.

**D27 — Exchange requirements are per server.** *pinned 2026-11-17.* Data
storages require a claim or owner/admin match. The registry storage is ID-JAG
only but requires **no** access claim and does not copy one into the token;
ACP authorizes registry resources.

**D28 — Claimless non-owner/non-admin exchange is `invalid_grant`.**
*pinned 2026-11-17.* There is no legitimate claimless non-owner/non-admin case.
Clients treat the error as “no token for this storage”, cache it, and retry the
request once without `Authorization` (public data). This is accepted, not a
compatibility concern.

**D29 — `scope` is a storage-AS claim, trusted only from this issuer.**
*pinned 2026-11-17.* The claim name is `scope`; values are `owner` (all modes)
and `admin` (read-only), both bound to the subject's own UAS. `owner` wins if
both would apply; tokens from `trustedIssuers` must not mint it.

**D30 — The first ID-JAG exchange uses a DPoP-bound access token.** *pinned
2026-11-17.* The user's UAS accepts only a sender-constrained credential
(`cnf.jkt` + `DPoP` proof): the IdP/UAS access token or the SAI self-issued
`at+jwt`, declared as `…:access_token`. The handler rejects `…:id_token`. The
audience uses `requireRestrictedTokens: true` (`audience` = UAS, no
`additionalAudiences`); that option enforces the audience but not DPoP, so the
`cnf` check remains. CID/did:key suites are not configured. DPoP applies only to
this first hop; the storage exchange does not use or require it (D32).

**D31 — The UAS is always the ID-JAG issuer, never a client of another UAS.**
*pinned 2026-11-17.* A UAS that needs a storage token mints the ID-JAG itself
(self-issued, D6); the impersonation hop presents an ID-JAG. The DPoP-bound
access token appears only at the user's own UAS (first hop), never at a storage
or another UAS.

**D32 — The final access token is a bearer token with the storage as its only
audience.** *pinned 2026-11-17.* It is not DPoP-bound for now (deferred); the
storage validates the token and relies on the carried claim/scope. The token is
per storage; no other audience values. The storage AS exchange (ID-JAG →
access token) is a bearer grant exchange: it does not use or require a DPoP
proof; the ID-JAG itself is the credential.

**D33 — The first-hop access token's only audience is the user's UAS.** *pinned
2026-11-17.* The initial exchange always happens at the user's IdP/UAS, so the
DPoP-bound access token has `aud` = that UAS only. Remove the `solid` audience
from `IdTokenVerifier.additionalAudiences` and the self-issued `at+jwt`
(`SelfIssuedSession`); no external IdP/UAS is trusted for the first hop.

**D34 — No Solid-OIDC issuer fallback.** *pinned 2026-11-17.*
`acceptSolidOidcIssuer` is false on `IdTokenVerifier` and
`IdJagSubjectTokenVerifier`. An ID-JAG issuer is trusted via `trustedIssuers` or
an `lws:OpenIdProvider` service in its subject document; the `solid:oidcIssuer`
triple is not used.

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
- **Claim-first rollout:** there is no version or dual-read gate; old
  ID-JAG/access tokens simply expire. Deployments cut over atomically
  (D3/D14).
- **Token size:** ODRL claims with selected instances can be large; enforce
  policy/target limits and non-identifying final claims.
- **Final `client_id`:** do not use a personal UAS client ID when impersonation
  must hide the delegatee; use the shared app/UAS or a pseudonymous client.
- **403 loops:** cache retry state per storage/target; do not restart on every
  deny.
- **Admin future:** `ProxyAdminHandler` also serves org-own data content and is
  a network/JSON-LD boundary; impersonation only replaces its credential reason.
- **`scope` trust:** `scope: owner`/`admin` is a bearer-visible authorization
  grant. Honor it only from the storage's own issuer (not from
  `trustedIssuers`), and never let it bypass the claim-coverage check when an
  `access` claim is present.
- **Owner ≠ owner+UAS:** an owner using an app client needs a normal access
  claim; do not widen the owner exception to “any client of the owner”.
- **Admin semantics:** `scope: admin` is read-only and requires the admin's own
  UAS as client. The current engine matches only `assignee` and
  `test/policy-engine.test.ts` locks in a non-UAS client case; C6 updates it.
- **Public reader cost and safety:** the public reader is the only remaining
  request-time grant read; cache per storage/target and keep it read-only. It
  must not become a general fallback for non-public grants.
- **Tokenless fallback:** a storage `invalid_grant` means “no token”; an
  expired/invalid token is still a 401. Do not let a stale token silently
  degrade to anonymous.
- **Storage subject-token removal:** dropping CID/did:key/OIDC at storages
  breaks any remaining `createLwsFetch` caller; migrate `SessionManager` and
  peer registry reads first. The auth service keeps only the OIDC access-token
  and ID-JAG suites; it never had CID/did:key.
- **CID discovery ≠ CID credential suite:** `discoverAuthorizationAgent` and the
  CID service-document helpers are discovery, not subject-token suites. Do not
  remove them when dropping `CidSubjectTokenVerifier`.
- **First-hop type mismatch:** the client default is `…:id_token` today
  (`packages/lws-auth/src/tokens.ts`; `buildSelfIssuedCredential` does not set
  it) and `OidcSubjectTokenVerifier` accepts both types. Pin `…:access_token`
  and reject `…:id_token` at the handler so the declared type matches D30; the
  `cnf`/DPoP check remains the actual enforcement (closing the current
  `requireRestrictedTokens` gap for unbound tokens with `aud` = UAS).
- **First-hop audience:** `aud` is the user's UAS only (D33); remove `solid`
  from `IdTokenVerifier.additionalAudiences` and the self-issued `at+jwt`.
  `requireRestrictedTokens: true` enforces the audience; it does not enforce
  `cnf`, so keep the DPoP check.
- **No Solid-OIDC issuer:** `acceptSolidOidcIssuer` is false on
  `IdTokenVerifier` and `IdJagSubjectTokenVerifier` (D34); trust via
  `trustedIssuers` or `lws:OpenIdProvider` only.
- **Final token is bearer:** not DPoP-bound for now (D32); a stolen token is
  replayable until expiry. Keep the 300 s TTL; DPoP binding is a later slice.
  The storage exchange does not use or require DPoP; only the first hop does.
- **Context identity:** the access token must carry the same `@context` URI as
  the ID-JAG; parsing uses the local copy. A different/missing context is a
  malformed claim (deny), not a compact variant.
- **No compatibility:** old grants/tokens are not supported; deployments cut
  over atomically. Short TTLs bound the overlap; do not add a version gate.
- **Service paths:** `.notifications/lws/` accepts a token for any storage on
  the server; confirm the claim/scope rule still covers subscriptions.

## Open questions

- Whether final access claims keep the full ODRL policy or a filtered
  single-storage subset (recommended: filter to the requested storage at the
  final exchange).
- Audit/visibility mapping for hidden actors.
- Exact split of reusable LWS helpers between `packages/lws-auth` and test utils.
- Public reader caching/TTL and whether public grants are also exposed through
  ACP/WAC on data storages.
