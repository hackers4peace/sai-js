# Plan: ID-JAG for `.sai` and removal of `SelfIssuedSession`

## Goal

Make every `.sai/*` endpoint authenticate with an **ID-JAG**, and use the DPoP-bound SAI access token only for the first ID-JAG exchange.

Concretely:

- `.sai/*` requests carry `Authorization: Bearer <id-jag>`
- the ID-JAG audience is route-specific:
  - one-time interaction routes: the **full request URL**
  - `AgentIdHandler` (`/.sai/agents/*`): the **target UAS base URL**, because discovery is a stable service called by a UAS, possibly from a Temporal workflow
- support **LWS CID document** resolution for ID-JAGs that cross security domains (`iss != aud`)
- do **not** add WebID or Solid-OIDC support to the SAI path
- do **not** add the LWS CID self-issued credential suite to the first hop
- replace `SelfIssuedSession` and `@uvdsl/solid-oidc-client-browser` with `packages/lws-auth` primitives
- remove SAI's use of `@solid/access-token-verifier` / `dpop-bearer.json`

The target chain:

```text
self-issued SAI access token (DPoP, aud = agent's UAS)
        │
        ▼
ID-JAG
  aud = full .sai interaction URL
  aud = target UAS base URL for /.sai/agents/*
        │
        ▼
.sai request (Bearer ID-JAG)

self-issued SAI access token (DPoP, aud = agent's UAS)
        │
        ▼
ID-JAG (aud = storage AS)
        │
        ▼
storage access token (Bearer)
```

When `iss != aud`, the accepting UAS dereferences the subject's CID document to find the `lws:OpenIdProvider` service and verifies the ID-JAG with that issuer's key.

## Current state

### `.sai` routes using the default credentials extractor

`packages/components/config/http/handler/default.json` wires `urn:solid-server:default:CredentialsExtractor` into:

| Route | Handler | Minted ID-JAG audience |
|---|---|---|
| `/.sai/agents/*` | `AgentIdHandler` | target UAS base URL |
| `/.sai/sparql-admin/*` | `AdminSparqlHandler` | full request URL |
| `/.sai/invitations/*` | `InvitationHandler` | full request URL |
| `/.sai/access-requests/*` | `AccessRequestHandler` | full request URL |
| `/.sai/grants/*` | `AccessGrantHandler` | full request URL |
| `/.sai/reciprocal-webhook/*` | `ReciprocalWebhookHandler` | full request URL |
| `/.sai/api` | `ApiHandler` | account cookie, not the default extractor |
| `/.sai/events` | `EventsHandler` | account cookie, not the default extractor |
| `/.sai/activity-webhook/*` | `ActivityWebhookHandler` | no extractor |
| `/.well-known/lws/token` | `IdJagTokenHandler` | uses `IdJagSubjectTokenWaterfall`, not the default extractor |

`AgentIdHandler` is different: an application may trigger agent registration discovery, but the request must be made by someone's UAS, possibly from a Temporal workflow. Therefore the ID-JAG audience is the target UAS base URL, not the exact discovery URL.

The auth service verifier does not need to compare against the exact request URL. It accepts any `aud` URL under its configured `baseUrl` prefix. Clients still mint the full request URL for one-time interactions and the target UAS base URL for `/.sai/agents/*`; the prefix check is what the auth service enforces.

### Why `access-token-verifier` is currently present

Only one SAI config imports it:

- `packages/components/config/auth.json`
  - imports `css:config/ldp/authentication/dpop-bearer.json`
  - `dpop-bearer.json` defines the default extractor with `DPoPWebIdExtractor` and `BearerWebIdExtractor`
  - both import `@solid/access-token-verifier`

Data and registry use `css:config/ldp/authentication/lws.json`, which uses `LwsAccessTokenExtractor` and `jose`, not `access-token-verifier`.

There is no direct source import in `sai-js`. The root `sai-js/package.json` only has an `overrides` entry for `@solid/access-token-verifier`; the package still appears transitively under `@solid/community-server`.

`SelfIssuedSession` is the remaining DPoP client: `SessionManager.getSession()` routes every `https://auth/` URL to `SelfIssuedSession.authFetch`, so `.sai/sparql-admin` and `.sai/agents` use DPoP today.

