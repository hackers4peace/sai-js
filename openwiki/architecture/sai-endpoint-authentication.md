---
type: architecture
title: SAI endpoint authentication
description: How `.sai` endpoints authenticate after the ID-JAG migration — the self-issued DPoP-bound access token mints an identity-only ID-JAG, `.sai` requests carry that grant as a Bearer token, audiences are route-specific and prefix-checked by the auth service, the extractor falls back to Public for anonymous discovery, and federated issuers are resolved through subject CID documents.
tags: [architecture, authentication, id-jag, dpop, sessions, sai, audience, cid]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T23:03:01.178Z
sources:
  - id: openwiki-source-f43abf593fa5899437adf71e
    resource: repo://packages/components/config/http/handler/default.json
  - id: openwiki-source-d6371e3a800240d46c2e1c59
    resource: repo://packages/components/config/identity/id-jag.json
  - id: openwiki-source-7ea752831793ac76b987c08d
    resource: repo://packages/components/config/ldp/authentication/id-jag.json
  - id: openwiki-source-cea21cc782b98e163af31c3f
    resource: repo://packages/components/src/IdJagCredentialsExtractor.ts
  - id: openwiki-source-95310ca3c4786b5a5c369581
    resource: repo://packages/components/src/IdJagSubjectTokenVerifier.ts
  - id: openwiki-source-a24c81b10d95a3487bf81305
    resource: repo://packages/components/src/SaiSelfIssuedAccessTokenVerifier.ts
  - id: openwiki-source-56e7dcd44fb9baa1be3d7400
    resource: repo://packages/components/src/SaiSession.ts
  - id: openwiki-source-ce3937bfbcfbea447784ab6a
    resource: repo://packages/components/src/SessionManager.ts
  - id: openwiki-source-e99eb27382804fe9039b03dc
    resource: repo://packages/components/src/util/selfIssuedCredential.ts
  - id: openwiki-source-a3ed434feeefa2b8b44177fa
    resource: repo://packages/components/src/util/url.ts
  - id: openwiki-source-ea587af8d26862f6d98de647
    resource: repo://packages/components/test/url.test.ts
  - id: openwiki-source-efe1f254f3d0645000dccc22
    resource: repo://packages/lws-auth/src/fetch.ts
generated: { by: "pi", at: "2026-11-19T23:03:01.178Z" }
---

# SAI endpoint authentication

`.sai/*` is a second authentication surface beside storage access. It no longer
accepts the DPoP-bound self-issued token directly. The chain is:

```text
agent's own UAS                        target UAS (`.sai` host)
  self-issued at+jwt (DPoP, aud=UAS)
        │  token exchange, one DPoP proof
        ▼
  ID-JAG (identity-only, aud = full .sai URL or target UAS base URL)
        │  Bearer
        ▼
  .sai request
```

The DPoP credential is presented only to its own UAS. `.sai` requests carry the
resulting grant as a plain Bearer token; DPoP stops at the first exchange. This
is what replaced `SelfIssuedSession` and `@uvdsl/solid-oidc-client-browser`.

## 1. The first-hop credential

`createSelfIssuedCredentialWithJwk`
([`util/selfIssuedCredential.ts`](../../packages/components/src/util/selfIssuedCredential.ts))
builds a credential over `createSelfIssuedCredential`
([`lws-auth/src/credential.ts`](../../packages/lws-auth/src/credential.ts)):

- `typ: at+jwt`, signed by the UAS `JwkGenerator` (the key published at
  `/.oidc/jwks`), `kid` = the JWK thumbprint;
- `iss` = the UAS base URL, `aud` = the UAS by default;
- `sub` = the agent's SAI/CID URI, `client_id`/`azp` = `agentId(webid)`
  (`<baseUrl>.sai/agents/<base64url(webid)>`), so the exchange names the local
  authorization agent as the client;
- `cnf.jkt` = the DPoP key thumbprint, `jti`, `iat`, `exp` (lifetime =
  `expiration` minutes × 60).

There is no `webid` claim and no `solid` audience. SAI does not use WebID or
Solid-OIDC for this path.

`SaiSelfIssuedAccessTokenVerifier`
([`SaiSelfIssuedAccessTokenVerifier.ts`](../../packages/components/src/SaiSelfIssuedAccessTokenVerifier.ts))
verifies that token at the UAS token endpoint:

| Check | Value |
|---|---|
| token type | `urn:ietf:params:oauth:token-type:access_token` |
| header | `typ: at+jwt`, `alg` not `none` |
| `sub`, `client_id` | HTTPS URIs |
| `iss` | exactly this UAS |
| `aud` | this UAS |
| sender constraint | `cnf.jkt` equals the DPoP proof's key thumbprint |
| `iat` | not in the future beyond the clock tolerance |
| signature | this UAS's `JwkGenerator` public key |
| required claims | `sub`, `iss`, `aud`, `client_id`, `cnf`, `jti`, `iat`, `exp` |

