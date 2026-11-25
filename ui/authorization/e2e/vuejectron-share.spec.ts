import { expect, test } from '@playwright/test'
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'

import type { Account } from './support'
import { AGENT_IDS, AUTH_ORIGIN, VUEJECTRON_URL, attachDiagnostics, signIn } from './support'

// Share from the demo app (`examples/vuejectron`, the stack's `test-client`
// application), the browser counterpart of test/share.test.ts extended with an
// inherited Task share: alice shares a project from her vuejectron session, the
// app redirects her to the authorization UI where she picks kim and read access
// for the project and its tasks, and the shared project and its tasks show up in
// kim's own vuejectron session.
//
// Seed (environments/data/registry.trig): both agents hold an application
// registration, a DataAuthorization and a grant for the test client, so both
// can sign in to the app; alice↔kim are reciprocal peers, so the grant alice
// writes is mirrored into kim's registry and projected onto her application
// registration by the delegated-grants workflow.
//
// The auth service serves the OIDC interaction as the CSS `/.account/` JSON API
// (its HTML views are disabled), so the sign-in helper below drives that API
// from the auth page the app navigated to — the same steps test/oidc-client.ts
// runs in Node, but with the browser's seeded account + interaction cookies.

const WORKFLOW_TIMEOUT = 60_000
const FIRST_LOAD_TIMEOUT = 30_000