## Trusted issuer value

Every token this service issues sets `iss` from `urn:solid-server:default:variable:baseUrl`.

- CSS `CommunitySolidServer/config/identity/lws/default.json` → `LwsAccessTokenIssuer.issuer`
- components `packages/components/config/identity/id-jag.json` → `IdJagIssuer.issuer`
- components `packages/components/config/http/handler/default.json` → `SessionManager.baseUrl`
- components `packages/components/src/builders/sessionManager.ts` → `CSS_BASE_URL`

The same value is used as the SAI trust entry:

```json
"trustedIssuers": [{ "@id": "urn:solid-server:default:variable:baseUrl" }]
```

So the existing `trustedIssuers` mechanism stays:

```text
if (iss is in trustedIssuers) {
  skip the CID subject-document check
} else {
  resolve sub CID document → lws:OpenIdProvider → issuer JWKS
}
```

The local key value and the trusted issuer value are the same configured base URL; there is no separate `localIssuer` field.

`aud === iss` is not the right local test:

- `.sai` interaction ID-JAGs have `aud` = the full request URL, so `aud !== iss` even when issued locally.
- storage ID-JAGs have `aud` = the storage AS, so `aud !== iss` by design.
- the audience is checked separately with an exact match.

The trigger is `iss` membership in `trustedIssuers`, not `aud !== iss`.

`trustedIssuers` already exists in CSS `OidcSubjectTokenVerifier` and in `CommunitySolidServer/config/identity/lws/default.json`. Keep it there and in SAI configs.

## Dependency end state

After this plan:

- `sai-js` has no direct import or runtime use of `@solid/access-token-verifier`.
- `sai-js` has no import or runtime use of `@uvdsl/solid-oidc-client-browser`.
- SAI configs do not import `css:config/ldp/authentication/dpop-bearer.json` or `css:config/ldp/authentication/solid-lws.json`.
  - `data` and `registry` keep using `css:config/ldp/authentication/lws.json`.
  - `auth` uses the new SAI ID-JAG credentials extractor.
- `@uvdsl/solid-oidc-client-browser` is removed from `packages/components/package.json` and the lockfile.
- The `@solid/access-token-verifier` override is removed from `sai-js/package.json`.

Important boundary: `@solid/access-token-verifier` will still be a transitive dependency of `@solid/community-server`, and CSS's `index.ts` re-exports `DPoPWebIdExtractor` / `BearerWebIdExtractor`, so the package may still be installed and loaded by CSS even when no SAI config uses it. This plan removes SAI's **use** of it. Removing it from the dependency graph or from CSS module loading requires a separate CSS change:

- split or lazy-load the Solid DPoP/Bearer extractors, or
- make the dependency optional, or
- use a CSS build that excludes the generic Solid configs.

That CSS change is out of scope for `sai-js`, but it is the only way to make `npm ls @solid/access-token-verifier` show nothing or to avoid loading the module at runtime.

## Design decisions

1. **ID-JAG for `.sai` with route-specific audiences**
   - One-time interaction clients mint the **full request URL** as `aud`.
   - `AgentIdHandler` clients mint the **target UAS base URL** as `aud`.
   - The auth service accepts any `aud` URL under its configured `baseUrl` (URL-aware prefix, normalized trailing slash).
   - This deliberately allows an ID-JAG minted for one auth `.sai` URL to be presented at another auth `.sai` URL. If per-interaction replay protection is required, use an exact audience instead; do not use raw string `startsWith`.
   - The ID-JAG is identity-only: no `resource`, no ODRL access claim.
   - It is signed by the issuer UAS; the signature and `iss` trust are still verified.

2. **DPoP only at the first exchange**
   - `createIdJagFetch` mints the `.sai` ID-JAG with the DPoP-bound subject token.
   - `.sai` requests themselves are plain Bearer requests with the ID-JAG.
   - Storage requests still use `createLwsAuthFetch` (ID-JAG → storage access token).

