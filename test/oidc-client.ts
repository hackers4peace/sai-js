import {
  createBrowserCredential,
  createBrowserSession,
  decodeJwt,
  dpopThumbprint,
  memoryStore,
} from '@elfpavlik/lws-auth'
import type { BrowserCredential, BrowserSession, DecodedJwt } from '@elfpavlik/lws-auth'

/*
 * A real OIDC client session for `/test`, without a browser.
 *
 * The suite historically authenticates with `buildSelfIssuedCredential`, which
 * signs an `at+jwt` in-process with `CSS_ENCODED_PRIVATE_JWK` and names
 * `agentId(webId)` as the client. That is the *UAS-side agent* credential: no
 * app, no sign-in, and `client_id` never names a client. This helper runs what
 * the UI runs (openwiki/architecture/lws-auth.md), using the product code in
 * `packages/lws-auth` for everything that is not a browser:
 *
 *   1. `createBrowserSession` — OIDC discovery, the authorization code flow
 *      with PKCE, `dpop_jkt` and the code → token exchange
 *      (`oauth4webapi`, one non-extractable key pair);
 *   2. {@link completeInteraction} — the OP's own pages (sign-in, WebID picker,
 *      consent) driven through `/.account/` controls with a cookie jar, exactly
 *      like the sign-in page in a browser (CSS's `Identity.test.ts` does the
 *      same); this is the only part the package leaves to the app.
 *
 * The session's **access token** is the LWS credential: the OP issues it with
 * `aud` = its own identifier (`iss`) and `cnf.jkt` of the session key, so the
 * app presents it as a `…:access_token` subject token at the UAS and proves
 * possession of the key. See `openwiki/architecture/lws-auth.md`.
 */

const ISSUER = process.env.CSS_BASE_URL ?? 'https://auth/'
/** The password the fixtures hash for every seeded account (`kv.json`). */
const FIXTURE_PASSWORD = 'password'

/** A cookie jar for the sign-in pages — the interaction is cookie-driven. */
class CookieJar {
  private readonly cookies = new Map<string, string>()

  private header(): string {
    return Array.from(this.cookies, ([name, value]): string => `${name}=${value}`).join('; ')
  }

  public async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const cookie = this.header()
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(cookie ? { cookie } : {}),
      },
    })
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const separator = pair.indexOf('=')
      if (separator > 0)
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1))
    }
    return response
  }
}

interface InteractionOptions {
  authorizeUrl: string
  /** Must match the client's `redirect_uris` — the URL the OP sends the code to. */
  redirectUrl: string
  webid: string
  email: string
  password: string
}

/**
 * Drives the OP's interactions (sign-in, WebID picker, consent) until it
 * redirects to `redirectUrl` with the authorization code, and returns that URL
 * for `session.handleRedirect`.
 */
