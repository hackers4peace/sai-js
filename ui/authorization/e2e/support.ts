import type { BrowserContext, Page, TestInfo } from '@playwright/test'

export const AUTH_ORIGIN = process.env.AUTH_ORIGIN ?? 'https://auth.docker'
export const UI_BASE_URL = process.env.UI_BASE_URL ?? 'https://ui.auth.docker'

/**
 * Seeded session cookies (environments/data/kv.json): the VALUE is the
 * `accounts/cookies/<value>` key, not the account id.
 */
export const ACCOUNT_COOKIES = {
  alice: '8187358a-2072-4dce-9c76-24caffcc84a4',
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
export function attachDiagnostics(page: Page, testInfo: TestInfo, who = ''): void {
  const prefix = who ? `${who}: ` : ''
  page.on('response', async (response) => {
    if (response.status() < 400) return
    const body = await response.text().catch(() => '<unreadable>')
    await testInfo.attach(
      `${prefix}HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
      {
        body: `request:\n${response.request().postData() ?? ''}\n\nresponse:\n${body}`,
        contentType: 'text/plain',
      }
    )
  })
  page.on('console', async (message) => {
    if (message.type() !== 'error') return
    await testInfo.attach(`${prefix}console error`, {
      body: message.text(),
      contentType: 'text/plain',
    })
  })
}
