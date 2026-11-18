# LWS auth — ID-JAG exchange, `packages/lws-auth`, token-aware tracing

> **Status:** 🔶 open — **C1–C5 landed** (2026-11-13), **D15 landed** (2026-11-16), and the manual dev capture is done (2026-11-14, see C5). **Remaining to close the plan: the OpenWiki migration** (CONVENTIONS §1 — a done plan is removed and its design documented in [`openwiki/`](../../openwiki/)); nothing in C1–C5 is outstanding.
> **Superseded in part (2026-11-16/18):** the storage credential model moved on in [`id-jag.md`](id-jag.md) C6/C7 — storages accept **only ID-JAG** (no `…:id_token` anywhere), the first-hop credential is a DPoP-bound **access token** with `aud` = the user's UAS (no `solid`), the final access token is **bearer** with the storage as its only `aud`, and storage authorization is token-carried (claim / `scope` / public). C2's "storages keep `id_token`" framing and the `aud: "solid"` credential below are **historical**.
> **Last verified:** working tree (2026-11-18) — package gate (`typecheck`, `check`, `vitest` 690 / 26 skipped / 2 todo) and the full Dagger `/test` (24 files / 198 tests) green on CSS `ed9224991` (`lws-sai`). The C1–C5 slices themselves were verified on `99c208447` (2026-11-13).
> **Green gate:** **after every slice** — package gates (TypeScript-direct) + the single diagram trace test (`scripts/trace-test.sh`, see *Green gates*). The full `/test` suite runs once, at the end of C5 (>10 min).
> **Workstream:** follow-up to the closed LWS alignment phases ([`lws-followup.md`](lws-followup.md)); the modelled design is [`../lws-auth.c4`](../lws-auth.c4) and [`../../../lws-auth/oidc.c4`](../../../lws-auth/oidc.c4).

Goal: move from "one exchange, storage is its own AS, DPoP on the subject token" to
"ID token → **ID-JAG** (per resource authorization server) → access token", with
DPoP only on the first leg, and make the whole chain readable from Tempo.

## Context — what is landed today

- Each storage is its own LWS authorization server (`css:config/identity/lws/default.json`,
  `issuer` = base URL; `data`/`registry` import it, `auth` does not).
- *Historical (C6 replaced it):* one exchange:
  `POST <storage>/.well-known/lws/token` with
  `subject_token_type=…:id_token`, `resource=<storage>`; CSS verifies the subject token,
  optionally DPoP-bound (`OidcSubjectTokenVerifier.verifyRestriction`), and issues an
  RFC 9068 `at+jwt` (`LwsAccessTokenIssuer`, 300 s). Today the storage exchange is
  ID-JAG only and the issued token is a bearer token whose only `aud` is the storage.
- The credential the suite presents is a **self-issued `at+jwt`** (`SelfIssuedSession`):
  `iss: https://auth/`, `aud: "solid"` *(historical — since C6/D33 the LWS first-hop
  `at+jwt` carries the UAS as its only `aud`; `solid` remains only on the `.sai`
  session token)*, `azp`, `cnf.jkt` — signed with
  `CSS_ENCODED_PRIVATE_JWK` via `EnvJwkGenerator` (`packages/components/config/overrides/jwks.json`).
- Client discovery/caching/retry: `packages/utils/src/lws-auth.ts`
  (`parseLwsChallenge`, `discoverLwsAuthorizationServer`, `createLwsFetch`, with a
  `tokenSource` hook that already accepts a custom exchange).
- Tracing: `preload.cjs` / `initNodeTracing` emit HTTP client+server spans with
  **headers only** (`OTEL_CAPTURE_HEADERS=true`); `sai.jsonld.*` / `sai.rpc.*` attach
  whole documents as span attributes; Tempo `max_attribute_bytes` is 1 GiB.

Absent: ID-JAG issuance, an `id-jag` subject-token type, browser credential flow, and
any token decoding in traces.

## State map

