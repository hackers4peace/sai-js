---
type: architecture
title: ID-JAG access claims and impersonation
description: The ODRL grant/claim shape, the two-step ID-JAG token chain, claim-first policy evaluation, token-carried storage authorization, public reads, and read-only admin impersonation of an organization.
tags: [lws, id-jag, odrl, authorization, tokens, impersonation]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-16341e95816f0eee56f18c8a
    resource: repo://packages/components/src/access-claim.ts
  - id: openwiki-source-90c157df451973113a63b968
    resource: repo://packages/components/src/AdminImpersonationAuthority.ts
  - id: openwiki-source-ffb744de1143ef3d7c1ce1b0
    resource: repo://packages/components/src/grant-policy.ts
  - id: openwiki-source-05fbc9f39df090fabf4c7ca5
    resource: repo://packages/components/src/IdJagIssuer.ts
  - id: openwiki-source-95310ca3c4786b5a5c369581
    resource: repo://packages/components/src/IdJagSubjectTokenVerifier.ts
  - id: openwiki-source-759ab06bf1f6a0b228effe16
    resource: repo://packages/components/src/IdJagTokenHandler.ts
  - id: openwiki-source-c80b33b854202a2403e8b744
    resource: repo://packages/components/src/PublicPermissionReader.ts
  - id: openwiki-source-9cd6e2280365d84a6828353d
    resource: repo://packages/components/src/SaiPermissionsEngine.ts
  - id: openwiki-source-431ff780c51bd57ac5545ec1
    resource: repo://packages/components/src/StorageExchangeAccessPolicy.ts
  - id: openwiki-source-6b6976370d0cdcf6bd57cad3
    resource: repo://packages/data-model/src/grant.ts
  - id: openwiki-source-260c4466022f2f059867cfd5
    resource: repo://packages/utils/src/odrl-id-jag-context.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# ID-JAG access claims and impersonation

The LWS/SAI authorization model has two layers: **ODRL policies** describe who
may do what, and **ID-JAGs** carry a policy across the trust boundary between a
user's authorization server and a storage's authorization server. A data
storage authorizes a request from the token it receives, not by re-reading the
owner's grant registry. This page covers the shape, the chain, the policy-engine
evaluation, and the admin-impersonation path.

## 1. ODRL shape

The canonical permission is an ODRL policy whose `assigner` is the delegator,
`assignee` the delegatee, and whose target carries the data owner
([`data-model/src/grant.ts`](../../packages/data-model/src/grant.ts)):

```json
{
  "assigner": "https://id/yoyo",
  "assignee": "https://app.example/id",
  "action": ["http://www.w3.org/ns/odrl/2/read"],
  "target": {
    "owner": "https://id/acme",
    "storage": "https://data/acme.example/",
    "source": ["…/registration/…"],
    "partOf": ["…/registration/…"],
    "type": ["odrl:AssetCollection", "interop:DataRegistration"]
  }
}
```

- `assigner` is always the **delegator**; `assignee` the **delegatee**;
  `target.owner` is the **data owner** (mapped to `interop:dataOwner`, exposed
  as `owner` in JSON-LD).
- `interop:requester` no longer exists. A source grant has
  `assigner === target.owner`; a delegated grant has `assigner` = delegator and
  `target.owner` = data owner.
- Chain rules: root `assigner === target.owner`; delegated
  `upstream.assignee === downstream.assigner`; the same target owner, storage,
  shape tree, registration, scope, actions, and instances.
- Claim validation is **coverage**, not equality: a delegation step may narrow
  scope, actions, or selected instances ([`grant-policy.ts`](../../packages/components/src/grant-policy.ts)).

`GrantData` exposes the wire policy as `access` plus derived convenience fields
(`storage`, `grantedBy`, `dataOwner`, `registeredShapeTree`,
`hasDataRegistration`, `hasDataInstance`) that are never serialized.

## 2. ID-JAG context and claims

The ID-JAG and the access token use one context URI,
`https://www.w3.org/ns/solid/interop-context/v1/odrl-id-jag-context`, with a
locally bundled copy in
[`utils/src/odrl-id-jag-context.ts`](../../packages/utils/src/odrl-id-jag-context.ts).
Verification never fetches a remote context. Only the `access` subtree is
expanded as JSON-LD; `sub`, `aud`, `iss`, and `exp` are OAuth claims and are not
treated as RDF ([`access-claim.ts`](../../packages/components/src/access-claim.ts)).

`IdJagIssuer` mints a token with `typ: oauth-id-jag+jwt`, `iss` = the UAS,
`aud` = the requested resource authorization server, `sub` = WebID,
`client_id` = `azp`, `jti`, and a 300 s default lifetime
([`IdJagIssuer.ts`](../../packages/components/src/IdJagIssuer.ts)). It is signed
with the same Solid-OIDC key published at `/.oidc/jwks`.

## 3. The two-step chain

```text
user's UAS (auth)                    storage AS (data / registry)
  DPoP-bound access token  ──►  ID-JAG (one storage)  ──►  bearer access token
  (aud = the UAS only)           (aud = the storage)        (aud = the storage)
```

- The first hop accepts a **DPoP-bound access token** (the IdP/UAS access token
  or the SAI self-issued `at+jwt`), not an ID token.
- The UAS issues one ID-JAG per resource authorization server. Storage
  exchanges accept only ID-JAG subject tokens
  ([`IdJagSubjectTokenVerifier.ts`](../../packages/components/src/IdJagSubjectTokenVerifier.ts)).