3. **CID document support only for cross-domain issuer discovery**
   - LWS CID documents are required for federation, not as an authentication suite on the first hop.
   - When an ID-JAG's issuer is not in `trustedIssuers` (`iss !== trusted issuer`), the verifier:
     1. dereferences `sub` as a CID document
     2. requires `id` to equal `sub`
     3. finds a service with type `https://www.w3.org/ns/lws#OpenIdProvider`
     4. requires `serviceEndpoint` to designate `iss`
     5. discovers/uses the issuer's JWKS to verify the ID-JAG signature
   - If `iss` is in `trustedIssuers` (the local base URL), skip the CID fetch and use the existing trusted-issuer key resolution.
   - The trigger is **`iss` membership in `trustedIssuers`**, not `aud !== iss`. A federated `iss != aud` ID-JAG triggers the CID check; a same-UAS `.sai` URL also has `iss != aud` but is locally trusted and must skip the CID check. Preserve this behavior in the refactor.
   - `trustedIssuers` contains the same configured value used as `iss` in tokens this service issues: `urn:solid-server:default:variable:baseUrl` (`LwsAccessTokenIssuer`, `IdJagIssuer`, `SessionManager.baseUrl`, `CSS_BASE_URL`).
   - SAI opts out of Solid-OIDC explicitly: `acceptSolidOidcIssuer: false`, no `additionalAudiences: ["solid"]`, no `webid` claim. Do not rely on the CSS defaults for this.
   - CSS's LWS preset is not strictly LWS-only at the token endpoint: `CommunitySolidServer/config/identity/lws/default.json` currently sets `acceptSolidOidcIssuer: true` and `additionalAudiences: ["solid"]`, so it accepts Solid-OIDC subject tokens. Resource authentication is opt-in via `lws.json` vs `solid-lws.json`, but subject-token compatibility is on by default. SAI must override it.
   - Do not support WebID, `solid:oidcIssuer`, or Solid-OIDC.
   - Do not add `CidSubjectTokenVerifier` / the LWS CID self-issued credential suite to the SAI first hop.

4. **Clean migration**
   - Add new helpers first, keep `buildOidcSession` / `buildSelfIssuedCredential` as compatibility wrappers returning a new `SaiSession`.
   - Keep a transitional `[ID-JAG, DPoP, Public]` extractor waterfall while tests migrate.
   - Remove DPoP and `access-token-verifier` only after the new path is green.

## Implementation steps

### Step 1 — Add `lws-auth` primitives

Files:

- `packages/lws-auth/src/credential.ts`
- `packages/lws-auth/src/fetch.ts`
- `packages/lws-auth/src/index.ts`

Add `createSelfIssuedCredential`:

```ts
export interface SelfIssuedCredentialOptions {
  issuer: string
  subject: string
  clientId: string
  dpopKeyPair: CryptoKeyPair
  subjectTokenType?: string
  sign(input: {
    issuer: string
    subject: string
    clientId: string
    audience: string
    jkt: string
    iat: number
    exp: number
    jti: string
  }): Promise<string>
}

export interface SelfIssuedCredential extends LwsCredential {
  getSubjectToken(audience?: string): Promise<string>
}

export function createSelfIssuedCredential(
  options: SelfIssuedCredentialOptions
): SelfIssuedCredential
```

Keep the CSS/JWK signing callback in components; `lws-auth` stays free of `@solid/community-server`.

Add `createIdJagFetch`:

```ts
export interface IdJagFetchOptions {
  credential: LwsCredential
  /**
   * Resolve the ID-JAG audience for a request URL.
   * - full request URL for one-time .sai interactions
   * - target UAS base URL for /.sai/agents/*
   */
  audience: string | ((requestUrl: string) => string)
  fetch?: WhatwgFetch
  tokenFetch?: WhatwgFetch
  renewalMargin?: number
  now?: () => number
}

export function createIdJagFetch(options: IdJagFetchOptions): WhatwgFetch
```

Behavior:

- resolve the audience for the exact request URL
- mint one identity-only ID-JAG with `requestIdJag`; no `resource` parameter
- cache keyed by the resolved audience, until shortly before `exp`
- send `Authorization: Bearer <id-jag>`
- on `401`, mint a fresh ID-JAG and retry once

Add tests:

- `packages/lws-auth/test/credential.test.ts`
- `packages/lws-auth/test/fetch.test.ts` (new `createIdJagFetch` cases, including per-URL audiences)

### Step 2 — Replace `SelfIssuedSession` with `SaiSession`

