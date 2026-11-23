import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import { UI_BASE_URL, attachDiagnostics, newActor, signIn } from './support'

// UI counterpart of test/invitation.test.ts "personal invitation": Dan invites
// Kim and Kim accepts, each in their own browser with their own session.
// dan↔kim has NO seeded relationship in registry.trig, so the accept runs the
// full chain (createInvitation, acceptInvitation and establishReciprocal
// workflows). Both lists update live from the activity event stream, so the
// waits are generous: they cover the Temporal workflows, not the UI.

const WORKFLOW_TIMEOUT = 60_000

/** A card on the Peers page by its title (invitations and peers are both cards). */
function card(page: Page, title: string): Locator {
  return page.locator('.v-card').filter({
    has: page.locator('.v-card-title', { hasText: new RegExp(`^${title}$`) }),
  })
}

test('dan invites kim, kim accepts — both see each other as peers', async ({
  browser,
  context: danContext,
  page: dan,
}, testInfo) => {
  // three workflow round trips (create, accept, establish reciprocal)
  test.setTimeout(3 * WORKFLOW_TIMEOUT)

  // ── Dan: default browser context of the test ──
  await attachDiagnostics(dan, testInfo, 'dan')
  await signIn(danContext, 'dan')
  // "Copy link" writes to the clipboard; the test reads the link back from it
  await danContext.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: UI_BASE_URL,
  })

  // ── Kim: a second, isolated browser context (own cookies/storage) ──
  const kimActor = await newActor(browser, testInfo, 'kim')
  const kim = kimActor.page

  try {
    await test.step('dan creates an invitation for kim', async () => {
      await dan.goto('/social-agents')
      await dan.locator('#add').click()
      await dan.getByText('Create invitation').click()
      await expect(dan).toHaveURL(/\/invitation\?direction=create/)
      await dan.getByLabel('Label').fill('Kim')
      await dan.getByLabel('Note').fill('Some note')
      await dan.getByRole('button', { name: 'Create invitation' }).click()
      await expect(dan).toHaveURL(/\/social-agents/)
    })

    const capabilityUrl = await test.step('dan copies the invitation link', async () => {
      // the createInvitation workflow PUTs the invitation; its done event
      // refreshes the list and the card appears with the link
      const invitation = card(dan, 'Kim')
      await expect(invitation).toBeVisible({ timeout: WORKFLOW_TIMEOUT })
      await expect(invitation).toContainText('Some note')
      await invitation.getByRole('button', { name: 'Copy link' }).click()
      const link = await dan.evaluate(() => navigator.clipboard.readText())
      expect(link).toMatch(/^https:\/\//)
      return link
    })

    await test.step('kim accepts the invitation', async () => {
      await kim.goto('/social-agents')
      await kim.locator('#add').click()
      await kim.getByText('Accept invitation').click()
      await expect(kim).toHaveURL(/\/invitation\?direction=accept/)
      await kim.getByLabel('Invitation link').fill(capabilityUrl)
      await kim.getByLabel('Label').fill('Dan')
      await kim.getByLabel('Note').fill('Beep boop')
      await kim.getByRole('button', { name: 'Accept invitation' }).click()
      await expect(kim).toHaveURL(/\/social-agents/)
    })

    await test.step('kim sees dan as a peer', async () => {
      const peer = card(kim, 'Dan')
      await expect(peer).toBeVisible({ timeout: WORKFLOW_TIMEOUT })
      // a peer card (not an invitation): it links to the peer's data
      await expect(peer.getByRole('link', { name: 'Data' })).toBeVisible()
    })

    await test.step('dan sees kim as a peer', async () => {
      const peer = card(dan, 'Kim').filter({ has: dan.getByRole('link', { name: 'Data' }) })
      await expect(peer).toBeVisible({ timeout: WORKFLOW_TIMEOUT })
    })
  } finally {
    await kimActor.close()
  }
})
