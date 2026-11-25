import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'

export const AUTH_ORIGIN = process.env.AUTH_ORIGIN ?? 'https://auth.docker'
export const UI_BASE_URL = process.env.UI_BASE_URL ?? 'https://ui.auth.docker'
/** The demo app (`examples/vuejectron`), the stack's `test-client` application. */
export const VUEJECTRON_URL = process.env.VUEJECTRON_URL ?? 'https://vuejectron.docker'

/**
 * Agent WebIDs: the compose dev stack maps them (environments/dev/map.json,
 * https://id/bob -> https://bob.id.docker); `dagger call playwright` sets the
 * in-engine IRIs (https://id/bob).
 */
export const AGENT_IDS = {
  alice: process.env.ALICE_ID ?? 'https://alice.id.docker',
  bob: process.env.BOB_ID ?? 'https://bob.id.docker',
  kim: process.env.KIM_ID ?? 'https://kim.id.docker',
  nobody: process.env.NOBODY_ID ?? 'https://nobody.id.docker',
} as const

/** Start a second, isolated browser for another actor in the same test. */
export async function newActor(
  browser: Browser,
  testInfo: TestInfo,
  account: Account
): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
  // Contexts created with browser.newContext() do not get the config's `use`
  // options: pass what the app needs and record this actor's video explicitly.
  const context = await browser.newContext({
    baseURL: UI_BASE_URL,
    ignoreHTTPSErrors: true,
    recordVideo: { dir: testInfo.outputPath(`${account}-video`) },
  })
  const page = await context.newPage()
  await attachDiagnostics(page, testInfo, account)
  await signIn(context, account)
  return {
    context,
    page,
    async close() {
      await context.close()
      const video = await page.video()?.path()
      if (video) {
        await testInfo.attach(`${account} video`, { path: video, contentType: 'video/webm' })
      }
    },
  }
}

/**
 * Seeded session cookies (environments/data/kv.json): the VALUE is the
 * `accounts/cookies/<value>` key, not the account id.
 */
export const ACCOUNT_COOKIES = {
  alice: '8187358a-2072-4dce-9c76-24caffcc84a4',
  bob: '339642f3-f3ee-42e5-85b9-4b1ab6b27ddc',
  dan: '4f8fe6e4-4a5a-4318-93f6-d8645778fc28',
  kim: '77b0674a-1f3b-4c78-a7d9-0b2e3f4a5b6c',
} as const

export type Account = keyof typeof ACCOUNT_COOKIES

/** Sign the browser context in as a seeded account. */
export async function signIn(context: BrowserContext, account: Account): Promise<void> {
  await context.addCookies([
    {
      name: 'css-account',
      value: ACCOUNT_COOKIES[account],
      url: AUTH_ORIGIN,
      secure: true,
      // under Dagger the UI (ui.auth) and the backend (auth) are different
      // sites, so the credentialed RPC fetch needs a cross-site cookie
      sameSite: 'None',
    },
  ])
}

/**
 * Surface backend failures and browser errors in the report: the trace keeps
 * requests, but not the body of a failed RPC response. `who` prefixes the
 * attachment names when a test drives several browsers.
 */
export async function attachDiagnostics(page: Page, testInfo: TestInfo, who = ''): Promise<void> {
  const prefix = who ? `${who}: ` : ''
  // Activity events from the always-open NDJSON stream (GET /.sai/events):
  // tee the stream in the page and log each activity line, so the report
  // shows what each actor's UI received and when. Reading the response from
  // Playwright instead would wait for a stream that never ends.
  await page.addInitScript(() => {
    // A rejected RPC awaited from a Vue watcher (Authorization.vue's `webid`
    // watcher, for example) is an unhandled rejection, not a pageerror: without
    // this a blank view leaves no diagnostic behind. Surface it at error level
    // so the console handler below attaches it to the report.
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      console.error(`[sai-unhandled-rejection] ${detail}`)
    })
    const originalFetch = window.fetch
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args)
      const input = args[0]
      const url = input instanceof Request ? input.url : String(input)
      if (!url.endsWith('/.sai/events') || !response.body) {
        return response
      }
      const [forApp, forLog] = response.body.tee()
      void (async () => {
        const reader = forLog.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader
            .read()
            .catch(() => ({ value: undefined, done: true }))
          if (done) {
            break
          }
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.includes('"activity"')) {
              console.debug(`[sai-event] ${line}`)
            }
            newline = buffer.indexOf('\n')
          }
        }
      })()
      return new Response(forApp, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
  })
  page.on('console', async (message) => {
    const text = message.text()
    if (!text.startsWith('[sai-event] ')) {
      return
    }
    const line = text.slice('[sai-event] '.length)
    let name = 'event'
    try {
      const { activity } = JSON.parse(line)
      const type = [activity.type]
        .flat()
        .filter((t: string) => t !== 'Activity')
        .join(',')
      name = `event ${type} ${activity.status}`
    } catch {
      // keep the raw line
    }
    await testInfo.attach(`${prefix}${name}`, {
      body: `${new Date().toISOString()}\n${line}`,
      contentType: 'text/plain',
    })
  })
  page.on('pageerror', async (error) => {
    await testInfo.attach(`${prefix}page error`, {
      body: error.stack || error.message || String(error) || '<no page error detail>',
      contentType: 'text/plain',
    })
  })
  page.on('response', async (response) => {
    const rpc = response.url().endsWith('/.sai/api')
    if (response.status() < 400 && !rpc) {
      return
    }
    const body = await response.text().catch(() => '<unreadable>')
    // an RPC failure travels as HTTP 200 with a Failure/Defect exit in the body
    if (response.status() < 400 && !body.includes('"Failure"') && !body.includes('"Defect"')) {
      return
    }
    await testInfo.attach(
      `${prefix}HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
      {
        body: `request:\n${response.request().postData() ?? ''}\n\nresponse:\n${body}`,
        contentType: 'text/plain',
      }
    )
  })
  page.on('console', async (message) => {
    if (message.type() !== 'error') {
      return
    }
    await testInfo.attach(`${prefix}console error`, {
      body: message.text(),
      contentType: 'text/plain',
    })
  })
}