Files:

- add `packages/components/src/SaiSession.ts`
- delete `packages/components/src/SelfIssuedSession.ts`
- `packages/components/package.json`: remove `@uvdsl/solid-oidc-client-browser`
- `packages/components/src/builders/sessionManager.ts`

`SaiSession` is a thin composition:

```ts
export class SaiSession {
  constructor(
    readonly credential: SelfIssuedCredential,
    private readonly authIdJagFetch: WhatwgFetch,
    private readonly storageFetch: WhatwgFetch
  ) {}

  get webid() { return this.credential.subject }
  get clientId() { return this.credential.clientId }
  get issuer() { return this.credential.issuer }
  get dpopKeyPair() { return this.credential.dpopKeyPair }

  generateSelfIssuedAccessToken(audience = this.issuer) {
    return this.credential.getSubjectToken(audience)
  }

  authFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return url.startsWith(this.issuer)
      ? this.authIdJagFetch(input, init)
      : this.storageFetch(input, init)
  }
}
```

The audience resolver for `createIdJagFetch`:

```ts
function saiAudience(url: string): string {
  const parsed = new URL(url)
  return parsed.pathname.startsWith('/.sai/agents/')
    ? `${parsed.origin}/`
    : parsed.href
}
```

The signing callback in `builders/sessionManager.ts` uses `EnvJwkGenerator`, `jose`, and the same `at+jwt` claims as today, temporarily including `webid` if needed for the existing first-hop verifier. Remove `webid` in Step 5.

Keep compatibility in `builders/sessionManager.ts`:

```ts
return { oidc: session, session, credential, dpopKeyPair, issuer, clientId }
```

`buildOidcSession()` returns the `SaiSession`; tests that call `.authFetch()` and `.generateSelfIssuedAccessToken()` keep working.

### Step 3 — Refactor `SessionManager`

Files:

- `packages/components/src/SessionManager.ts`

Replace `buildSelfIssuedSession` with `buildCredential`:

- issuer = `this.baseUrl`
- subject = `webid` (the SAI/CID URI; no WebID-specific claim)
- clientId = `agentId(webid)`
- DPoP key pair from `createDpopKeyPair()`
- `sign` builds the `at+jwt` with `iss`, `sub`, `client_id`/`azp`, `aud`, `cnf.jkt`, `jti`, `exp`

Then:

- `storageFetch(webid, storage)`:
  - `createLwsAuthFetch({ credential, storages: [storage] })`
- `impersonationFetch(admin, org, storage)`:
  - first hop `requestIdJag` with `credential.getSubjectToken()`
  - second hop `requestIdJag` with the incoming ID-JAG
  - `createLwsFetch` for the final storage request
- `getSession(webid)`:
  - `authorizationFetch = createIdJagFetch({ credential, audience: saiAudience })`
  - `storageFetch = createLwsAuthFetch({ credential, storages: [...] })`
  - `sessionFetch` routes `authBase` URLs to `authorizationFetch`, everything else to `storageFetch`
  - no `dpopFetch`, no `SelfIssuedSession`

The `.sai` ID-JAG has no `resource` parameter. Its `aud` is either the full request URL or the target UAS base URL for `/.sai/agents/*`.

### Step 4 — Accept ID-JAG on `.sai` routes

Files:

- add `packages/components/src/IdJagCredentialsExtractor.ts`
- add `packages/components/config/ldp/authentication/id-jag.json`
- add `packages/components/config/identity/id-jag-auth.json` (or reuse `id-jag-accept.json` with a separate verifier id)
- `packages/components/config/auth.json`
- `packages/components/config/http/handler/default.json` (comments)
- `packages/components/src/AdminSparqlHandler.ts` (comments)
- `packages/components/src/services/queries/org.ts` (comments)

`IdJagCredentialsExtractor` uses the configured auth base URL and lets the verifier enforce the prefix:

