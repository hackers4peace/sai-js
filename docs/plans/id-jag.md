# ID-JAG access claims — ODRL model migration, impersonation, delegation

> **Status:** 🔶 in progress — **C0 landed** (new ODRL shape only, no token
> behaviour changes); package gate and **full Dagger suite green** (24 files /
> 206 tests). C1 is next.
> **Last verified:** working tree (2026-11-15) — C0 verified against the current
> delegation, grant, policy-engine, ID-JAG, and Dagger code.
> **Green gate:** package gate + **full** Dagger suite after every slice
> ([§ Green gate](#green-gate)); Dagger is user-run.
> **Workstream:** LWS authorization ([`lws-auth.md`](lws-auth.md)) + grants /
> revocation. This plan owns the token-carried access-claim path and the ODRL
> shape migration that precedes it.

## Context

Today delegated grants are created by the grantor but **materialized in the
data owner's grant registry** through the owner-scoped access-request endpoint.
`validateDelegable` checks the chain at request time; the policy engine later
trusts the stored grants and matches them by:

- UAS credentials: `odrl:assignee = agent`
- app credentials: `interop:requester = agent` and `odrl:assignee = client`

The ID-JAG is currently identity-only: `sub`, `client_id`, `aud`, `jti`,
`iat`, `exp`. The storage exchanges it for an access token with the same
identity claims and no access information; `PolicyEngineReader` forwards only
`agent`, `client`, and `issuer`.

The target end state adds two token-carried paths alongside the existing
owner-access-request flow:

1. **Impersonation** — the delegatee uses the requester's identity; ACME sees
   only the requester and a narrowed ODRL access claim. The delegatee is hidden.
2. **Delegation** — the final token carries the visible actor chain
   (`sub = top-level requester`, nested `act` down to the client).

The access claim uses the **same ODRL profile as grants and access requests**,
so the policy engine evaluates one shape everywhere. C0 migrates that shape
first; C1+ adds the token flows.

## Goals / non-goals

**Goals**

- Migrate ODRL to `assigner` = delegator, `assignee` = delegatee,
  `target.owner = interop:dataOwner`; remove `requester`.
- Carry an ODRL `access` claim in the ID-JAG and final access token.
- Make impersonation the first token flow; hidden actors never appear in the
  final ID-JAG, access token, access claim, or ACME-side policy evaluation.
- Migrate current delegated grants to be **issued by and stored in the
  assigner's registry**, while keeping the existing owner access-request
  endpoints/workflows available for explicit delegation requests.
- Keep the current owner-access-request delegation flow working.
- One ID-JAG access claim is for **one storage**; no `resource` claim.
- Bounded 403 recovery: invalidate the token chain for that storage and restart
  it once.

**Non-goals (explicit follow-ups)**

- Admin impersonation and removal of `ProxyAdminHandler` — future TODO.
- Replacing `/sparql-admin` — separate transport/security question.
- Deciding the request/approval wire semantics for choosing delegation vs
  impersonation — designed after the token flows work (C4).
- DPoP-bound final access tokens — evaluate after the claim path works.
- Batch validation / new revocation protocol — reuse the existing revocation
  primitives where possible.

## State map

| Capability / primitive | Status | Code anchors | Verified by | Notes |
|---|---|---|---|---|
| New ODRL shape: `assigner` = delegator, `target.owner` = data owner, no `requester` | ✅ landed — package + Dagger green | `packages/data-model/src/grant.ts` (`OdrlPermission`, `OdrlTarget`, `normalize*`, `deriveFields`, `grantAccess`, `toJsonLd`); `packages/data-model/src/context.ts`; `packages/utils/src/sai-context.ts` | data-model framing/pojo tests; grant-chain/generation; `/test` policy/delegation | C0; atomic commit |
| Full grant/seed/mirror/admin migration to the new shape | ✅ landed — package fixtures/seed migrated; Dagger green | `environments/data/registry.trig`; grant registries/mirrors/issuer-side replicas; `temporal/activities/admin.ts` | package + `/test`; migration audit query | C0; no dual-write after cutover |
| ODRL ID-JAG context URI + local copy; expand only `access` | ⬜ open | `packages/utils/src/jsonld-parser.ts`; new `odrl-id-jag-context` module; `IdJagIssuer`/verifier | package context/ID-JAG tests | C1 |
| ID-JAG `access` claim carried into the access token | ⬜ open | `IdJagIssuer`, `IdJagSubjectTokenVerifier`, CSS `LwsTokenHttpHandler`/`LwsAccessTokenIssuer`/`LwsAccessTokenExtractor`, `PolicyEngineReader` | package ID-JAG/LWS tests; `/test` `lws-auth.test.ts` | C1 |
| Claim-first policy-engine evaluation for token `access` claims | ⬜ open | `SaiPermissionsEngine.getPermissions`/`findGrant`; `Credentials` shape | package policy-engine tests; `/test` `policy-engine.test.ts` | C1 |
| One storage per ID-JAG access claim; no `resource` claim; final `aud` = storage | ⬜ open | `IdJagTokenHandler`, `IdJagSubjectTokenVerifier`, `lws-auth` cache, CSS token handler | package + `/test` | C1 |
| User's UAS self-issues the initial ID-JAG; CID designation is the root authority | ⬜ open | `IdJagIssuer`/`IdJagTokenHandler`; `packages/lws-auth`; `IdTokenIssuer`/CID docs | package + `/test` | C1; UAS-as-client case |
| Impersonation chain: assigner rewrite, hidden actor, final token has no delegatee | ⬜ open | `IdJagTokenHandler`, `IdJagSubjectTokenVerifier`, `lws-auth`, CSS token issuer/extractor | new `/test/impersonation.test.ts` + existing suites | C2 |
| Delegated grants issued/stored in the assigner registry; owner endpoint kept | ⬜ open | `grant-generation.ts`, `activities/grants.ts`, `AccessRequestHandler`, `delegation-request.ts`, `GrantReplica`/grant registry | package + `/test` delegation/equivalence | C2; migration/backfill |
| Delegation token chain (`sub` top-level, nested `act` to client) | ⬜ open | `IdJag*`, `lws-auth`, CSS token handler, policy engine | new delegation-token `/test` + existing suites | C3 |
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

**`/test` acceptance:** `policy-engine.test.ts`, `delegation-endpoint.test.ts`,
`check-equivalence.test.ts`, `access-grants.test.ts`, `share.test.ts`,
`roles.test.ts`, `org-context.test.ts` (user-run).

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

- C0 must not change token behaviour. The existing owner-request delegation
  flow continues to work with the new shape.
- The old `requestDelegations`/`validateDelegable` path remains through C0.

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

## C2 — Impersonation default + assigner-owned grants

**Done when:** Bob can impersonate YoYo through Bob's UAS → YoYo's UAS → ACME's
AS; ACME sees only YoYo and the narrowed ODRL claim; Bob/`act`/hidden grant
references do not appear in the final ID-JAG or access token. Delegated grants
are issued and stored in the assigner's registry by default; the owner
access-request endpoint/workflow still works when explicitly used.

**Depends on:** C1.

**Green gate:** full package gate + full Dagger suite.

**`/test` acceptance:** new `impersonation.test.ts`, `lws-auth.test.ts`,
`policy-engine.test.ts`, `delegation-endpoint.test.ts`,
`check-equivalence.test.ts` (user-run).

**Touchpoints**

- `IdJagTokenHandler`/`IdJagSubjectTokenVerifier`: multi-hop subject -> next
  ID-JAG exchange; rewrite `assigner`, keep `target.owner`/target/action/scope;
  drop hidden actors.
- `grant-generation.ts` / `activities/grants.ts` / grant registry: delegated
  grants minted/stored in the assigner's registry; owner copies only when the
  owner request path is used.
- `lws-auth`: initial self-issued ID-JAG for the next UAS; final exchange.
- CSS token issuer/extractor: copy sanitized claim; no hidden actor fields.
- Migration/backfill of existing delegated grants into assigner registries;
  keep the owner-side endpoint/workflow.

**Notes**

- The first ID-JAG is the end user's app/UAS authorization (most narrow).
- At the impersonation hop, the outgoing claim has `assigner = requester` and
  no delegatee identity; permission/target/action/scope stay unchanged.
- ACME cannot validate the hidden delegatee's grant; it validates the final
  claim against its own grant to the visible subject. This is the accepted
  strict-hiding trade-off.
- Admin impersonation remains a TODO; `ProxyAdminHandler` stays.

## C3 — Delegation via token exchange

**Done when:** the same chain works in delegation mode: final `sub` = top-level
requester, nested `act` = intermediate actors + client (most nested), final
claim `assigner` = top-level requester, `assignee` = final client/actor, and
the policy engine evaluates it claim-first. Current owner-request delegation
continues to work.

**Depends on:** C2.

**Green gate:** full package gate + full Dagger suite.

**`/test` acceptance:** new delegation-token test,
`lws-auth.test.ts`, `policy-engine.test.ts`,
`delegation-endpoint.test.ts` (user-run).

**Touchpoints**

- `IdJagIssuer`/`IdJagTokenHandler`/verifier: nested `act` construction and
  validation; no hidden actor when mode = delegation.
- `lws-auth` token chain; CSS token issuer/extractor; policy engine.
- Existing `requestDelegations`/`AccessRequestHandler` path unchanged.

**Notes**

- Client is the most nested actor; when the UAS is the client, that is the UAS
  IRI.
- The final claim is the re-issued ODRL policy from the top-level requester to
  the final client/actor; `target.owner` remains the data owner.
- Coexistence with the current delegation flow is deliberately decided in C4.

## C4 — Coexistence decisions / follow-ups (design only)

No implementation in this slice until the token flows are green.

- How requests/approvals indicate delegation vs impersonation.
- Whether owner materialization/mirroring is required for revocation or only
  optional visibility.
- Whether the owner access-request endpoint stores a copy, approves, or just
  acknowledges.
- Admin impersonation + `ProxyAdminHandler` removal; `/sparql-admin` future.
- DPoP-bound final access token for impersonation.
- Audit/visibility mapping for hidden actors.

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

**D8 — Impersonation is the first token flow; delegation token flow follows.**
*pinned for sequencing.* C2 lands impersonation; C3 adds nested `act`.

**D9 — Delegated grants are issued/stored in the assigner's registry by
default; the owner access-request endpoint/workflow stays available.** *pinned.*
Explicit owner-requested materialization remains a supported coexistence path.

**D10 — Claim-first policy engine for tokens with `access`; registry matching
only when no claim is present.** *pinned.* This supports app and agent cases
uniformly and avoids hidden-assignee special cases.

**D11 — 403 recovery invalidates the access token/chain for that storage and
retries once.** *pinned.* Bounded, per-storage, no loops; `invalid_grant` at a
UAS is the revocation signal.

**D12 — Admin impersonation, `ProxyAdminHandler` removal, and `/sparql-admin`
replacement are future TODOs.** *pinned (deferred).* The proxy stays until
explicit admin impersonation authority and client/network support exist.

**D13 — Request/approval mode selection (delegation vs impersonation) is a
C4 decision.** *open.* The token flows do not pre-empt the request wire shape.

**D14 — Old ID-JAG/access tokens must not be silently interpreted under the new
semantics.** *pinned.* Use short TTL plus a version/required-claim gate; old
policy engines must not ignore `access` for impersonation-shaped tokens.

## Hazards / verification

- **Migration completeness:** owner registries, reciprocal mirrors, issuer-side
  replicas, admin grants, seed, and test fixtures must all move. Add an audit
  query before cutover.
- **Context scope:** expanding the whole JWT as JSON-LD will pull OAuth claims
  into RDF; only expand `access`.
- **Hidden actor leakage:** final impersonation tokens/claims must not contain
  delegatee `assignee`, `act`, requester, or resolvable grant references.
- **Claim-first rollout:** old policy engines must not ignore `access`; new
  impersonation tokens require the claim-aware engine.
- **Token size:** ODRL claims with selected instances can be large; enforce
  policy/target limits and non-identifying final claims.
- **Assigner-local grants:** the data owner may no longer have delegated grant
  bodies. Decide visibility/revocation mirroring before deleting owner copies.
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
- How a request/approval chooses delegation vs impersonation (grant field,
  request field, or both).
- Whether owner-side delegated grant copies are required for revocation or only
  optional visibility.
- Whether final access claims keep the full ODRL policy or a filtered
  single-storage subset (recommended: filter to the requested storage at the
  final exchange).
- Cutover mechanics for old grants/tokens and the migration audit gate.
