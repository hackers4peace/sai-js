---
type: architecture
title: LWS auth client and tracing
description: The packages/lws-auth client for the LWS token chains — the self-issued credential, the identity-only `.sai` ID-JAG fetch, per-RAS ID-JAG caching and per-storage access tokens for the storage chain, retry behavior, the browser session, and the sai.lws tracing contract.
tags: [lws, oauth, token-exchange, id-jag, tracing, browser, sai]
sources:
  - id: openwiki-source-dc0056d569331f0bd8143f65
    resource: repo://packages/components/src/builders/sessionManager.ts
  - id: openwiki-source-9e48de6d257af7bddeefbf7f
    resource: repo://packages/components/src/tracing/http-capture.cjs
  - id: openwiki-source-03d6c784ce18f515fdbcf364
    resource: repo://packages/lws-auth/src/credential.ts
  - id: openwiki-source-efe1f254f3d0645000dccc22
    resource: repo://packages/lws-auth/src/fetch.ts
  - id: openwiki-source-20fab4f5c9ab14dbd2f69cdd
    resource: repo://packages/lws-auth/src/session.ts
  - id: openwiki-source-e4d066b2ebcf6881274f4339
    resource: repo://packages/utils/src/tracing/tokens.ts
  - id: openwiki-source-7e249979ad0878a1984165d7
    resource: repo://scripts/trace-test.sh