interface Actor {
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

interface InteractionControls {
  oidc: { webId: string; consent: string }
}

interface InteractionResponse {
  status: number
  body: { controls?: InteractionControls; location?: string }
}

/**
 * Complete the authorization-code interaction the app just started: pick the
 * agent's WebID and consent. Returns the client redirect URL to hand back to
 * the app (the app exchanges the code for its session).
 */
async function completeOidcInteraction(page: Page, webId: string): Promise<string> {
  const redirect = await page.evaluate(
    async ({ webId }): Promise<string | undefined> => {
      const call = async (url: string, body?: unknown): Promise<InteractionResponse> => {
        const response = await fetch(url, {
          method: body ? 'POST' : 'GET',
          credentials: 'include',
          headers: body ? { 'content-type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        })
        return { status: response.status, body: await response.json() }
      }
      const index = await call('/.account/')
      const controls = index.body.controls
      if (!controls) {
        throw new Error('the auth service returned no interaction controls')
      }
      // The seeded `css-account` cookie already identifies the account; assigning
      // the WebID is the login half of the interaction, consent the other.
      const picked = await call(controls.oidc.webId, { webId })
      if (picked.status !== 200 || !picked.body.location) {
        throw new Error(`OIDC pick-webid failed: ${picked.status} ${JSON.stringify(picked.body)}`)
      }
      // The consent handler needs the interaction updated with the chosen WebID.
      const resumed = await fetch(picked.body.location, { credentials: 'include' })
      if (!resumed.ok) {
        throw new Error(`OIDC interaction resume failed: ${resumed.status}`)
      }
      const consented = await call(controls.oidc.consent, { remember: true })
      if (consented.status !== 200) {
        throw new Error(
          `OIDC consent failed: ${consented.status} ${JSON.stringify(consented.body)}`
        )
      }
      return consented.body.location
    },
    { webId }
  )
  if (!redirect) {
    throw new Error('the OIDC interaction returned no client redirect')
  }
  return redirect
}

/** Sign the app in through the OP's authorization-code flow. */
async function signInVuejectron(page: Page, webId: string): Promise<void> {
  await page.goto(VUEJECTRON_URL)
  await page.getByRole('button', { name: 'Login' }).click()
  // the OP's interaction entry (CSS's `/.account/` JSON API)
  await page.waitForURL(
    (url) => url.origin === new URL(AUTH_ORIGIN).origin && url.pathname.startsWith('/.account'),
    { timeout: FIRST_LOAD_TIMEOUT }
  )
  const redirect = await completeOidcInteraction(page, webId)
  await page.goto(redirect)
  await page.waitForURL((url) => !url.pathname.startsWith('/redirect'), {
    timeout: FIRST_LOAD_TIMEOUT,
  })
}

/**
 * A second, isolated browser for one actor. Service workers stay enabled: the
 * app's dashboard awaits `navigator.serviceWorker.ready` for its push
 * subscription, so blocking them would leave the view blank.
 */
async function newVuejectronActor(
  browser: Browser,
  testInfo: TestInfo,
  account: Extract<Account, 'alice' | 'kim'>
): Promise<Actor> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    recordVideo: { dir: testInfo.outputPath(`${account}-video`) },
  })
  // the seeded CSS account cookie and the app's own OIDC session both come from
  // the same account
  await signIn(context, account)
  const page = await context.newPage()
  await attachDiagnostics(page, testInfo, account)
  await signInVuejectron(page, AGENT_IDS[account])
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

test('alice shares a project from vuejectron, kim sees it in her session', async ({
  browser,
}, testInfo) => {
  // sign-in round trips, the share workflow, the mirror sync and the
  // delegated-grants workflow on kim's side
  test.setTimeout(4 * WORKFLOW_TIMEOUT)

  const aliceActor = await newVuejectronActor(browser, testInfo, 'alice')
  const kimActor = await newVuejectronActor(browser, testInfo, 'kim')
  const alice = aliceActor.page
  const kim = kimActor.page
  const appOrigin = new URL(VUEJECTRON_URL).origin

  try {
    // ── alice: her own data → a project → the app-bar share action ──
    const aliceLink = alice.getByRole('link', { name: 'Alice' })
    await expect(aliceLink).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    await aliceLink.click()
    await expect(alice).toHaveURL(/\/agent\?/, { timeout: FIRST_LOAD_TIMEOUT })

    // scope to the project links: during the page transition the previous
    // page's links are still in the DOM
    const project = alice.locator('.v-list-item a[href*="project="]').first()
    await expect(project).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    const projectTitle = (await project.innerText()).trim()
    await project.click()
    await expect(alice).toHaveURL(/\/project\?/, { timeout: FIRST_LOAD_TIMEOUT })

    // the tasks the project references, read through alice's own Task grant;
    // kim must see the same cards once the inherited Task share lands
    const taskCards = alice.locator('.v-card-title')
    await expect(taskCards.first()).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    const taskTitles = (await taskCards.allInnerTexts()).map((title) => title.trim())
    expect(taskTitles.length).toBeGreaterThan(0)

    await alice.locator('.v-app-bar .mdi-share-variant').click()
    await expect(alice).toHaveURL(/\/authorize\?/, { timeout: FIRST_LOAD_TIMEOUT })

    // ── the authorization UI: read access for kim, inherited by the tasks ──
    const shareCard = alice.locator('.v-card').filter({ hasText: 'Select peers' })
    await expect(shareCard).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    // the first selector is the project's; the child shape trees have their own
    await shareCard.locator('.mdi-eye-outline').first().click()
    const tasksRow = shareCard.locator('.v-list-item').filter({ hasText: 'Tasks' })
    await tasksRow.locator('.mdi-eye-outline').click()
    await shareCard.getByText('Kim', { exact: true }).click()
    const share = shareCard.getByRole('button', { name: 'Share', exact: true })
    await expect(share).toBeEnabled()
    await share.click()

    // the RPC answers with the client's callback endpoint (https://test-client)
    await alice.waitForURL((url) => url.origin === appOrigin, { timeout: WORKFLOW_TIMEOUT })

    // ── kim: the live update, no reload ──
    // The grant write → kim's reciprocal mirror sync → her delegated-grants
    // workflow → the app-registration PATCH arrive as a registry notification on
    // kim's open page: `handleRegistrationChange` re-reads the registration and
    // the agent list, and Main.vue toasts the new peer. Follow the toast's Show
    // action into alice's data instead of reloading.
    const updateToast = kim.locator('.v-snackbar').filter({ hasText: 'Data from new peer' })
    await expect(updateToast).toContainText('Alice', { timeout: WORKFLOW_TIMEOUT })
    await updateToast.getByRole('button', { name: 'Show' }).click()

    await expect(kim).toHaveURL(/\/agent\?agent=/, { timeout: FIRST_LOAD_TIMEOUT })
    const sharedProject = kim.getByRole('link', { name: projectTitle })
    await expect(sharedProject).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    await sharedProject.click()
    await expect(kim).toHaveURL(/\/project\?/, { timeout: FIRST_LOAD_TIMEOUT })
    await expect(kim.locator('body')).toContainText(projectTitle)
    // the inherited Task grant makes the same task cards readable
    await expect(kim.locator('.v-card-title')).toHaveText(taskTitles, {
      timeout: WORKFLOW_TIMEOUT,
    })
  } finally {
    await aliceActor.close()
    await kimActor.close()
  }
})