```ts
export class IdJagCredentialsExtractor extends CredentialsExtractor {
  public constructor(
    private readonly verifier: IdJagSubjectTokenVerifier,
    private readonly baseUrl: string
  ) { super() }

  public async canHandle({ headers }: HttpRequest): Promise<void> {
    if (!matchesAuthorizationScheme('Bearer', headers.authorization)) {
      throw new NotImplementedHttpError('No Bearer ID-JAG specified.')
    }
  }

  public async handle(request: HttpRequest): Promise<Credentials> {
    const token = request.headers.authorization!.replace(/^Bearer\s+/iu, '')

    const verified = await this.verifier.handleSafe({
      token,
      tokenType: ID_JAG_TOKEN_TYPE,
      audience: this.baseUrl,
    })
    return {
      agent: { webId: verified.subject },
      client: { clientId: verified.client },
      issuer: { url: verified.issuer },
      ...(verified.access === undefined ? {} : {
        access: verified.access,
        accessContext: verified.accessContext,
      }),
    }
  }
}
```

Config:

```json
{
  "@id": "urn:solid-server:default:CredentialsExtractor",
  "@type": "CachedHandler",
  "source": {
    "@type": "StatusWaterfallHandler",
    "handlers": [
      {
        "@type": "IdJagCredentialsExtractor",
        "verifier": { "@id": "urn:sai:default:AuthIdJagSubjectTokenVerifier" },
        "baseUrl": { "@id": "urn:solid-server:default:variable:baseUrl" }
      },
      { "@type": "PublicCredentialsExtractor" }
    ]
  }
}
```

The `PublicCredentialsExtractor` fallback keeps anonymous `.sai/agents` discovery working.

Replace in `packages/components/config/auth.json`:

```diff
- "css:config/ldp/authentication/dpop-bearer.json",
+ "sai:config/ldp/authentication/id-jag.json",
```

The auth verifier is `IdJagSubjectTokenVerifier` with:

- `trustedIssuers: [{ "@id": "urn:solid-server:default:variable:baseUrl" }]`
- `audiencePrefix: { "@id": "urn:solid-server:default:variable:baseUrl" }` for the auth `.sai` verifier
- no `acceptSolidOidcIssuer`
- no `claimValidator`

`audiencePrefix` validation must be URL-aware:

```ts
function isWithinBaseUrl(audience: string, baseUrl: string): boolean {
  const a = new URL(audience)
  const b = new URL(baseUrl)
  const basePath = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`
  return a.origin === b.origin && (basePath === '/' || a.pathname === b.pathname || a.pathname.startsWith(basePath))
}
```

Do not use raw `audience.startsWith(baseUrl)`; normalize the trailing slash and compare URL origin/path. Storage `IdJagSubjectTokenVerifier` instances keep exact audience validation.

Cross-domain ID-JAGs are verified through the CID document path in Step 5.

### Step 5 — First-hop local verifier; CID discovery for federated ID-JAGs

Files:

- add `packages/components/src/SaiSelfIssuedAccessTokenVerifier.ts`
- add `packages/components/src/CidIssuerResolver.ts` (or equivalent)
- `packages/components/config/identity/id-jag.json`
- `packages/components/src/IdJagSubjectTokenVerifier.ts`

`SaiSelfIssuedAccessTokenVerifier` verifies the first-hop SAI token:
- `typ = at+jwt`
- `iss = baseUrl`
- `aud` includes `baseUrl`
- signature with the local `JwkGenerator` public key
- `exp` / `iat`
- `sub` and `client_id` are HTTPS identifiers
- `cnf.jkt === proofKeyThumbprint`

No OIDC discovery, no subject document, no WebID, and no CID for the first-hop SAI access token. CID document resolution belongs only to cross-domain ID-JAG verification (Step 5 below).

There is no `acceptSolidOidcIssuer` or `additionalAudiences: ["solid"]` on this verifier. SAI must not inherit the CSS LWS preset's Solid-OIDC compatibility defaults.

Replace `IdTokenVerifier` in `config/identity/id-jag.json` with this verifier.

`IdJagSubjectTokenVerifier` remains for incoming ID-JAGs, but stop inheriting `OidcSubjectTokenVerifier`. Split it into:

- JWT verification (`verifyJwtCredential`)
- issuer/key resolution:
  - `iss` in `trustedIssuers` → trusted issuer, skip the CID document check
  - `iss` not in `trustedIssuers` → CID document resolution:
    1. `GET sub` with `Accept: application/ld+json, application/json;q=0.9, text/turtle;q=0.8`
    2. require `id === sub`
    3. find a service with type `https://www.w3.org/ns/lws#OpenIdProvider`
    4. require `serviceEndpoint` to equal `iss` (trim trailing slash)
    5. discover/verify the issuer's JWKS