async function completeInteraction(options: InteractionOptions): Promise<string> {
  const jar = new CookieJar()
  // Each prompt fires once per flow: sign-in, then the WebID picker, then
  // consent. The controls stay listed on every index page, so track what ran.
  const done = new Set<string>()
  let controls: any = {}
  let current = options.authorizeUrl
  const hops: string[] = []

  for (let hop = 0; hop < 16; hop++) {
    const response = await jar.fetch(current)
    hops.push(`GET ${current} -> ${response.status}`)

    if (response.status === 303 || response.status === 302 || response.status === 307) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`interaction redirect ${response.status} without a location`)
      const next = new URL(location, current)
      if (next.href.startsWith(options.redirectUrl)) {
        if (!next.searchParams.has('code')) {
          throw new Error(`authorization redirected without a code: ${next.href}`)
        }
        return next.href
      }
      current = next.href
      continue
    }

    if (response.status !== 200) {
      throw new Error(
        `interaction failed: ${response.status} ${await response.text()}\n${hops.join('\n')}`
      )
    }

    // An interaction page: its controls point at the next step.
    const body = await response.json()
    if (body?.controls) controls = { ...controls, ...body.controls }

    let step: { url: string; body?: unknown } | undefined
    if (!done.has('login') && controls.password?.login) {
      done.add('login')
      step = {
        url: controls.password.login,
        body: { email: options.email, password: options.password },
      }
    } else if (!done.has('webid') && controls.oidc?.webId) {
      done.add('webid')
      step = { url: controls.oidc.webId, body: { webId: options.webid, remember: true } }
    } else if (!done.has('consent') && controls.oidc?.consent) {
      done.add('consent')
      step = { url: controls.oidc.consent }
    }
    if (!step) throw new Error(`no known interaction step at ${current}\n${hops.join('\n')}`)

    const post = await jar.fetch(step.url, {
      method: 'POST',
      headers: step.body ? { 'content-type': 'application/json' } : {},
      body: step.body ? JSON.stringify(step.body) : undefined,
    })
    hops.push(`POST ${step.url} -> ${post.status}`)
    if (!post.ok) {
      throw new Error(`interaction step ${step.url} failed: ${post.status}\n${hops.join('\n')}`)
    }
    const { location } = (await post.json()) as { location?: string }
    if (!location) throw new Error(`interaction step ${step.url} returned no location`)
    current = location
  }

  throw new Error(`the authorization interaction did not finish\n${hops.join('\n')}`)
}

export interface OidcClientOptions {
  /** The user signing in — becomes the credential's `sub`/`webid`. */
  webid: string
  /** The account's email (`kv.json` seeds `bob@yoyodyne.example`, …). */
  email: string
  /** Defaults to {@link FIXTURE_PASSWORD}. */
  password?: string
  /** The app's identifier — becomes the credential's and the ID-JAG's `client_id`. */
  clientId: string
  /** Must be listed in the client's metadata document; defaults to `clientId`. */
  redirectUrl?: string
}

export interface OidcClientSession {
  webid: string
  clientId: string
  /** The OIDC session: its `fetch` presents the DPoP-bound access token. */
  session: BrowserSession
  /** The session's single key pair — the credential's `cnf.jkt` and every proof. */
  keyPair: CryptoKeyPair
  /** RFC 7638 thumbprint of {@link keyPair}, the credential's `cnf.jkt`. */
  dpopJkt: string
  /** The LWS credential the app presents at the UAS token endpoint. */
  credential: BrowserCredential
  /** The credential's `subject_token_type` (`…:access_token`). */
  subjectTokenType: string
  /** The credential's JWT (the session access token). */
  subjectToken: string
  /** Decoded claims of {@link subjectToken}. */
  credentialClaims: DecodedJwt['claims']
}

/**
 * Signs an app in through the OIDC code flow and returns its LWS credential.
 * See the module comment for the steps.
 */
export async function loginAsClient(options: OidcClientOptions): Promise<OidcClientSession> {
  const { webid, email, clientId } = options
  const redirectUrl = options.redirectUrl ?? clientId

  const session = createBrowserSession({
    issuer: ISSUER,
    clientId,
    redirectUrl,
    store: memoryStore(),
  })

  const redirect = await completeInteraction({
    authorizeUrl: await session.login(),
    redirectUrl,
    webid,
    email,
    password: options.password ?? FIXTURE_PASSWORD,
  })

  const info = await session.handleRedirect(redirect)
  if (info.webId !== webid) {
    throw new Error(`the session signed in as ${info.webId}, not ${webid}`)
  }

  const keyPair = session.dpopKeyPair
  if (!keyPair) throw new Error('the session has no DPoP key pair')

  // No separate mint: the session's own DPoP-bound access token is the LWS
  // credential (`cnf.jkt` is this key, `aud` is the UAS that verifies it).
  const credential = await createBrowserCredential(session)
  const subjectToken = await credential.getSubjectToken()

  return {
    webid,
    clientId,
    session,
    keyPair,
    dpopJkt: await dpopThumbprint(keyPair.publicKey),
    credential,
    subjectTokenType: credential.subjectTokenType!,
    subjectToken,
    credentialClaims: decodeJwt(subjectToken).claims,
  }
}