It deliberately does **no** OIDC discovery, subject-document fetch, or WebID
lookup: those belong to incoming ID-JAGs, not to a credential this UAS issued
itself. `config/identity/id-jag.json` wires it as
`urn:sai:default:IdTokenVerifier` and puts it after the incoming-ID-JAG verifier
in `urn:sai:default:IdJagSubjectTokenWaterfall`, so one token endpoint accepts
either an incoming ID-JAG (impersonation hop) or the local access token.

## 2. The `.sai` grant

`createIdJagFetch`
([`lws-auth/src/fetch.ts`](../../packages/lws-auth/src/fetch.ts)) turns the
credential into a `.sai` grant:

- the audience is resolved per request: `saiAudience`
  ([`util/url.ts`](../../packages/components/src/util/url.ts)) returns the
  **target UAS origin** for `/.sai/agents/*` and the **full request URL**
  otherwise;
- `requestIdJag` is called at the credential's own UAS with the credential's
  DPoP key; the resulting ID-JAG has **no `resource` and no `access` claim**;
- the request is sent with `Authorization: Bearer <id-jag>`;
- grants are cached per audience until 30 s before `exp`, concurrent mints are
  de-duplicated, and a `401` discards the cached grant, mints a fresh one, and
  retries once with a cloned body.

`SaiSession`
([`SaiSession.ts`](../../packages/components/src/SaiSession.ts)) composes the
credential with two fetches and exposes the compatibility surface
(`webid`, `clientId`, `issuer`, `dpopKeyPair`,
`generateSelfIssuedAccessToken`). Its `authFetch` routes a URL to the ID-JAG
fetch when it is any `.sai` URL (on this or another UAS) or same-origin with the
UAS base URL; everything else goes through the storage chain.

`SessionManager.getSession`
([`SessionManager.ts`](../../packages/components/src/SessionManager.ts)) builds
the same routing inline for the session it hands to
`AuthorizationAgent.build`: `.sai`/same-origin → `createIdJagFetch`, data and
registry storages → `createLwsAuthFetch`. The endpoint allowlist and the
required registry-pod endpoint are unchanged (see
[Per-pod storage and isolation](storage-isolation.md)).

### Audience table

| Request | ID-JAG `aud` | Accepted because |
|---|---|---|
| `/.sai/agents/<handle>` (discovery) | target UAS base URL | the audience is that UAS; discovery is a stable service called by a UAS, possibly from a Temporal workflow |
| `/.sai/access-requests/*`, `/grants/*`, `/invitations/*`, `/sparql-admin/*`, `/reciprocal-webhook/*` | full request URL, including query | one-time interaction; the auth verifier accepts any URL under its base URL |
| storage request | storage authorization-server issuer | exact match at the storage verifier |

Minting is separately constrained by `IdJagTokenHandler.verifyAudience`: a
storage/authorization-server base URL, this UAS, a `.sai` URL under this UAS, or
a `.sai` URL whose origin is in `authorizationServerOrigins` (configured peer
UASs). Any other `.sai` audience is an `invalid_target`.

## 3. Server-side acceptance

`config/ldp/authentication/id-jag.json` replaces CSS's `dpop-bearer.json` in the
auth server config ([`config/auth.json`](../../packages/components/config/auth.json)):

```json
{
  "@id": "urn:solid-server:default:CredentialsExtractor",
  "@type": "CachedHandler",
  "source": {
    "@type": "StatusWaterfallHandler",
    "handlers": [
      { "@type": "IdJagCredentialsExtractor",
        "verifier": { "@id": "urn:sai:default:AuthIdJagSubjectTokenVerifier" },
        "baseUrl": { "@id": "urn:solid-server:default:variable:baseUrl" } },
      { "@type": "PublicCredentialsExtractor" }
    ]
  }
}
```

`IdJagCredentialsExtractor`
([`IdJagCredentialsExtractor.ts`](../../packages/components/src/IdJagCredentialsExtractor.ts))
handles only `Authorization: Bearer …`; anything else is left to
`PublicCredentialsExtractor`, which keeps anonymous `/.sai/agents` discovery
working. On a Bearer token it calls the verifier with `audience = baseUrl` and
builds `Credentials`:

- `agent.webId` = `sub`
- `client.clientId` = `client_id`
- `issuer.url` = `iss`
- `access` / `accessContext` when the grant carries an ODRL claim (not for the
  identity-only `.sai` grant)

The verifier instance (`urn:sai:default:AuthIdJagSubjectTokenVerifier`) is an
`IdJagSubjectTokenVerifier` with `trustedIssuers = [baseUrl]`,
`audiencePrefix = baseUrl`, and `clockTolerance: 60`. Its checks, in order:

1. `typ` header is `oauth-id-jag+jwt` — an ID token or access token signed by
   the same UAS cannot be replayed as a grant;
2. `sub`, `iss`, `client_id` are present and HTTP(S) URIs;
3. accepted audiences: with `audiencePrefix`, **any** `aud` URL under the auth
   base URL (URL-aware origin + normalized path); without it, exactly `audience`;
4. issuer trust: `trustedIssuers` membership (trailing slashes normalized) skips
   the subject-document fetch; a federated issuer must be designated by the
   subject CID document;