- The storage trades the ID-JAG for a **bearer** access token whose only `aud`
  is the storage. The registry storage is ID-JAG-only and **claimless**: ACP
  authorizes registry resources, so no access claim is required or copied
  (`config/identity/id-jag-accept-registry.json`).
- The final access token is self-contained for storage authorization; there is
  no runtime grant matching on data storages.

## 4. Claim-first policy evaluation

`SaiPermissionsEngine.getPermissions` checks credentials in this order
([`SaiPermissionsEngine.ts`](../../packages/components/src/SaiPermissionsEngine.ts)):

1. **A claim always wins over a scope.** An owner/admin presenting a narrower
   `access` claim gets exactly that claim.
2. `scope: owner` → all access modes; `scope: admin` → read-only.
3. No claim and no owner/admin scope → no permissions from the token.

The claim parser builds a grant graph from the token's `access` policies and
evaluates target/registration/instance containment, scope ranking, access-mode
coverage, and the Inherited parent chain. A token with an `access` claim never
falls back to registry matching; a malformed claim for another storage is
treated as no permissions.

Public grants are deliberately separate: `PublicPermissionReader` is the only
request-time grant lookup on a data storage, and it is read-only. A public read
works with no token or any valid token and never becomes a claim fallback
([`PublicPermissionReader.ts`](../../packages/components/src/PublicPermissionReader.ts)).

## 5. Token-carried storage authorization

At the storage exchange, `IdJagTokenHandler` decides what the ID-JAG permits and
`StorageExchangeAccessPolicy` mints a scope only for a claimless exchange
([`IdJagTokenHandler.ts`](../../packages/components/src/IdJagTokenHandler.ts),
[`StorageExchangeAccessPolicy.ts`](../../packages/components/src/StorageExchangeAccessPolicy.ts)):

| Input | Meaning |
|---|---|
| `access` claim | the claim engine applies target/scope/action; no identity matching and no registry fallback |
| `scope: owner` | all modes; minted only when `sub` is the storage owner **and** `client_id` is `sub`'s authorization agent |
| `scope: admin` | read-only; minted only for a `DataRegistry`-scoped `AdminGrant` and the same UAS binding |
| no claim, no scope | exchange returns `invalid_grant`; nothing is issued |
| public grant | independent of the token; no token or any valid token may read |

Registry storage exchanges are claimless by config. The old
`AdminPermissionReader` fast path was removed with C6; storage-owner access is
the exchange-minted `scope: owner`.

## 6. Read-only admin impersonation

An admin reading a peer's granted data does not use an org session (that would
be `scope: owner` at the org's storage) and does not use a document proxy. The
org's exchange is the decision point:

- authority = the org's `DataRegistry`-scoped `AdminGrant` + the admin's own UAS
  as client ([`AdminImpersonationAuthority.ts`](../../packages/components/src/AdminImpersonationAuthority.ts));
- the claim is derived from the **org's** grants and narrowed to `odrl:read`;
- the peer sees the **org** as subject (`sub`), so hidden actors never appear in
  the final token;
- org-own storages are rejected by impersonation because the storage exchange
  would mint `scope: owner` (all modes); org-own reads use the admin's own token
  with `scope: admin`;
- `/.sai/proxy-admin` and the `ProxyAdminHandler`/`peerFetch`/`peerProxy`
  document-proxy path are removed. `ctx.storageFetch` /
  `SessionManager.impersonationFetch` perform the read server-side.

## 7. Revocation timing

Revocation is **eventual** for token-carried authorization: the storage
exchange validates the claim at exchange time and never re-reads the owner's
grants per request, so a revocation is bounded by the ID-JAG and access-token
TTLs (≈5.5 minutes at the 300 s lifetime). Public reads remain request-time.
A `403` from a storage is a target/claim denial, not a revocation signal; a UAS
`invalid_grant` is the revocation signal that makes the client restart the
chain.

## 8. Configuration and tests

- Identity configs: `packages/components/config/identity/id-jag.json`
  (issuer), `id-jag-accept.json` (UAS accept), `id-jag-accept-data.json` and
  `id-jag-accept-registry.json` (storage accept; the registry one is claimless).
- Policy engine: `config/policy/engine.json` wires `SaiAuthorizationManager`,
  `SaiPermissionsEngine`, `StorageExchangeAccessPolicy`,
  `OwnerAccessClaimValidator`, and `PublicPermissionReader`.
- Packages: `packages/components/test/{id-jag,id-jag-subject-token-verifier,access-claim,grant-policy,policy-engine-claim,storage-exchange-access-policy,admin-impersonation}.test.ts`;
  `packages/lws-auth/test/{tokens,fetch,session,browser}.test.ts`;
  integration: `/test/lws-auth.test.ts`, `/test/impersonation.test.ts`,
  `/test/policy-engine.test.ts`, `/test/org-context.test.ts`.

Open design work is tracked as issues #116 (admin audit record), #117
(notification claim/scope test), #118 (public-reader cache), and #119
(`/sparql-admin` transport decision).

## 9. Related pages

- [LWS auth client and tracing](lws-auth.md) — the client package and spans.
- [Organization admin model](org-admin.md) — the admin marking and contexts.
- [Org-context data plane](../services/org-context.md) — the SPARQL admin plane.
- [Data model entities](../data-model/entities.md) — the grant/authorization
  structures.