generated: { by: "pi", at: "2026-11-19T23:03:01.178Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T23:03:01.178Z
---

# LWS auth client and tracing

The protocol design (ODRL claims, storage binding, token-carried authorization)
is in [ID-JAG access claims and impersonation](id-jag-access-claims.md). This
page covers the client package that performs the chain and the trace surface
that makes it observable.

## 1. `packages/lws-auth`

| Module | Responsibility |
|---|---|
| `credential.ts` | `LwsCredential`: the DPoP-bound access token (or ID-JAG at an impersonation hop) presented to the first hop; `createSelfIssuedCredential` mints a local `at+jwt` with `cnf.jkt` |
| `tokens.ts` | `requestIdJag`, `requestAccessToken`; `sai.lws.*` spans |
| `jwt.ts` | local `exp` decoding for cache decisions |
| `fetch.ts` | `createLwsAuthFetch` (discovery → ID-JAG → storage token → request) and `createIdJagFetch` (`.sai` ID-JAG → Bearer request) |
| `dpop.ts` | key generation and DPoP proofs |
| `session.ts`, `browser.ts`, `store.ts` | browser login, persisted session, DPoP-bound requests |

`createLwsAuthFetch` performs the **two-step** chain
([`fetch.ts`](../../packages/lws-auth/src/fetch.ts)):

1. `POST <uas>/.well-known/lws/token` with the user's DPoP-bound access token
   (or an incoming ID-JAG at an impersonation hop) and a DPoP proof → one ID-JAG
   per resource authorization server.
2. `POST <storage>/.well-known/lws/token` with the ID-JAG → a **bearer** access
   token for that storage (no DPoP proof on this leg).
3. the storage request, retried once on `401`.

The UAS derives the access claim from the user's grants for the requested
storage, so the ID-JAG cache is keyed by `(issuer, storage, impersonation UAS)`
and renewed 30 s before expiry; access tokens are cached per storage by the
underlying `createLwsFetch`. A `401` from the storage refreshes the token and
retries once; a storage `invalid_grant` means "no token" and the client retries
tokenless once for public data (`fetch.ts`).

`buildLwsFetch(webid, clientId)` wires the client with the self-issued
DPoP-bound credential; ID-JAG is always on now, and the old `{ idJag: true }`
flag / single-exchange default are gone
([`builders/sessionManager.ts`](../../packages/components/src/builders/sessionManager.ts)).
The ID-JAG never leaves the client toward a storage; only the storage access
token does. Discovery helpers (`parseLwsChallenge`,
`discoverLwsAuthorizationServer`, `createLwsFetch`) stay in
`packages/utils/src/lws-auth.ts` to avoid a package cycle.

### `.sai` grants: `createIdJagFetch`

`createIdJagFetch` is the second fetch factory in the package
([`fetch.ts`](../../packages/lws-auth/src/fetch.ts)). It authenticates `.sai`
requests with an **ID-JAG** instead of the DPoP-bound credential:

- the audience is a string or a `(requestUrl) => audience` resolver; the
  components layer passes `saiAudience`, which returns the target UAS origin for
  `/.sai/agents/*` and the full request URL otherwise
  ([`util/url.ts`](../../packages/components/src/util/url.ts));
- one grant is minted per resolved audience via `requestIdJag` at the
  credential's own UAS, with **no `resource` and no ODRL `access` claim** — it is
  identity-only;
- the request carries `Authorization: Bearer <id-jag>`; the DPoP credential is
  only sent in the token exchange;
- grants are cached per audience until 30 s before `exp`, concurrent mints are
  de-duplicated, and a `401` discards the cached grant, mints a fresh one, and
  retries the request **once** with the cloned body.

The credential side is `createSelfIssuedCredential`
([`credential.ts`](../../packages/lws-auth/src/credential.ts)): it mints a
short-lived `at+jwt` with `iss`/`sub`/`client_id`/`aud`/`cnf.jkt`/`jti`, caches
the DPoP thumbprint, and delegates signing to the caller so the package stays
free of server key management. `components` supplies the signer
(`createSelfIssuedCredentialWithJwk`) and composes the credential into
`SaiSession`; see
[SAI endpoint authentication](sai-endpoint-authentication.md).

## 2. Browser session

`createBrowserSession` implements redirect login for the browser
([`session.ts`](../../packages/lws-auth/src/session.ts),
[`browser.ts`](../../packages/lws-auth/src/browser.ts)):

- it builds the authorization URL with PKCE and, by default, a DPoP key pair
  (`dpop_jkt`);
- it exchanges the code at the provider token endpoint, persists the session
  (IndexedDB store), and refreshes the access token with a renewal margin;
- `fetch` attaches the session access token and a DPoP proof when enabled, and
  retries once after refresh on `401`.

The credential presented to the UAS is the **session access token**, not an ID
token: it is what the app exchanges for ID-JAGs, and `.sai` endpoints themselves
accept only the resulting ID-JAG (or a storage access token, not the session
token). `LwsTokenHandler` (`/.sai/lws-token`) and `IdTokenHandler`
(`/.sai/id-token`) are retired and must not be reintroduced. The vuejectron
example uses `createBrowserSession` and the same fetch for its storage calls.

## 3. Tracing

The client and both server roles emit one trace per chain:

```text
sai.lws.request-id-jag        (client)
sai.lws.issue-id-jag          (UAS/auth)
sai.lws.exchange-access-token (client)
sai.lws.verify-id-jag         (storage)
```

Every span carries `sai.token.<subject|id_jag|access>.*` (typ, iss, aud, sub,
client_id, exp, jti, cnf_jkt, sha256, bytes). Decoded claims, raw JWT strings,
and HTTP bodies are opt-in:

- `OTEL_CAPTURE_TOKENS=true` — decoded header/claims;
- `OTEL_CAPTURE_RAW_TOKENS=true` — raw JWT strings (local debugging only);
- `OTEL_CAPTURE_BODIES=true` — request/response bodies (64 KiB cap, tokens
  redacted). Long-lived stream formats (`application/x-ndjson`, `text/event-stream`)
  are never captured: buffering their body stalls the client fetch until the
  stream ends.

The helpers live in `packages/utils/src/tracing/tokens.ts` and
`packages/components/src/tracing/http-capture.cjs`; `preload.cjs` installs the
capture hooks and publishes the SDK provider for ESM code loaded inside CSS.
The per-slice continuity gate is `scripts/trace-test.sh`, which runs the
`docs/lws-auth.c4` diagram flow through Dagger with Tempo tracing on.

## 4. Retry and failure behavior

- Storage `401` / `invalid_token` → refresh the access token and retry once.
- Storage `403` → a target/claim denial, not a revocation signal; do not restart
  the chain.
- UAS `400` / `invalid_grant` at an exchange → invalidate from that hop and
  re-mint; a denial at a UAS is the revocation signal.
- Storage `invalid_grant` on exchange → no token is issued; retry tokenless once
  (public data).
- `HttpStatusError` carries the status for callers that classify failures (e.g.
  the mirror sync treats `404`/`410` on a peer registration as terminal).

## 5. Tests

- `packages/lws-auth/test/tokens.test.ts` — ID-JAG/access-token request shape,
  cache keys, re-mint near expiry.
- `packages/lws-auth/test/credential.test.ts` — self-issued token claims, the
  default issuer audience, an explicit audience, and thumbprint reuse.
- `packages/lws-auth/test/fetch.test.ts` — for `createLwsAuthFetch`: per-RAS
  grant reuse, per-storage access token, 401 retry, ID-JAG never sent to a
  storage; for `createIdJagFetch`: one identity-only grant per resolved audience,
  per-audience caching until expiry, a single 401 re-mint/retry, and separate
  token/request fetches.
- `packages/lws-auth/test/session.test.ts` and `browser.test.ts` — redirect
  flow, PKCE, DPoP, refresh, persistence.
- `packages/utils/test/tracing-tokens.test.ts` and
  `packages/components/test/http-capture.test.ts` — token/body capture,
  redaction, and the NDJSON/event-stream exclusion.
- `/test/lws-auth.test.ts` — the two-storage chain and trace assertions;
  `scripts/trace-test.sh` — the continuity gate.

Open design question: whether the package should also expose a reactive
`TokenProvider` (`matches`/`upgrade`) shape for non-SAI apps, or stay a plain
fetch factory (issue #126).

## 6. Related pages

- [ID-JAG access claims and impersonation](id-jag-access-claims.md) — the
  protocol model.
- [Architecture overview](overview.md) — package topology.
- [Integration testing](../testing/integration-tests.md) — the Dagger suite.