- no `solid:oidcIssuer`
- no `webid` claim
- no `CidSubjectTokenVerifier` first-hop suite

This same verifier is used by `IdJagCredentialsExtractor`, so `.sai` ID-JAGs from another agent's UAS work when `iss != aud`.

Note: `interop:AuthorizationAgent` is **not** checked anywhere today. `AgentIdHandler` emits it in its CID document, but `discoverAuthorizationAgent` only reads the `interop:hasAuthorizationAgent` RDF property, and `discoverCidService` is currently only used for `lws:AccessRequestService` / `lws:AccessGrantService`. If pure CID-only documents are in scope, add a fallback that fetches with `Accept: application/cid`, checks the `service` type `http://www.w3.org/ns/solid/interop#AuthorizationAgent`, and returns its `serviceEndpoint` when the RDF property is absent. Add a CID-only discovery test.

### Step 6 — Allow `.sai` audiences in the token handler

Files:

- `CommunitySolidServer/src/identity/lws/LwsTokenHttpHandler.ts` (or the SAI fork equivalent)
- `packages/components/config/identity/id-jag.json`

`IdJagTokenHandler.verifyAudience` currently accepts only base URLs (`pathname === '/'`). That is too narrow for `.sai` interaction URLs.

Add a configurable SAI audience policy:

- storage base URLs / storage origins (existing)
- authorization-server base URLs (existing)
- `.sai` audiences under the auth service's own `baseUrl`: accept any URL that is within the configured base URL prefix
- `.sai` audiences on another UAS: accept only configured peer origins/patterns, or an explicit allowlist
- target UAS base URLs for `/.sai/agents/*`

The auth service's verifier uses the prefix rule; the issuer-side `IdJagTokenHandler.verifyAudience` must allow the same `.sai` audience URLs when minting locally. Use URL-aware validation, not raw `startsWith`.

The issuing UAS must be able to mint an ID-JAG with `aud = https://other-uas/.sai/...` when an agent from its domain calls another UAS. The accepting UAS verifies the exact URL.

### Step 7 — Remove the workaround

- `sai-js/package.json`: remove the `@solid/access-token-verifier` `overrides` entry.
- Run `npm install` and update `package-lock.json`.
- In `CommunitySolidServer`, revert the `@solid/access-token-verifier` 2.1.2 bump once no SAI path uses DPoP `QUERY`.
- Remove comments referencing `access-token-verifier` 2.1.2 in:
  - `packages/components/src/AdminSparqlHandler.ts`
  - `packages/components/src/services/queries/org.ts`
  - `packages/components/config/http/handler/default.json`

Note: the package still appears under `@solid/community-server` because CSS's generic Solid configs export the DPoP/Bearer extractors. Removing it from the dependency graph entirely requires a separate CSS change.

### Step 8 — Update the architecture notes

Files:

- `docs/lws-auth.c4`
- `docs/plan.md` (this file)

The current `lws-auth.c4` says the SAI fixtures do not use `lws:OpenIdProvider`; that is now stale. Update the C4 model/dynamic views to show:

- `.sai` ID-JAG audiences: full request URL for interactions, target UAS base URL for `/.sai/agents/*`
- federated `iss != aud` verification through the subject CID document → `lws:OpenIdProvider` → issuer JWKS
- first-hop DPoP only at the UAS token endpoint

Use the LikeC4 DSL skill when editing `.c4` files. Validate with the project-local LikeC4 config:

```bash
npx likec4 validate --json --no-layout --file docs/lws-auth.c4 <project-dir>
```

If no LikeC4 project config exists yet, find/create the project scope first; do not validate a `.c4` file outside a configured project.

### Step 9 — Clean naming and tests

- Rename `buildOidcSession` → `buildSaiSession`; keep an alias during the change.
- Rename `oidc` → `session` / `credential` in builders.
- Update tests that assert DPoP against `.sai` to assert ID-JAG.
- Keep DPoP only in:
  - `test/lws-auth.test.ts`
  - `test/impersonation.test.ts`
  - first-hop subject-token tests