5. signature against the issuer JWKS, required claims, clock tolerance;
6. if `access` is present, expand and validate the ODRL claim.

The prefix mode is a deliberate tradeoff: an ID-JAG minted for one auth `.sai`
URL can be presented at another auth `.sai` URL. Exact audiences are kept where
they matter — the storage verifiers. `isWithinBaseUrl` never uses raw
`startsWith`: `https://auth.evil/` must not match `https://auth/`.

### Route wiring

All routes below are under `/.sai/` on the auth server
([`config/http/handler/default.json`](../../packages/components/config/http/handler/default.json)):

| Route | Methods | Credentials |
|---|---|---|
| `/.sai/agents/*` | GET, HEAD | default extractor (ID-JAG), Public fallback |
| `/.sai/sparql-admin/*` | QUERY | default extractor |
| `/.sai/invitations/*` | POST | default extractor |
| `/.sai/access-requests/*` | POST, GET, HEAD | default extractor |
| `/.sai/grants/*` | any | default extractor |
| `/.sai/reciprocal-webhook/*` | POST | none verified — `sendTo` is the capability URL (the handler keeps the extractor for a future sender check) |
| `/.sai/activity-webhook/*` | POST | none — capability URL |
| `/.sai/api` | POST | account cookie (`cookieStore` + `webIdStore`) |
| `/.sai/events` | GET | account cookie |

`.sai/agents` being the only public route is intentional: applications must not
obtain an ID-JAG for discovery directly; the request belongs to a UAS.

## 4. Federated issuers

A `.sai` host may accept an ID-JAG issued by another UAS. The trigger is `iss`
membership in `trustedIssuers`, **not** `aud !== iss`: a local `.sai`
interaction URL already has `iss !== aud` and must skip the CID fetch. For a
federated issuer the verifier dereferences `sub`, requires the document `id` to
equal `sub`, and requires an `lws:OpenIdProvider` service whose endpoint equals
`iss` before using the issuer's discovered JWKS. `CidIssuerResolver`
([`CidIssuerResolver.ts`](../../packages/components/src/CidIssuerResolver.ts))
implements that path for both compact `application/cid`/JSON and RDF documents,
with no `solid:oidcIssuer` fallback; the full contract is in
[Federation constraints](federation.md#federated-id-jag-issuer-resolution).

## 5. Invariants and failure behavior

- DPoP exists only for the token exchange that mints an ID-JAG; no `.sai` route
  receives a DPoP proof, and `dpop-bearer.json` is no longer imported.
- The `.sai` ID-JAG is identity-only. Authorization on `.sai` routes comes from
  the route handler and the agent/registry data, not from a carried ODRL claim.
- `.sai` grants are audience-constrained, not sender-constrained: the audience
  and a short lifetime bound replay. A `401` re-mints instead of reusing.
- Anonymous requests fall back to `PublicCredentialsExtractor`; if it cannot
  handle them the request is unauthenticated, which is how public discovery
  still works.
- A wrong `typ`, unknown issuer, wrong audience, missing `cnf.jkt`, or a
  mismatched proof is a `400`-class rejection of the token, not a retry.
- No WebID, Solid-OIDC, or LWS CID self-issued credential suite is accepted on
  the first hop. Only an incoming ID-JAG may be federated, and only through its
  subject CID document.

## 6. Tests

- `packages/components/test/id-jag-credentials-extractor.test.ts` — Bearer-only
  handling, credential mapping, Public fallback (including a non-Bearer scheme).
- `packages/components/test/sai-self-issued-access-token-verifier.test.ts` —
  `typ`/`alg`, HTTPS `sub`/`client_id`, issuer, `cnf.jkt`, future `iat`, bad
  signature, required claims.
- `packages/components/test/cid-issuer-resolver.test.ts` — compact CID/JSON and
  RDF documents, `id === sub`, `lws:OpenIdProvider` endpoint matching, JWKS
  discovery/fallback, fail-closed cases.
- `packages/components/test/url.test.ts` — `saiAudience`, `isWithinBaseUrl`
  (lookalike origins and sibling paths), `isSaiUrl`.
- `packages/components/test/id-jag.test.ts` — minting audiences: this UAS,
  `.sai` URLs under it, configured peer UASs, rejected lookalikes/peers.
- `packages/lws-auth/test/{credential,fetch}.test.ts` — the self-issued claims
  and the `createIdJagFetch` cache/401 behavior.
- `/test/lws-auth.test.ts` and `/test/impersonation.test.ts` — the real chain
  against the compose/Dagger cluster.

## 7. Related pages

- [ID-JAG access claims and impersonation](id-jag-access-claims.md) — the grant
  model and storage exchange.
- [LWS auth client and tracing](lws-auth.md) — the client package.
- [Federation constraints](federation.md) — cross-server issuer trust.
- [Per-pod storage and isolation](storage-isolation.md) — session allowlists.
- [Auxiliary services](../integrations/auxiliary-services.md) — config wiring
  and the CID service.
- [Integration test suite](../testing/integration-tests.md) — how to run the
  suite.
