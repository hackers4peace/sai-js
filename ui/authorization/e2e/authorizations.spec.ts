import { expect, test } from '@playwright/test'

import { attachDiagnostics, signIn } from './support'

// UI counterpart of test/authorizations.test.ts (ListAuthorizations, C0): the
// read-only authorization listing for a peer, rendered by the Authorizations
// view, signed in as alice. Seeded in environments/data/registry.trig: alice's
// authorizations for bob — an AllFromRegistry parent (alice/p7n4qw) and its
// inherited child (alice/t5m8kr).
// Defaults target the compose dev stack (environments/dev/map.json:
// https://id/bob -> https://bob.id.docker); `dagger call playwright` sets the env to
// the in-engine hostnames (https://auth, https://id/bob).

const BOB_ID = process.env.BOB_ID ?? 'https://bob.id.docker'
const NOBODY_ID = process.env.NOBODY_ID ?? 'https://nobody.id.docker'

test.beforeEach(async ({ context, page }, testInfo) => {
  attachDiagnostics(page, testInfo)
  await signIn(context, 'alice')
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
