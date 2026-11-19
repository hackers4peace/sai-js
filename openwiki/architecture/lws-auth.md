---
type: architecture
title: LWS auth client and tracing
description: The packages/lws-auth client for the two-step LWS token chain — per-RAS ID-JAG caching, per-storage access tokens, retry behavior, the browser session, and the sai.lws tracing contract.
tags: [lws, oauth, token-exchange, id-jag, tracing, browser]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-19T00:32:33.147Z
sources:
  - id: openwiki-source-dc0056d569331f0bd8143f65
    resource: repo://packages/components/src/builders/sessionManager.ts
  - id: openwiki-source-9e48de6d257af7bddeefbf7f
    resource: repo://packages/components/src/tracing/http-capture.cjs
  - id: openwiki-source-efe1f254f3d0645000dccc22
    resource: repo://packages/lws-auth/src/fetch.ts
  - id: openwiki-source-20fab4f5c9ab14dbd2f69cdd
    resource: repo://packages/lws-auth/src/session.ts
  - id: openwiki-source-e4d066b2ebcf6881274f4339
    resource: repo://packages/utils/src/tracing/tokens.ts
  - id: openwiki-source-7e249979ad0878a1984165d7
    resource: repo://scripts/trace-test.sh
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
---

# LWS auth client and tracing

The protocol design (ODRL claims, storage binding, token-carried authorization)
is in [ID-JAG access claims and impersonation](id-jag-access-claims.md). This
page covers the client package that performs the chain and the trace surface
that makes it observable.

## 1. `packages/lws-auth`

| Module | Responsibility |
|---|---|
| `credential.ts` | `LwsCredential`: the DPoP-bound access token (or ID-JAG at an impersonation hop) presented to the first hop |
| `tokens.ts` | `requestIdJag`, `requestAccessToken`; `sai.lws.*` spans |
| `jwt.ts` | local `exp` decoding for cache decisions |
| `fetch.ts` | `createLwsAuthFetch`: discovery → ID-JAG → storage token → request |
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

The credential presented to the SAI API is the **session access token**, not an
ID token: `LwsTokenHandler` (`/.sai/lws-token`) and `IdTokenHandler`
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
  redacted).

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
- `packages/lws-auth/test/fetch.test.ts` — per-RAS grant reuse, per-storage
  access token, 401 retry, ID-JAG never sent to a storage.
- `packages/lws-auth/test/session.test.ts` and `browser.test.ts` — redirect
  flow, PKCE, DPoP, refresh, persistence.
- `packages/utils/test/tracing-tokens.test.ts` and
  `packages/components/test/http-capture.test.ts` — token/body capture and
  redaction.
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
