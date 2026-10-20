import { Postgres } from '@janeirodigital/interop-test-utils'
import { describe, expect, test } from 'vitest'

import { rpcPayload, waitFor } from './util'

// ──────────────────────────────────────────────────────────────────────────
// Account creation — the signup black box.
//
// There is no seeded account (and so no cookie) for the handle below: the test
// reproduces what the UI does when a user signs in with credentials that do
// not exist yet — create a fresh CSS account, add the email/password login
// method, then run the `BootstrapAccount` RPC.
//
// It asserts the observable end state (WebID profile, per-pod datasets,
// internal endpoint records) and POLLS for it, so moving bootstrap into a
// Temporal workflow (which returns before the activities finish) cannot
// silently change the result.
//
// Prereq: the Fuseki admin API must accept the service account
// (`ADMIN_PASSWORD` on the fuseki service, `CSS_FUSEKI_ADMIN` on auth) — new
// signups create their datasets dynamically (openwiki/architecture/storage-isolation.md).
// ──────────────────────────────────────────────────────────────────────────

const accountApi = 'https://auth/.account/'
const rpcEndpoint = 'https://auth/.sai/api'
const fusekiBaseUrl = 'http://fuseki:3030'
const connectionString = 'postgres://temporal:temporal@postgresql:5432/auth'

// a handle that is NOT in the fixture (environments/data/kv.json + registry.trig)
const handle = 'zoe'
const webId = `https://${handle}.id`
const docId = `https://id/${handle}`
const registrySet = `https://registry/${handle}/`
const dataRegistry = `https://${handle}.data/`
const registryDataset = `reg-${handle}`
const dataDataset = `data-${handle}`

const sparqlRegistryKey = `accounts/index/sparqlEndpoint/podUrl/${encodeURIComponent(registrySet)}`
const sparqlDataKey = `accounts/index/sparqlEndpoint/podUrl/${encodeURIComponent(dataRegistry)}`
const objectKey = `accounts/index/objectEndpoint/podUrl/${encodeURIComponent(dataRegistry)}`
// `checkHandle` looks up exactly this reverse index (`cssKv.webIdLinkByWebId`)
const webIdLinkKey = `accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`

const pg = new Postgres(connectionString, 'key_value')

interface Controls {
  controls: {
    account?: { create?: string }
    password?: { create?: string; login?: string }
  }
}

/**
 * Reproduce the UI sign-up up to the point that calls `bootstrapAccount`:
 * create a fresh CSS account (the response's `authorization` is the
 * `css-account` cookie value) and add the email/password login method.
 */
async function createAccountCookie(email: string, password: string): Promise<string> {
  const initial = (await (await fetch(accountApi)).json()) as Controls
  const accountCreate = initial.controls.account?.create
  expect(accountCreate, 'account.create control').toBeTruthy()
  const created = await fetch(accountCreate!, { method: 'POST' })
  expect(created.status).toBe(200)
  const { authorization } = (await created.json()) as { authorization: string }
  const cookie = `css-account=${authorization}`

  const withCookie = (await (await fetch(accountApi, { headers: { cookie } })).json()) as Controls
  const passwordCreate = withCookie.controls.password?.create
  expect(passwordCreate, 'password.create control').toBeTruthy()
  const passwordResponse = await fetch(passwordCreate!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ email, password }),
  })
  expect(passwordResponse.ok).toBe(true)
  return cookie
}

/** One RPC call on the SAI API with the account cookie; returns the result envelope. */
async function rpc(cookie: string, request: Record<string, unknown>): Promise<any> {
  const response = await fetch(rpcEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(rpcPayload(request)),
  })
  expect(response.status).toBe(200)
  const [result] = (await response.json()) as any[]
  return result
}