| Capability / primitive | Status | Code anchors | Verified by | Notes |
|---|---|---|---|---|
| Storage-as-AS token exchange (RFC 8693) | ✅ landed | `CommunitySolidServer/src/identity/lws/LwsTokenHttpHandler.ts:122-153`; `src/identity/lws/LwsAccessTokenIssuer.ts:64-78` | `/test` `policy-engine.test.ts` + Tempo trace `1851eea1…` | one exchange, `aud` = storage |
| Subject-token DPoP binding | ✅ landed | `src/identity/lws/OidcSubjectTokenVerifier.ts`; `src/identity/lws/DpopUtil.ts` | `/test` (self-issued token carries `cnf.jkt`) | since C6 both `requireRestrictedTokens` and `requireSenderConstrained` are `true` at the UAS |
| Access-token audience enforcement | ✅ landed | `src/authentication/LwsAccessTokenExtractor.ts:130-145` | `/test` | exactly one `aud` == storage |
| Client exchange seam | ✅ landed | `packages/utils/src/lws-auth.ts` (`LwsFetchOptions.tokenSource`) | package tests (`packages/utils/test/lws-auth.test.ts`) | ID-JAG drops in here |
| ID-JAG issuer + UAS token endpoint | ✅ landed | `packages/components/src/IdJagIssuer.ts`, `IdJagTokenHandler.ts`, `config/identity/id-jag.json` (imported by `config/auth.json`, routed in `config/http/handler/default.json`) | package `test/id-jag.test.ts` (6); `/test` `lws-auth.test.ts` (4, 2026-11-13) | composes CSS's `verifyDpopProof` + `OidcSubjectTokenVerifier`; `LwsTokenHttpHandler` itself cannot be reused (private `OAuthError`/`getParameter`/`writeJson`, `verifyStorage` is own-storages-only) |
| `id-jag` subject-token verifier (RAS) | ✅ landed | `packages/components/src/IdJagSubjectTokenVerifier.ts`; `config/identity/id-jag-accept.json` (verifier + `StatusWaterfallHandler` insert + metadata router); imported by `config/{data,registry}.json` | package `test/id-jag-subject-token-verifier.test.ts` (7); `/test` `lws-auth.test.ts` (8) + `policy-engine.test.ts` (67) | `extends OidcSubjectTokenVerifier`: reuses JWKS discovery, `trustedIssuers`, subject-document deref, `verifyRestriction` |
| `typ` pinning for ID-JAG | ✅ landed | `IdJagSubjectTokenVerifier.handle` (jose `decodeProtectedHeader`, before any claim is read) | package test (ID token / `at+jwt` rejected as a grant) | ID token and ID-JAG are signed by the **same** auth key |
| `packages/lws-auth` client | ✅ landed | `packages/lws-auth/src/{credential,tokens,fetch,jwt}.ts`; wired by `buildLwsFetch(webid, clientId, { idJag: true })` | package tests `tokens` (3) + `fetch` (5); `/test` `lws-auth.test.ts` (9) | `oauth4webapi` `genericTokenEndpointRequest` + `DPoP`/`None`; ID-JAG cached per RAS, access token per storage (in `createLwsFetch`) |
| Token attributes in spans | ✅ landed | `packages/utils/src/tracing/tokens.ts`; first caller `IdJagTokenHandler` | `packages/utils/test/tracing-tokens.test.ts` (4) | gated by `OTEL_CAPTURE_TOKENS`, raw JWT only with `OTEL_CAPTURE_RAW_TOKENS` |
| HTTP payload capture (bodies + parsed JWKS) | ✅ landed | `packages/components/src/tracing/http-capture.cjs` (fetch wrapper + `ServerResponse` patch), installed from `preload.cjs`/`bootstrap.ts`; `setBodyAttribute`/`setTokenAttributes` for our own spans | package `http-capture.test.ts` (5) + `tracing-tokens.test.ts` (7); `/test` traces `72728215…`, `48e23f27…` | opt-in `OTEL_CAPTURE_BODIES`, 64 KiB cap, JWTs redacted unless `OTEL_CAPTURE_RAW_TOKENS`, `sai.jwks.*` for key sets (D13) |
| `sai.lws.*` chain spans | ✅ landed | client: `packages/lws-auth/src/tokens.ts`; auth: `IdJagTokenHandler.ts`; storage: `IdJagSubjectTokenVerifier.ts` | `/test` trace `48e23f27…` (8 spans, two chains) | one chain per authorization server; every span carries `sai.token.*` for the token it handles |
| `sai.*` spans from ESM components inside CSS processes | ✅ landed | `packages/utils/src/tracing/shared.ts` (`sharedTracer`, `withSpan`); `preload.cjs` publishes the SDK provider via `Reflect.get(sdk, '_tracerProvider')` | traces `1748b560…` (`sai.lws.issue-id-jag` + token attrs), `fded626c…` (`sai.rpc.handle` → `sai-jsonld` → `sai-sparql`) | `preload.cjs` is CJS, CSS loads these packages as ESM: the API's global-provider lookup did not reach the SDK |
| Browser credential flow (vuejectron) | ✅ landed | `packages/lws-auth/src/{dpop,session,store,browser}.ts` (the credential is the session **access token**, D15); `examples/vuejectron/src/{session.ts,store/app.ts}` | package `browser.test.ts` (5) + `session.test.ts` (5); `/test` `lws-auth.test.ts` + `impersonation.test.ts`; `vite build` of both UIs | `LwsTokenHandler` (`/.sai/lws-token`) and `IdTokenHandler` (`/.sai/id-token`) both retired (D5/D15); inrupt session replaced by `createBrowserSession` (D14) |

## Slices

### C1 — `auth` mints ID-JAGs from DPoP-bound ID tokens — ✅ landed (2026-11-13)

**Done when:** `POST https://auth/.well-known/lws/token` with
`grant_type=…:token-exchange`, `requested_token_type=…:id-jag`,
`audience=https://data/`, `subject_token=<self-issued at+jwt>` and a `DPoP` proof
returns `{ issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", access_token, token_type: "N_A", expires_in }`,
where the ID-JAG has `typ: oauth-id-jag+jwt`, `iss: https://auth/`, `aud: https://data/`,
`sub` = WebID, `client_id` = `azp`, `jti`, ≤ 300 s. A sender-constrained token without
its proof is a 400 `invalid_request`; a malformed or wrong-`htu` proof is a 400
`invalid_dpop_proof`; an `audience` that is not a configured storage is `invalid_target`.

**Landed:**
- `packages/components/src/IdJagIssuer.ts` — `typ: oauth-id-jag+jwt`, `iss` = base URL,
  `aud` = the requested RAS, `client_id`, `jti`, 300 s; signs with
  `urn:solid-server:default:JwkGenerator` so the existing `/.oidc/jwks` publishes the key.
- `packages/components/src/IdJagTokenHandler.ts` — RFC 8693 request parsing, `DPoP` proof
  verification via CSS's `verifyDpopProof` (htu/htm pinned), audience allow-list
  (`storageOrigins`, host match), `sai.lws.issue-id-jag` span with `sai.token.*`.
- `packages/components/config/identity/id-jag.json` + `config/auth.json` import + the
  router entry in `config/http/handler/default.json`. The verifier is CSS's
  `OidcSubjectTokenVerifier` with `trustedIssuers: [baseUrl]` (no CID dereference),
  `additionalAudiences: ["solid"]`, `requireRestrictedTokens: false` — so the suite's
  self-issued `cnf`-bound token works unchanged.
- `buildSelfIssuedCredential` exported from `packages/components/src/builders/sessionManager.ts`
  (credential + DPoP key pair, used by the `/test` acceptance and by C3).
- Gates: package `test/id-jag.test.ts` 6/6, `/test` `lws-auth.test.ts` 4/4, continuity
  `scripts/trace-test.sh` 1 passed, `npm run typecheck`, both vitest projects, `npm run check`.

