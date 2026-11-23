import { expect, test } from '@playwright/test'

// UI counterpart of test/authorizations.test.ts (ListAuthorizations, C0): the
// read-only authorization listing for a peer, rendered by the Authorizations
// view, signed in as alice. Seeded in environments/data/registry.trig: alice's
// authorizations for bob — an AllFromRegistry parent (alice/p7n4qw) and its
// inherited child (alice/t5m8kr).
// Defaults target the compose dev stack (environments/dev/map.json:
// https://id/bob -> https://bob.id.docker); `dagger call playwright` sets the env to
// the in-engine hostnames (https://auth, https://id/bob).

const AUTH_ORIGIN = process.env.AUTH_ORIGIN ?? 'https://auth.docker'
const BOB_ID = process.env.BOB_ID ?? 'https://bob.id.docker'
const NOBODY_ID = process.env.NOBODY_ID ?? 'https://nobody.id.docker'
// alice's seeded session cookie (environments/data/kv.json)
const ALICE_ACCOUNT_COOKIE = '8187358a-2072-4dce-9c76-24caffcc84a4'

// Surface backend failures and browser errors in the report: the trace keeps
// requests, but not the body of a failed RPC response.
test.beforeEach(async ({ page }, testInfo) => {
  page.on('response', async (response) => {
    if (response.status() < 400) return
    const body = await response.text().catch(() => '<unreadable>')
    await testInfo.attach(
      `HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
      {
        body: `request:\n${response.request().postData() ?? ''}\n\nresponse:\n${body}`,
        contentType: 'text/plain',
      }
    )
  })
  page.on('console', async (message) => {
    if (message.type() !== 'error') return
    await testInfo.attach('console error', { body: message.text(), contentType: 'text/plain' })
  })
})

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: 'css-account',
      value: ALICE_ACCOUNT_COOKIE,
      url: AUTH_ORIGIN,
      secure: true,
      // under Dagger the UI (ui.auth) and the backend (auth) are different
      // sites, so the credentialed RPC fetch needs a cross-site cookie
      sameSite: 'None',
    },
  ])
})

test('lists the recorded authorizations for a grantee, including inherited children', async ({
  page,
}) => {
  await page.goto(`/authorizations?grantee=${encodeURIComponent(BOB_ID)}`)

  const items = page.locator('.v-list-item')
  await expect(items).toHaveCount(2)

  const parent = items.filter({ hasText: 'All from registry' })
  const child = items.filter({ hasText: 'Inherited' })
  await expect(parent).toHaveCount(1)
  await expect(child).toHaveCount(1)

  // the inherited child is nested under its parent
  await expect(child.locator('.mdi-subdirectory-arrow-right')).toBeVisible()
  await expect(parent.locator('.mdi-subdirectory-arrow-right')).toHaveCount(0)

  // every authorization shows at least one access mode chip
  await expect(parent.locator('.v-chip').first()).toBeVisible()
})

test('shows the empty state for a grantee without authorizations', async ({ page }) => {
  await page.goto(`/authorizations?grantee=${encodeURIComponent(NOBODY_ID)}`)

  await expect(page.getByText('No authorizations')).toBeVisible()
  await expect(page.locator('.v-list-item')).toHaveCount(0)
})