/** SPARQL ASK against a dataset, straight at Fuseki. */
async function ask(dataset: string, query: string): Promise<boolean> {
  const response = await fetch(`${fusekiBaseUrl}/${dataset}/sparql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`SPARQL query on ${dataset} failed: ${response.status}`)
  return ((await response.json()) as { boolean: boolean }).boolean
}

/**
 * Whether the WebID profile lands in the `id` dataset: the profile is served by
 * the id service at the webId's document IRI (`docId`), not at the webId itself
 * (the subdomain `webId` only redirects to it).
 */
async function profileLanded(): Promise<boolean> {
  const response = await fetch(docId, {
    headers: { accept: 'text/turtle' },
    signal: AbortSignal.timeout(5000),
  })
  return response.status === 200 && (await response.text()).includes(webId)
}

describe('account creation', () => {
  test('a new signup gets a WebID, both pods, and their endpoint records', async () => {
    const cookie = await createAccountCookie('zoe@example.com', 'correct horse battery staple')

    // the handle is free before the signup …
    const before = await rpc(cookie, { _tag: 'CheckHandle', handle })
    expect(before).toMatchObject({ _tag: 'Success', value: true })

    // … `BootstrapAccount` is the signup view's final step. Its success value
    // is the future WebID; synchronous today, a started Temporal workflow once
    // account creation moves there — so poll for the artifacts it produces.
    const bootstrap = await rpc(cookie, { _tag: 'BootstrapAccount', handle })
    expect(bootstrap).toMatchObject({ _tag: 'Success', value: webId })

    // poll each artifact independently so a failure reports exactly what the
    // workflow did not produce (rather than a bare timeout)
    let lastMissing: string[] = []
    const kv = await waitFor(
      async () => {
        const missing: string[] = []
        const state = (await pg.exportToJson().catch((err) => {
          missing.push(`kv(${err instanceof Error ? err.message : String(err)})`)
          return {} as Record<string, unknown>
        })) as Record<string, unknown>
        for (const [label, key] of [
          ['sparqlRegistry', sparqlRegistryKey],
          ['sparqlData', sparqlDataKey],
          ['object', objectKey],
          ['webIdLink', webIdLinkKey],
        ] as const) {
          if (!state[key]) missing.push(label)
        }
        const check = async (label: string, fn: () => Promise<boolean>) => {
          try {
            if (!(await fn())) missing.push(label)
          } catch (err) {
            missing.push(`${label}(${err instanceof Error ? err.message : String(err)})`)
          }
        }
        if (!missing.length) await check('profile', profileLanded)
        if (!missing.length)
          await check('id-ask', () => ask('id', `ASK { GRAPH <${docId}> { <${webId}> ?p ?o } }`))
        if (!missing.length)
          await check('registry-ask', () =>
            ask(registryDataset, `ASK { GRAPH <meta:${registrySet}> { <${registrySet}> ?p ?o } }`)
          )
        if (!missing.length)
          await check('data-ask', () =>
            ask(dataDataset, `ASK { GRAPH <meta:${dataRegistry}> { <${dataRegistry}> ?p ?o } }`)
          )
        if (missing.length) {
          lastMissing = missing
          return undefined
        }
        return state
      },
      { timeout: 25_000, interval: 500 }
    ).catch((err) => {
      throw new Error(`${err.message} — never present: ${lastMissing.join(', ')}`)
    })

    // the handle is now taken: the account has the reverse WebID link that
    // `checkHandle` queries. (We assert the store directly rather than issuing
    // another RPC: any RPC on an account that already has a WebID makes the
    // auth server `getSession(webId)`, which fetches `https://<handle>.id` — a
    // subdomain WebID dagger has no wildcard DNS for, unlike the path-based
    // document `https://id/<handle>` the test can fetch.)
    expect(kv[webIdLinkKey]).toBeDefined()

    // the internal endpoint registry carries an object endpoint for the data
    // pod (the S3 plan gives every data pod its own record/bucket)
    const accountId = (kv[objectKey] as string[])[0]
    const account = kv[`accounts/data/${accountId}`] as any
    const objectEndpoint = Object.values(account['**objectEndpoint**'])[0] as any
    expect(objectEndpoint).toMatchObject({
      podUrl: dataRegistry,
      endpoint: expect.any(String),
      accessKeyId: expect.any(String),
      secretAccessKey: expect.any(String),
    })
  }, 45_000)
})