- Add tests for:
  - `AgentIdHandler` ID-JAG aud = target UAS base URL
  - `.sai/access-requests`, `.sai/grants`, `.sai/invitations`, `.sai/sparql-admin` ID-JAG aud = full request URL
  - cross-domain `iss != aud` CID document discovery
  - rejection when the CID document does not designate `iss` as `lws:OpenIdProvider`
  - rejection when the ID-JAG audience is a different `.sai` URL
- Remove WebID/Solid-OIDC assumptions from SAI test fixtures where they are only used for auth. Use the existing HTTPS CID identifiers.
- Run the full Dagger suite.

## Acceptance criteria

- No SAI source or test imports `@solid/access-token-verifier`.
- No config used by the SAI `auth`, `data`, or `registry` environments imports `css:config/ldp/authentication/dpop-bearer.json` or `css:config/ldp/authentication/solid-lws.json`.
- No SAI source or test imports `@uvdsl/solid-oidc-client-browser`; it is gone from `packages/components/package.json` and the lockfile.
- No SAI config sets `acceptSolidOidcIssuer: true` or includes `"solid"` in `additionalAudiences`.
- SAI configs use `trustedIssuers` with `urn:solid-server:default:variable:baseUrl`.
- `SelfIssuedSession.ts` is gone.
- `.sai/agents/*` accepts an ID-JAG with `aud = target UAS base URL`.
- The auth `.sai` verifier accepts any ID-JAG `aud` URL under its configured `baseUrl`; clients mint the full request URL for interactions and the target UAS base URL for agents.
- Storage verifiers still require the exact audience (the storage AS).
- A federated ID-JAG with `iss != aud` is verified by dereferencing the subject CID document and finding the `lws:OpenIdProvider` service matching `iss`.
- A locally trusted ID-JAG with `aud != iss` (for example a full `.sai` interaction URL) skips the CID fetch. The code condition is `iss` membership in `trustedIssuers`, not `aud !== iss`.
- `.sai/api` and `.sai/events` keep using the account cookie.
- `.sai/agents` still works anonymously.
- DPoP is only used by `requestIdJag` when minting an ID-JAG.
- No WebID, Solid-OIDC, or LWS CID self-issued credential path is used by SAI.
- `local-css` / Dagger passes, including `org-context` and `admin-events`.

Expected `npm ls` result:

- `npm ls @uvdsl/solid-oidc-client-browser` → empty.
- `npm ls @solid/access-token-verifier` → still shows the transitive copy under `@solid/community-server`; this is expected until the separate CSS change described above.

## Verification commands

Run these after the migration:

```bash
rg -n "@solid/access-token-verifier|@uvdsl|dpop-bearer|solid-lws" \
  packages test package.json package-lock.json

rg -n "dpop-bearer|solid-lws" \
  packages/components/config environments

npm ls @uvdsl/solid-oidc-client-browser
npm ls @solid/access-token-verifier
```

Expected:

- no hits in SAI source/tests/configs for `@solid/access-token-verifier`, `@uvdsl`, `dpop-bearer`, or `solid-lws`
- `@uvdsl` absent
- `@solid/access-token-verifier` present only as a transitive `@solid/community-server` dependency (until the separate CSS change)

## Risks and pitfalls

1. **Audience prefix**
   - The auth `.sai` verifier accepts any `aud` URL under its base URL prefix.
   - Use URL-aware prefix validation (`origin` + normalized path), never raw `startsWith`; `https://auth.evil/` must not match `https://auth/`.
   - Clients still mint the full request URL for interactions and the target UAS base URL for agents.
   - Accepting a prefix weakens per-interaction binding: an ID-JAG for one auth `.sai` URL can be used at another auth `.sai` URL. If that matters, switch to exact audience for those routes.
   - Storage verifiers keep exact audiences.

2. **Cross-domain CID discovery**
   - The CID document must have `id === sub` and an `lws:OpenIdProvider` service whose `serviceEndpoint` equals `iss`.
   - No `solid:oidcIssuer` fallback.
   - A missing/broken CID document or JWKS must fail closed.
   - Use `trustedIssuers` membership rather than only literal `iss != aud`: a full `.sai` URL on the same UAS has `iss != aud` but must still skip the CID check.
   - `trustedIssuers` is `[urn:solid-server:default:variable:baseUrl]`, the same value configured as `iss` in `LwsAccessTokenIssuer`, `IdJagIssuer`, and `SessionManager`.