**Depends on:** nothing (reuses CSS).
**Green gate:** `npm run typecheck`, `npx vitest run --project @elfpavlik/sai-components`.
**Continuity:** `scripts/trace-test.sh` stays green — the endpoint is
additive and nothing calls it yet.
**`/test` acceptance:** `--testFile="lws-auth.test.ts"` (new) for the ID-JAG request, plus
the continuity test in the same run.
**Touchpoints:** `packages/components/src/IdJagIssuer.ts`,
`IdJagTokenHandler.ts`, `packages/components/config/auth.json` (router for
`.well-known/lws/token`), `packages/components/config/variables/*.json` (trusted RAS list),
`packages/utils/src/tracing/tokens.ts` (token attributes — first caller),
`scripts/trace-test.sh` (continuity gate, already in the repo),
`packages/components/package.json` (`componentsjs-generator` exposes the classes as `@type`).

**Notes:**
- Compose, don't fork: `verifyDpopProof(proof, 'POST', tokenEndpoint)` (exported
  `DpopUtil`) → `OidcSubjectTokenVerifier.handleSafe({ …, proofKeyThumbprint })` with
  `trustedIssuers: ['https://auth/']`, `additionalAudiences: ['solid']`,
  `acceptSolidOidcIssuer: false`. With `trustedIssuers` hit the CID dereference is
  skipped entirely, so **today's self-issued token works unchanged**.
- `audience` validation is a config allow-list (`CSS_DATA_ORIGIN`, `CSS_REG_ORIGIN`)
  plus, optionally, a discovery cross-check (`GET <audience>/.well-known/lws-configuration`
  must return `issuer === audience`). Without it a client can ask for an ID-JAG "for"
  any string.
- `IdJagIssuer` mirrors `LwsAccessTokenIssuer` (same `JwkGenerator`, so the existing
  `/.oidc/jwks` serves both) but sets `typ: oauth-id-jag+jwt` and `client_id`.

### C2 — storages accept `id-jag` and keep `id_token` — ✅ landed (2026-11-13) · *historical: C6 removed `id_token` at storages*

> *Everything in this slice is a record of what C2 required then. `id-jag.md` C6
> later removed the `id_token` fall-through: a storage AS now accepts only
> `…:id-jag`, and the UAS handler rejects `…:id_token` outright (D25/D30).*

**Done when:** `POST https://data/.well-known/lws/token` with
`subject_token_type=urn:ietf:params:oauth:token-type:id-jag` and a valid ID-JAG returns
an `at+jwt` with `aud: https://data/`; an ID-JAG with the wrong `typ`, `aud`, `iss` or a
stale `exp` is a 400 `invalid_request`; the existing `id_token` exchange still works
(`policy-engine.test.ts` unchanged); the AS metadata advertises `…:id-jag` in
`subject_token_types_supported`.

**Depends on:** C1 (something must mint the ID-JAG).
**Green gate:** package gate + a verifier unit test proving an `id_token` still reaches
`OidcSubjectTokenVerifier` after the waterfall change.
**Continuity:** `scripts/trace-test.sh` — its request is
`subject_token_type=…:id_token`, i.e. exactly the fall-through this slice must not break.
**`/test` acceptance:** `--testFile="policy-engine.test.ts lws-auth.test.ts"`.
**Touchpoints:** `packages/components/src/IdJagSubjectTokenVerifier.ts`,
`packages/components/config/data.json`, `config/registry.json` (prepend to
`urn:solid-server:default:SubjectTokenVerifier`, set
`subjectTokenTypes` on `LwsAuthorizationServerHandler`), `packages/utils/src/tracing/tokens.ts`.

**Landed:**
- `packages/components/src/IdJagSubjectTokenVerifier.ts` — pins `typ: oauth-id-jag+jwt`
  **before** reading any claim (RFC 8725 §3.11), requires `sub`/`iss`/`client_id`/`aud`/`jti`,
  verifies the signature via the issuer's JWKS (`getKeySet`), and enforces
  `aud` = this AS (`verifyJwtCredential({ audiences: [audience] })`).
