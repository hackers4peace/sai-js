import { expect, test } from '@playwright/test'

import { AGENT_IDS, attachDiagnostics, newActor, signIn } from './support'

// UI counterpart of the need-based access request in test/access-request.test.ts
// and its approval in test/authorization.test.ts ("approve a need-based access
// request"), mirrored: Alice requests access to Bob's data based on the needs
// of an application she registered (Test client: Project + inherited Task),
// and Bob approves it — each in their own browser with their own session.
// Seed (environments/data/registry.trig): Bob registers Alice ("Alice") with
// no access grant, so Alice sees no data from Bob and can request access.
//
// No reloads: each actor opens their screen BEFORE the other side acts and
// then only waits — the views must refresh from the activity event stream
// (GET /.sai/events) when the Temporal workflows complete. The waits are
// generous because they cover the workflows, not the UI.

const WORKFLOW_TIMEOUT = 60_000
const FIRST_LOAD_TIMEOUT = 30_000

test('alice requests access to bob’s data based on an application, bob approves', async ({
  browser,
  context: aliceContext,
  page: alice,
}, testInfo) => {
  // several workflow round trips (request sent/received, grant, delegation)
  test.setTimeout(3 * WORKFLOW_TIMEOUT)

  // ── Alice: default browser context of the test ──
  await attachDiagnostics(alice, testInfo, 'alice')
  await signIn(aliceContext, 'alice')

  // ── Bob: a second, isolated browser ──
  const bob = await newActor(browser, testInfo, 'bob')

  // Bob's card for Alice on his Peers page; its Access button (a link to the
  // approval screen) stays disabled until a request is received
  const aliceCard = bob.page
    .locator('.v-card')
    .filter({ has: bob.page.locator('.v-card-title', { hasText: /^Alice$/ }) })
  const access = aliceCard.getByRole('link', { name: /^Access/ })
  const DISABLED = /v-btn--disabled/

  try {
    await test.step('both open their screens', async () => {
      // first loads on a cold stack can be slow (registry + data pod reads)
      await bob.page.goto('/social-agents')
      await expect(aliceCard).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
      await expect(access).toHaveClass(DISABLED)

      await alice.goto(`/data-registries?agent=${encodeURIComponent(AGENT_IDS.bob)}`)
      // rendered once Bob's (empty) data registry list for Alice has loaded
      await expect(alice.getByText('Request access')).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    })

    await test.step('alice requests access based on the Test client needs', async () => {
      await alice.getByRole('button', { name: 'Based on an application' }).click()
      const sent = alice.waitForResponse(
        (response) =>
          response.url().endsWith('/.sai/api') &&
          !!response.request().postData()?.includes('"RequestAccessUsingApplicationNeeds"')
      )
      await alice.getByText('Test client').click()
      expect((await sent).status()).toBe(200)
      // the picker dialog does not close itself
      await alice.keyboard.press('Escape')
    })

    await test.step('alice sees the request as sent (live)', async () => {
      await expect(alice.getByText('Access requested')).toBeVisible({ timeout: WORKFLOW_TIMEOUT })
    })

    await test.step('bob sees the incoming request on alice’s card (live)', async () => {
      await expect(access).not.toHaveClass(DISABLED, { timeout: WORKFLOW_TIMEOUT })
      await access.click()
      await expect(bob.page).toHaveURL(/\/authorize\?/)
    })

    await test.step('bob reviews the needs and authorizes', async () => {
      // the needs come from the request's embedded group (Project + Task)
      await expect(bob.page.getByText('Project').first()).toBeVisible({ timeout: WORKFLOW_TIMEOUT })
      const authorize = bob.page.getByRole('button', { name: 'Authorize' })
      await expect(authorize).toBeEnabled()
      await authorize.click()
      // once the AuthorizationGranted activity is claimed the app routes
      // (client-side, no reload) back to the Peers list
      await expect(bob.page).toHaveURL(/\/social-agents/, { timeout: WORKFLOW_TIMEOUT })
    })

    await test.step('bob’s request badge clears (live)', async () => {
      await expect(aliceCard).toBeVisible()
      await expect(access).toHaveClass(DISABLED, { timeout: WORKFLOW_TIMEOUT })
    })

    await test.step('alice sees bob’s data (live)', async () => {
      // still on Bob's data page: a data registry from Bob replaces the
      // "Access requested" card once the grant reaches her
      await expect(alice.locator('.v-expansion-panel').first()).toBeVisible({
        timeout: WORKFLOW_TIMEOUT,
      })
      await expect(alice.getByText('Access requested')).toHaveCount(0)
    })
  } finally {
    await bob.close()
  }
})