3. **Public `.sai/agents`**
   - Keep a `PublicCredentialsExtractor` fallback, otherwise anonymous agent discovery breaks.

4. **Application requests to `AgentIdHandler`**
   - The request should always be made by a UAS, possibly from a Temporal workflow. Do not let an application obtain an ID-JAG directly for its own `/.sai/agents` request unless it is acting through a UAS.

5. **Transitional DPoP**
   - Keep `[ID-JAG, DPoP, Public]` during migration if needed, then remove DPoP.
   - Do not remove `dpop-bearer.json` before the new session fetch and tests are ready.

6. **First-hop verifier**
   - `OidcSubjectTokenVerifier` currently uses OIDC discovery for the self-issued token. If the OIDC provider is removed, verification breaks. The local verifier is required, not just an optimization.

7. **Package graph**
   - Removing the override/config does not remove `@solid/access-token-verifier` from `npm ls`; CSS still depends on it. State this explicitly in the PR.

## Suggested PR split

1. `lws-auth`: `createIdJagFetch` + `createSelfIssuedCredential` + tests.
2. `components`: `SaiSession`, `SessionManager` refactor, remove `SelfIssuedSession`/`@uvdsl`, compatibility wrappers.
3. `components`: `IdJagCredentialsExtractor`, auth config, switch `.sai` routes; keep transitional DPoP if needed.
4. `components`: local `SaiSelfIssuedAccessTokenVerifier`, CID issuer resolver, remove OIDC/Solid paths from SAI, remove DPoP extractor and override.
5. `CommunitySolidServer`: allow `.sai` interaction audiences in `IdJagTokenHandler`.
6. Cleanup: architecture notes, comments, naming, docs, tests, package-lock.
7. Optional CSS-only follow-up: split or lazy-load the Solid DPoP/Bearer extractors so `@solid/access-token-verifier` is not installed or loaded at all in SAI runtime.

## Implementation status

This plan is implemented in the working tree:

- `lws-auth`: `createSelfIssuedCredential` and `createIdJagFetch` with per-audience caching and a single `401` retry; unit tests added.
- `components`: `SaiSession` replaces `SelfIssuedSession`; `SessionManager` and the builders use `createSelfIssuedCredentialWithJwk`, `createIdJagFetch` and `createLwsAuthFetch`.
- `.sai` authentication: `IdJagCredentialsExtractor` + `config/ldp/authentication/id-jag.json` accept Bearer ID-JAGs; the auth config no longer imports `dpop-bearer.json`.
- First hop: `SaiSelfIssuedAccessTokenVerifier` verifies the local `at+jwt` with the configured `JwkGenerator` key and DPoP thumbprint; no OIDC discovery, WebID or Solid-OIDC claim is involved.
- Incoming ID-JAGs: `IdJagSubjectTokenVerifier` no longer extends `OidcSubjectTokenVerifier`; `CidIssuerResolver` handles the `lws:OpenIdProvider` subject-document path for federated issuers and keeps exact audiences for storages.
- `.sai` audiences: the auth verifier accepts URLs under its base-URL prefix; `IdJagTokenHandler` accepts the storage/UAS base URLs, `.sai` URLs under this UAS, and `.sai` URLs of configured peer UASs.
- Dependencies: `@uvdsl/solid-oidc-client-browser` is removed from `packages/components/package.json` and the lockfile; the `@solid/access-token-verifier` override is removed. The package remains a transitive CSS dependency, as expected.
- Architecture: `docs/lws-auth.c4` now documents the `.sai` audiences, the first-hop-only DPoP use and the CID-based federated issuer lookup.

Package unit tests (`packages/lws-auth`, `packages/components`), `tsc` for both packages, the components build, and `likec4 validate` pass. The full Dagger integration suite (`/test`) passes with `--tempo-endpoint` (24 files, 198 tests). The trace-capture wrapper no longer buffers long-lived NDJSON/SSE streams, and the activity webhook handler treats a reseeded-away source activity as a permanent `410` instead of retrying it as a `500`.