- `packages/components/config/identity/id-jag-accept.json` — the verifier
  (`trustedIssuers: [baseUrl]`, so no dereference for this deployment's own UAS),
  a `StatusWaterfallHandler` insert at index `0` of `urn:solid-server:default:SubjectTokenVerifier`,
  and a metadata router inserted at index `0` of `urn:solid-server:default:LwsAuthorizationServerHandler`
  that advertises `…:id-jag` (replacing the metadata route instead of duplicating CSS's
  three-handler list).
- Imported by `config/data.json` and `config/registry.json`; nothing in
  `LwsTokenHttpHandler` changed — only the verifier and the advertised type.
- Gates: package `test/id-jag-subject-token-verifier.test.ts` 7/7 (incl. the waterfall-order
  test that an `id_token` still reaches the OIDC suite), `/test`
  `lws-auth.test.ts` 8/8 + `policy-engine.test.ts` 67/67 (75 together, 1m35s), continuity
  `scripts/trace-test.sh` green.

**Notes:**
- Subclass `OidcSubjectTokenVerifier`: keep `getKeySet` (protected), `verifySubjectDocument`
  (protected), `verifyRestriction`; override `canHandle` (accept `id-jag`) and `handle`
  (claims: `sub` is the WebID, `client_id` instead of `azp`, `aud` must equal the AS).
- **Two different URIs, do not conflate them** (cost a test cycle):
  the token request's `resource` is the **storage** that holds the resource
  (`https://data/alice-work/`, a pod), while the ID-JAG's `aud` — and therefore the
  `audience` parameter when *minting* it — is the **authorization server issuer**
  (`https://data/`, the server base URL). `LwsTokenHttpHandler` passes `issuer.issuer` to
  the verifier and `resource` to the access-token issuer, so the access token's `aud`
  ends up as the storage.
- **Pin `typ`.** `verifyJwtCredential` has no `typ` option, and ID token + ID-JAG are
  signed by the same key; verify with `jwtVerify({ typ: 'oauth-id-jag+jwt' })` (or add a
  one-line `typ` option upstream) and add a unit test that an ID token is rejected as an
  ID-JAG and vice versa.
- Second leg stays RFC 8693 `subject_token`/`subject_token_type` (LWS core style) rather
  than the draft's `grant_type=…:jwt-bearer&assertion=` — see D1. No change to
  `LwsTokenHttpHandler` beyond the verifier and the metadata string.

### C3 — `packages/lws-auth`: one ID-JAG per RAS, one access token per storage — ✅ landed (2026-11-13)

**Done when:** a test fetches a protected resource on `data` **and** on `registry` in one
run; the trace shows two distinct ID-JAGs (`aud` = each storage's AS) and two access
tokens; a second request to the same storage reuses its access token; an expired ID-JAG is
re-minted on the 401 path; nothing but the access token is ever sent to a storage.

**Depends on:** C1, C2.
**Green gate:** package gate for the new package.
**Continuity:** `scripts/trace-test.sh` unchanged — ID-JAG is opt-in
(`buildLwsFetch(webid, clientId, { idJag: true })`); the default stays the single old
exchange until C5 flips it.
**`/test` acceptance:** `--testFile="lws-auth.test.ts"` — one fetch on `data` and one on
`registry`, two ID-JAGs in the trace.
**Touchpoints:** new `packages/lws-auth/`; `packages/components/src/builders/sessionManager.ts`
(`buildLwsFetch(webid, clientId, { idJag: true })`); `test/lws-auth.test.ts`.

**Landed:**
- `packages/lws-auth/` (published as `@elfpavlik/lws-auth`, TypeScript-direct like the
  other packages): `credential.ts` (`LwsCredential`), `tokens.ts` (`requestIdJag`,
  `requestAccessToken`), `jwt.ts` (local `exp` decoding for the cache), `fetch.ts`
  (`createLwsAuthFetch`). `browser.ts` is left for C5.
- `createLwsAuthFetch` plugs into `createLwsFetch({ tokenSource })`: discovery →
  `idJag(ras.issuer)` → `requestAccessToken({ resource: storage })`. Grants are cached **by
  RAS issuer** (renewed 30 s before `exp`, single-flight per issuer); access tokens are
  cached per storage by `createLwsFetch`. The UAS token endpoint comes from LWS metadata
  when advertised, else `<iss>/.well-known/lws/token`.
- `buildLwsFetch(webid, clientId, { idJag: true })` in
  `packages/components/src/builders/sessionManager.ts`; `buildSelfIssuedCredential` now
  also returns `issuer`/`clientId`. The default stays the single exchange (D9).
- Gates: package tests 8/8 (`tokens` 3, `fetch` 5 — per-AS grant reuse, per-storage access
  token, re-mint near expiry, ID-JAG never sent to a storage), `/test` `lws-auth.test.ts`
  9/9, continuity `scripts/trace-test.sh` green. Trace evidence: the client trace of the
  two-storage test contains exactly two `POST https://auth/.well-known/lws/token` (client +
  server spans for `data` and `registry` `aud`s) and one token exchange each at `data` and
  `registry`.

**Notes:**
- **Deviation from the sketch above:** `parseLwsChallenge` / `discoverLwsAuthorizationServer`
  stay in `packages/utils/src/lws-auth.ts` — `createLwsFetch` lives there and the new
  package depends on it, so moving them would create a cycle (D11). `packages/lws-auth`
  imports them.
- Publish as `@elfpavlik/lws-auth`. Modules as landed: `credential.ts`, `tokens.ts`,
  `fetch.ts`, plus `browser.ts` in C5.
- `oauth4webapi@3.8.8` has **no** token-exchange helper: use
  `genericTokenEndpointRequest(as, client, clientAuth, grantType, params, { DPoP })` +
  `DPoP(client, keyPair)` + `PrivateKeyJwt(key)`; drop `jose`/`dpop` from the new package.
- Cache the ID-JAG **by RAS issuer**, not by storage (two storages may share an AS once
  `LwsAccessTokenExtractor.trustedIssuers` is used); cache the access token by storage,
  reusing the existing `CachedToken` logic.
- Plug into `createLwsFetch({ tokenSource })`; the ID-JAG never leaves the client toward
  the storage (D4).

### C4 — read the whole token chain from Tempo — ✅ landed (2026-11-13)

**Done when:** a single `/test` run produces one trace containing, in order,
`sai.lws.request-id-jag` (client) → `sai.lws.issue-id-jag` (auth) →
`sai.lws.exchange-access-token` (client) → `sai.lws.verify-id-jag` (storage), each with
the decoded header/claims of the token it handles, the form body it sent and the JSON
body it received; no raw token strings appear unless `OTEL_CAPTURE_RAW_TOKENS=true`;
`data` and `registry` need **no new wiring** for this (see notes).

**Depends on:** C1–C3 (spans land with their callers; this slice adds bodies + the fixture).
**Green gate:** package gate.
**Continuity:** `scripts/trace-test.sh` — behavior-neutral, and the trace now carries
`sai.token.*` for the old exchange too.
**`/test` acceptance:** `--testFile="lws-auth.test.ts"` for the four-span chain.
**Touchpoints:** `packages/utils/src/tracing/tokens.ts`,
`packages/components/src/tracing/{bootstrap.ts,preload.cjs}`,
`.dagger/src/index.ts` (`withTracing`), `tempo/tempo.yaml` (no change expected).

**Landed:**
- `sai.lws.request-id-jag` (client, `packages/lws-auth/src/tokens.ts`) — `grant_type`,
  `requested_token_type`, `subject_token_type`, `audience`, `client_auth_method`,
  `sai.token.subject.*`, `sai.token.id-jag.*`, request/response bodies.
- `sai.lws.issue-id-jag` (auth, `IdJagTokenHandler`) — request body, `dpop_proof`, subject and
  issued-token claims, response body.
- `sai.lws.exchange-access-token` (client) — `resource`, `subject_token_type=…:id-jag`,
  `sai.token.id-jag.*`, `sai.token.access.*`, request/response bodies.
- `sai.lws.verify-id-jag` (storage, `IdJagSubjectTokenVerifier`) — `audience`, the grant's
  claims, `subject_id`/`client_id` on success, `sai.lws.error` on rejection. No body: CSS's
  `LwsTokenHttpHandler` owns that parsing (the client's span carries the same form).
- Verified on trace `48e23f27…` (the two-storage `/test` run): **8 `sai.lws` spans in one
  trace** — the four-span chain twice (data, registry) — with redacted bodies
  (`subject_token=<jwt:Eyoqj2-8gyLM>`) and no raw JWT anywhere in a captured payload.
- Payload capture (D13): every HTTP exchange now carries `http.request.body` /
  `http.response.body` (64 KiB cap, tokens redacted), and JWKS documents carry
  `sai.jwks.url`/`.count`/`.keys` — observed in trace `72728215…` on
  `sai-uas GET /.oidc/jwks` (`sai.jwks.count = 1`, one `EC/P-256/ES256/sig` key).
- Gates: package `http-capture.test.ts` 5/5, `tracing-tokens.test.ts` 7/7, `/test`
  `lws-auth.test.ts` 9/9, continuity `scripts/trace-test.sh` green.
- Docs: `docs/lws-auth.c4` gained `lws-authorization-id-jag` (two-step chain, trace
  `48e23f27…`) and `lws-authorization` was rewritten from trace `72728215…`, including the
  captured bodies and the parsed JWKS.

**Notes — why `data`/`registry` need nothing extra:**

- Both already run the CSS preload (`--require=…/preload.cjs`) in `/test` and compose, so
  their server spans and headers are already captured (see the `sai-data SRV POST
  /.well-known/lws/token` span in trace `1851eea1…`).
- The semantic token attributes come from **our** classes: the RAS-side
  `sai.lws.verify-id-jag` lives in `IdJagSubjectTokenVerifier` (C2), the issuance span in
  `IdJagTokenHandler` (C1). No CSS config change is needed.
- What stays out of reach is CSS's own handler internals (`getParameter`, `verifyStorage`)
  — acceptable: the client span carries the request shape and the server span carries the
  status code.
- Generic body capture is the only thing that must touch the shared bootstrap: patch
  `IncomingMessage`/`ServerResponse` (server) and wrap `fetch` (client) to record
  `http.request.body` / `http.response.body` — **opt-in** via `OTEL_CAPTURE_BODIES=true`,
  only for `application/json`, `application/x-www-form-urlencoded`, `application/ld+json`,
  `text/turtle`, capped at 64 KiB, skipped for streamed/binary responses.
- Wire the new gates next to the existing header gate in `.dagger/src/index.ts`
  `withTracing()`: when `--tempo-endpoint` is set also set `OTEL_CAPTURE_TOKENS=true` and
  `OTEL_CAPTURE_BODIES=true` (the collector is ours); compose keeps them unset.

**Attribute contract** (tracer `sai-lws`, mirroring `sai.jsonld.*`):

| attribute | example |
|---|---|
| `sai.lws.grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `sai.lws.requested_token_type` / `.subject_token_type` | `…:id-jag` (the only accepted subject-token type since C6) |
| `sai.lws.audience` / `.resource` | `https://data/`, `https://data/alice-work/k3pqsb` |
| `sai.lws.client_auth_method` | `none` (D3) |
| `sai.token.<subject\|id_jag\|access>.typ` / `.iss` / `.aud` / `.sub` / `.client_id` / `.exp` / `.jti` / `.cnf_jkt` | flattened, queryable |
| `sai.token.<prefix>.header` / `.claims` | JSON of the decoded JWT (`span.isRecording()`-gated, like `sai.jsonld.framed`) |
| `sai.token.<prefix>.sha256` / `.bytes` | correlation without the credential |
| `sai.lws.request.body` / `.response.body` | protocol-layer bodies (always small) |

**Fixed while landing C1 (two defects, both silent):**

1. **The span ended before the work did.** `tracer.startActiveSpan(name, async (span) => …)`
   ends the span as soon as the callback returns its promise — every attribute set while
   awaiting (all `sai.*` payloads) was dropped and the exported span had no duration. This
   was latent in `packages/utils/src/jsonld.ts` (`frameDoc`, `fetchJsonLd`, `putJsonLd`)
   and `packages/components/src/ApiHandler.ts` (`sai.rpc.handle`), so `sai.jsonld.*` /
   `sai.rpc.*` never carried a payload. Replaced by `withSpan(tracerName, spanName, fn)`
   (`packages/utils/src/tracing/shared.ts`), which keeps the span **active** for the async
   body (child client spans still nest), ends it once in `finally`, and records errors.
2. **ESM components could not see the CJS SDK provider.** `preload.cjs` is CommonJS and
   CSS loads these packages as ESM; the `@opentelemetry/api` global-provider lookup inside
   `sai.lws.*` / `sai.rpc.*` tracers did not reach the provider the preload registered
   (the HTTP instrumentation spans, which receive the provider directly, were fine). The
   preload now publishes its own provider (`Reflect.get(sdk, '_tracerProvider')`, API
   lookup as fallback) on `globalThis[Symbol.for('sai.otel.tracerProvider')]` and the
   components ask for a tracer via `sharedTracer(name)`.

Verified after the fix: `sai.lws.issue-id-jag` carries the whole `sai.token.*` set
(`1748b560…`), and an RPC round-trip shows `sai.rpc.handle` (194 ms, `sai.rpc.request`)
containing `sai-jsonld/fetchJsonLd`+`frameDoc` (`sai.jsonld.raw`/`.framed`) and
`sai-sparql/sparql.query` (`fded626c…`).

**Hazards:**
- Raw JWTs are bearer credentials and the dev Tempo is unauthenticated: default to
  **decoded claims only**; `OTEL_CAPTURE_RAW_TOKENS` is a local-debug switch (D7).
- `SimpleSpanProcessor` is deliberate (tail spans would be lost); body capture must not
  add buffering that outlives the request.
- Tempo search defaults to a ~4 s window (`query_end_cutoff: 1s` +
  `search.query_backend_after: 5s` in `tempo/tempo.yaml`): query with explicit
  `start`/`end`, e.g. `curl "localhost:3200/api/search?start=$(date -d -10min +%s)&end=$(date +%s)"`.
- `/test` `--only` is re-shelled by npm: wrap the `-t` pattern in literal single quotes and
  do not use `>`/`(`/`)` in it, or vitest silently matches nothing (67 skipped, zero spans).

### C5 — vuejectron: real redirect, service-issued DPoP-bound ID token — ✅ landed (2026-11-13)

**Done when:** the UI logs in through `auth` (authorization code), receives a
**DPoP-bound** ID token for the browser's key, then fetches protected resources by
minting one ID-JAG per storage — with `LwsTokenHandler` (`/.sai/lws-token`) no longer
needed.

**Depends on:** C1–C4; D5.
**Green gate:** `cd ui/authorization && npx vite build` (no `vue-tsc`, see conventions);
`cd examples/vuejectron && npx vite build`.
**Continuity:** `scripts/trace-test.sh` before and after the final flip (the old exchange
stays supported by C2, so the flip is reversible).
**Final gate:** switch `buildLwsFetch` to ID-JAG by default, then run the **full** `/test`
suite once (`dagger call --tempo-endpoint=… test`) — the only >10 min run in the plan.
**Touchpoints:** `packages/lws-auth/src/browser.ts`, `examples/vuejectron/`,
`packages/components/src/LwsTokenHandler.ts` (retire or reduce to ID-token mint),
new `/.sai/id-token` handler + `config/auth.json`.

**Landed:**
- ~~`auth` serves `GET /.sai/id-token[?dpop_jkt=<thumbprint>][&client_id=<iri>]`~~ — **retired by D15**
  (2026-11-16). The browser credential is the session's own access token; the handler, the
  issuer, the route and `config/identity/id-jag.json`'s `IdTokenIssuer` block are gone.
- `packages/lws-auth/src/browser.ts`: `createBrowserCredential(session)` — the session access
  token as the `…:access_token` subject token, the session key as its `cnf.jkt` — and
  `createBrowserLwsFetch({ session })` (the two-step chain with that credential),
  on top of `dpop.ts` (RFC 7638 thumbprint, non-extractable key pair, RFC 9449 proofs),
  `session.ts` (authorization code + PKCE + DPoP session) and `store.ts` (IndexedDB).
- `examples/vuejectron/src/store/app.ts` uses `createBrowserLwsFetch` instead of the broker;
  `src/session.ts` runs the Solid-OIDC flow itself (`createBrowserSession`), so one
  non-extractable DPoP key pair signs the session's `.sai` requests and the ID-JAG exchange.
  **inrupt is gone** (`@inrupt/solid-client-authn-browser` removed). Vite
  build is clean (the tracing helpers are browser-safe: `sha256` resolves `node:crypto`
  lazily and `jwt.ts` decodes with `atob` when `Buffer` is absent).
- **`LwsTokenHandler` retired** — handler, route, `SessionManager.getLwsAccessToken`, its
  barrel export and the live test case are gone; nothing requests storage tokens from the
  server any more (D5).
- Gates: `browser.test.ts` 5/5, `session.test.ts` 5/5, `/test` `lws-auth.test.ts`,
  continuity green, `npx vite build` in `examples/vuejectron` and `ui/authorization`.
  (D15 later removed the mint and its `id-token.test.ts`.)
- **Browser tracing (2026-11-14):** `examples/vuejectron/src/tracing.ts` + the `tracing`
  block in `public/config.json` enable the Web SDK per deployment (`enabled`,
  `otlpBaseUrl`, `serviceName`, `propagateTo`, `captureBodies`, `captureTokens`);
  OTLP posts same-origin to `/otlp` (traefik → tempo, no CORS). The LWS client spans
  (`request-id-token`, `request-id-jag`, `exchange-access-token`) are the client roots
  and the W3C `traceparent` links them to the server spans in one trace (final run:
  `18ac9ab3…`, `33765932…`, `6035be86…`). With capture on, the client spans carry the
  request/response bodies (JWTs redacted) and the decoded `sai.token.*` claims,
  including the issued storage access token (`sai.token.access.*`).
  `StackContextManager` + an explicit span re-entry around the fetch, because ESNext
  `await` breaks zone.js context.
- **Manual dev capture (2026-11-14):** vuejectron login as `alice@acme.example` through
  `auth.docker` with the single-key session — credential mint 200 (proof jkt == `dpop_jkt`),
  one ID-JAG per storage AS, both storages 200 (Alice `alice-work`, ACME `acme-rnd`,
  reusing the same ID-JAG per AS); a reload restores the session from IndexedDB and
  mints with the **same** `dpop_jkt`.
- Remaining for the plan: only the **OpenWiki migration** (CONVENTIONS §1: a done plan
  is removed and its design documented there). The manual dev capture is the entry
  above (2026-11-14).

**Notes (C5, superseded by D15):** CSS's OP does **not** issue DPoP-bound ID tokens:
`IdentityProviderFactory.configureClaims` adds `webid`/`azp` only, and `oidc-provider`
puts `cnf.jkt` on **access tokens only** (`lib/models/formats/jwt.js:125-132`);
`lib/models/id_token.js` has no `cnf`/`jkt` support, and `dpop_jkt` binds the
authorization code + access token, not the ID token. C5 therefore added a mint endpoint;
D15 reached the same binding with the OP's own access token instead.

## Decision log

**D1 — Second leg uses LWS `token-exchange`, not the draft's `jwt-bearer`.**
*pinned, confirmed 2026-11-13.*
`draft-ietf-oauth-identity-assertion-authz-grant-01` §4.4 asks for
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<id-jag>`; LWS core and
our RAS speak RFC 8693. Implement `subject_token_type=…:id-jag` (zero changes to
`LwsTokenHttpHandler`); revisit if we need draft conformance or a conformance suite.

**D2 — Subject-token audience at the UAS: keep `aud: "solid"` + DPoP for C1.**
*pinned, confirmed 2026-11-13; end state reached by D15.*
Today's token works untouched (`additionalAudiences: ['solid']`). Tighten to
`aud = https://auth/` **and** `requireRestrictedTokens: true`. D15 did both for the
browser: the OP issues its access tokens with `aud` = its own identifier and the browser
presents them, while the self-issued suite credential keeps `aud: solid` (its `.sai/*`
role requires the Solid-OIDC audience) and stays accepted through `additionalAudiences`.

**D3 (status note, C5):** the browser path proves possession with the DPoP proof of the
credential's own key; no OAuth client authentication is added for the UI. Third-party clients
still need `client_assertion` before they rely on the endpoint.

**D3 (status note, D15):** `createBrowserSession` owns the Solid-OIDC session, so the same
non-extractable key pair produces the session token's `cnf.jkt` and the proof at the ID-JAG
exchange. There is no `dpop_jkt` parameter any more: the UAS takes the binding from the
proof and the token (RFC 9449 §10.1).

**D3 — No client authentication on the UAS exchange in C1.**
*pinned for C1 (confirmed 2026-11-13), open for C5.*
Matches CSS's `token_endpoint_auth_methods_supported: ["none"]`; the binding comes from
`cnf.jkt`. Before real clients rely on the endpoint, add `client_assertion`
(`PrivateKeyJwt`), per draft §7.1. Note that the test "self-issued" token is signed with a
shared key, so client auth in `/test` is a simulation, not a security property.

**D4 — The ID-JAG never goes to a storage.** *pinned, confirmed 2026-11-13.*
It is `aud`-restricted to a RAS;
sending it as a storage credential must fail (C2 test) and the client (C3) must never do
it. This is what makes the audience constraint meaningful.

**D5 — DPoP-bound ID tokens for the browser: SAI mint endpoint, not an `oidc-provider` fork.**
*superseded by D15.* `/.sai/id-token` reused the code we already trust for `LwsTokenHandler`
and kept one token shape across tests and the UI; it worked, but a second identity-plane
token endpoint was not worth a token the OP already issues.

**D15 — The browser's LWS credential is its session access token; `/.sai/id-token` is retired.**
*pinned, 2026-11-16.* The OP's JWT access token already carries everything the UAS needs —
`iss`, `webid`, `client_id`, `cnf.jkt` — and CSS now issues it with `aud` = its own
identifier (`iss`), so it is audience-restricted to the authorization server *and*
sender-constrained. The browser therefore presents it as a `…:access_token` subject token
instead of a minted ID token: one identity-plane endpoint (`/.oidc/token`) instead of two,
no `IdTokenIssuer`, no second way to obtain a credential, no `dpop_jkt` parameter.

Two server changes make it work: `IdentityProviderFactory` gained an `accessTokenAudience`
(default `solid`, `auth` sets its base URL) and `OidcSubjectTokenVerifier` accepts
`…:access_token`, taking the client from `client_id` (RFC 9068) instead of `azp`.
`requireRestrictedTokens` is now `true` at the UAS: an unbound token whose audience is not
the authorization server is refused.

Why it is not a downgrade from the mint: the token is `cnf`-bound to the session's
non-extractable key, and the browser already keeps a 24 h bearer refresh token in IndexedDB —
the thief who can read the access token can mint a new one anyway. The mint's 5-minute TTL was
buying less than it looked like. An *ID* token in the same role would have been worse than
either: unbound, 1 h, and exchangeable by whoever obtained it, since a regular ID token only
names its client.

**D6 — Cache keying.** *pinned.* ID-JAG per **RAS issuer**, access token per **storage**.

**D7 — Tracing privacy.** *pinned.* Decoded claims default on (with `--tempo-endpoint`),
raw JWTs off (`OTEL_CAPTURE_RAW_TOKENS`), bodies behind `OTEL_CAPTURE_BODIES` and
allowlisted by content type. Reason: the dev Tempo has no auth and access tokens are
bearer.

**D8 — No per-service instrumentation for `data`/`registry`.** *pinned.* They already run
the CSS preload; the LWS-specific spans live in our verifier/issuer classes. Only the
shared bootstrap gains body capture, which applies to every service for free.

**D9 — Every slice keeps the diagram trace test green; the suite flips last.** *pinned.*
`policy-engine.test.ts` › … › `can Read` (trace `1851eea1…`) must pass at the end of
C1–C5, so each slice is additive: C1 adds an unconsumed endpoint, C2 adds a verifier that
falls through for `id_token`, C3 adds an opt-in client mode, C4 only annotates spans.
The suite/POC switches to ID-JAG as the default at the end of C5, together with the one
full `/test` run. The old exchange stays supported (C2), so the flip is reversible.

**D12 — Bodies are captured at the protocol layer, not by patching HTTP.** **Superseded by:** D13.

**D12 (original text, kept for history).** *pinned.* The
plan sketched a generic body tap in `preload.cjs`/`bootstrap.ts`; that needs buffering every
request/response (including streamed and binary payloads from Fuseki/Garage) to duplicate
what the token spans already carry. Instead `setBodyAttribute` records the form/JSON payloads
on our own spans (client token legs + the auth endpoint), gated by `OTEL_CAPTURE_BODIES`,
capped at 64 KiB, with JWTs replaced by `<jwt:sha256-prefix>` unless
`OTEL_CAPTURE_RAW_TOKENS=true`. The storage-side request body stays out of reach (CSS parses
it); the client's `exchange-access-token` span holds the identical form.

**D13 — Generic HTTP payload capture, plus parsed JWKS.** *pinned.* Payloads are captured for
**every** HTTP exchange, not only the token spans: `packages/components/src/tracing/http-capture.cjs`
wraps `globalThis.fetch` (request body from `init.body`, response body from a clone) and patches
`ServerResponse` (served response bodies), both gated by `OTEL_CAPTURE_BODIES`, capped at 64 KiB,
with JWTs redacted as `<jwt:sha256-prefix>` unless `OTEL_CAPTURE_RAW_TOKENS=true`. Obfuscation
of a JWKS (`application/jwk-set+json`) additionally records `sai.jwks.url`, `sai.jwks.count` and
`sai.jwks.keys` (kty/crv/alg/kid/use only — public material), on both the serving and the
fetching side. Two limits are deliberate: (a) a JWKS fetched through **jose** bypasses the fetch
wrapper because jose captures `fetch` at import time, so the parsed set is recorded on the
**serving** span (`sai-uas GET /.oidc/jwks` in trace `72728215…`); (b) server-side **request**
bodies are not tapped — reading `IncomingMessage` in flowing mode would steal data from the
handler; the client span of the same request carries that payload. The semantic
`sai.lws.*.body` attributes stay on the token spans, where the payload is unambiguous.

**D11 — LWS discovery helpers stay in `packages/utils`.** *pinned.* The plan sketched
moving `parseLwsChallenge` / `discoverLwsAuthorizationServer` into `packages/lws-auth`, but
`createLwsFetch` lives in `packages/utils/src/lws-auth.ts` and the new package is built on
it — the move would be a cycle. `packages/lws-auth` imports them; no code is duplicated.

**D10 — No build step in the dev/test gates.** *pinned.* Six of eight packages resolve
from TypeScript (`main: ./src/index.ts`); `build` runs in `prepublishOnly` for npm.
`@elfpavlik/sai-components` is the exception (`main: dist/index.js`, and CSS loads
`dist/components/components.jsonld` through `lsd:components`), so registering a **new
component `@type`** (C1, C2) needs one `npm run build --workspace @elfpavlik/sai-components`
before a `/test` run — an artifact refresh, not a gate.

**D14 — One client key pair; DPoP is added per leg.** *pinned, 2026-11-14.*
The browser keeps a **single** non-extractable ECDSA P-256 key pair per session
(`createBrowserSession`, `packages/lws-auth/src/session.ts`): it signs the authorization-code
token request, the session's `.sai` requests and the ID-JAG exchange. `@inrupt/solid-client-authn-browser` is removed; the session is
the app's own (`oauth4webapi`), and the key is persisted as a `CryptoKey` in IndexedDB so a
redirect or reload reuses it.

Rollout is per token, on that one key: session access token → ID-JAG →
(open) storage access token. `createBrowserSession({ dpop: false })` keeps the session leg on
`Bearer` while everything downstream already proves the key. The ID-JAG leg needs no DPoP
today because its `aud` is the restriction (`requestAccessToken` sends no proof).

## Green gates

Two gates, both agent-runnable. The full `/test` suite runs **once**, at the end of C5.

### Per-slice gate

```bash
npm run typecheck
npx tsc -p packages/components/tsconfig.json --noEmit
npx vitest run --project @elfpavlik/sai-components
npx vitest run --project @janeirodigital/interop-utils
npx vitest run --project @elfpavlik/lws-auth        # from C3 on
```

### Per-slice continuity — the diagram trace test

`test/policy-engine.test.ts` › `protected resources (scope all, modes all)` ›
`protected resource` › `authenticated request (authorized agent / authorized client)` ›
`can Read` — the run that produced trace `1851eea1…` in
[`../lws-auth.c4`](../lws-auth.c4).

```bash
scripts/trace-test.sh        # in the repo, verified against trace 1851eea1…
```

The wrapper exists because of the two traps below; without it the command is:

```bash
devbox run -- bash -lc 'dagger call --tempo-endpoint=http://172.16.0.1:4318 test \
  --testFile="policy-engine.test.ts" \
  --only="'"'"'protected resources \(scope all, modes all\) > protected resource > authenticated request \(authorized agent / authorized client\) > can Read'"'"'"'
```

- **npm re-shells everything after `--`.** The vitest `-t` pattern must be wrapped in
  literal single quotes and `(`/`)` regex-escaped — otherwise `>` becomes a redirect and
  vitest reports "67 skipped" with zero spans.
- **Tempo's default search window is ~4 s** (`query_end_cutoff: 1s` +
  `search.query_backend_after: 5s` in `tempo/tempo.yaml`), so inspect with explicit
  `start`/`end`.
- **Fresh spans are not searchable immediately** (live store → block flush takes ~1 min) and
  `/api/search` caps its result set, so a "missing" span is often just unsurfaced: verify
  with TraceQL `{ name = "sai.lws.issue-id-jag" }` after a minute, or with
  `/api/traces/<traceId>` directly when the id is known.

### Final gate

At the end of C5 only: `dagger call --tempo-endpoint=http://172.16.0.1:4318 test` (full
suite, user-run). Package tests use mocked token endpoints and need no services; `/test`
is the only place the three-server exchange is exercised.

## Open questions

1. ~~Where does the "known RAS" list live for C1 — static config or the
   registry/pod-endpoint store?~~ **Answered:** static origins in
   `config/identity/id-jag.json` (`storageOrigins` `CSS_DATA_ORIGIN`/`CSS_REG_ORIGIN`,
   plus `authorizationServerOrigins`), and the per-pod SPARQL endpoint records drive
   everything else.
2. ~~Do we keep `LwsTokenHandler` (`/.sai/lws-token`) after C5?~~ **Answered in C5:** deleted
   together with the server-side storage-token exchange; the browser runs the chain itself.
   **D15** retired the replacement credential endpoint (`/.sai/id-token`) too: the session's
   access token is the credential, so `auth` mints no LWS tokens at all.
3. Should `packages/lws-auth` also expose the reactive-authentication `TokenProvider`
   shape (`matches`/`upgrade`) for reuse by non-SAI apps, or stay a plain fetch factory?
