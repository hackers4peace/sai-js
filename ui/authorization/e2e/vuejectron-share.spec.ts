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
  account: Extract<Account, 'alice' | 'dan' | 'kim'>
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

// A NEW agent: Dan has Projects and Tasks in his pods but no application
// registration for the test client, so vuejectron has to walk the whole
// authorization flow — request, review the needs, authorize — and then wait for
// the grant generation and the registration projection to reach it.
//
// Seed (environments/data/registry.trig): Dan owns two data pods — `dan-east`
// ("Hydra", "Nimbus") and `dan-west` ("Vega") with two Tasks each — and holds
// NO `test-client` application registration, exactly like a first-time user.
// Both of his peers (Bob, YoYo) registered Dan without granting him any of
// their data, so he is the only data owner on the screen. His account is seeded
// with a login cookie (`ACCOUNT_COOKIES.dan`), so the OIDC and authorization UI
// flows run as Dan.
//
// The authorization is `AllFromAgent` (the per-agent scope inside the UI's
// "Selected data" toggle): one data authorization for Project, inherited by
// Task, so every project in BOTH pods and their tasks become readable — the
// grants are generated per data registration after the redirect back.
test('dan authorizes vuejectron for all his projects and tasks', async ({ browser }, testInfo) => {
  // sign-in round trips, the authorization workflow and the app's pull for
  // the registration + grants
  test.setTimeout(4 * WORKFLOW_TIMEOUT)

  const danActor = await newVuejectronActor(browser, testInfo, 'dan')
  const app = danActor.page
  const appOrigin = new URL(VUEJECTRON_URL).origin

  try {
    // ── the app: no registration for the test client yet ──
    // The request screen is shown right away: this stack's OIDC interaction is
    // CSS's `/.account/` (not the authorization UI), so a login carries no grant
    // and the app only watches for one in the background. A unified deployment
    // sets `authorizationOnLogin` and waits on the login return instead (the
    // dev stack — see examples/vuejectron/public/config.json).
    const request = app.getByRole('button', { name: 'Request Authorization' })
    await expect(request).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
    await request.click()

    // ── the authorization UI: the app's needs from its client-id document ──
    await expect(app).toHaveURL(/\/authorize\?/, { timeout: FIRST_LOAD_TIMEOUT })
    await expect(app.getByText('Project').first()).toBeVisible({ timeout: WORKFLOW_TIMEOUT })

    // grant ALL of Dan's own data — not all data: switching the top level to the
    // per-agent scope makes the single top-level Project authorization
    // `AllFromAgent` (a data owner defaults to all of their own data), and the
    // Task need inherits from it
    const topPanel = app.locator('#panel-hell > .v-expansion-panel')
    await topPanel.locator('.v-expansion-panel-title').click()
    await topPanel
      .locator('.v-expansion-panel-text .v-btn-toggle')
      .first()
      .locator('.mdi-minus-box-outline')
      .click()
    // Dan is the only data owner on the screen; his panel now shows the
    // "all of it" selection
    const thisAgent = topPanel.locator('.v-expansion-panel-title').filter({ hasText: 'Me' })
    await expect(thisAgent.locator('.mdi-checkbox-marked')).toBeVisible({
      timeout: FIRST_LOAD_TIMEOUT,
    })
    const authorize = app.getByRole('button', { name: 'Authorize', exact: true })
    await expect(authorize).toBeEnabled()
    await authorize.click()

    // the authorization UI answers with the client's callback endpoint
    // (`hasAuthorizationCallbackEndpoint`, https://test-client)
    await app.waitForURL((url) => url.origin === appOrigin, { timeout: WORKFLOW_TIMEOUT })

    // ── back in the app BEFORE the grants exist: pull for updates ──
    // The redirect returns the browser to the app's callback endpoint as soon as
    // the authorization is recorded; the grant generation and the
    // application-registration projection (Temporal workflows) land after it.
    // Authn.vue therefore shows a waiting state and polls
    // `Application.refreshRegistration()` instead of asking to request the
    // authorization again; once the registration is granted the app routes to
    // the agent view with the data the agent just authorized.
    await expect(app).toHaveURL(/\/agent\?agent=/, { timeout: WORKFLOW_TIMEOUT })
    const projects = app.locator('.v-list-item a[href*="project="]')
    // one AllFromAgent authorization covers EVERY Project registration — in
    // both of Dan's pods
    await expect(projects).toHaveCount(3, { timeout: WORKFLOW_TIMEOUT })
    expect((await projects.allInnerTexts()).map((title) => title.trim()).sort()).toEqual([
      'Hydra',
      'Nimbus',
      'Vega',
    ])

    // the inherited Task grant makes a project's tasks readable
    await app.getByRole('link', { name: 'Nimbus' }).click()
    await expect(app).toHaveURL(/\/project\?/, { timeout: FIRST_LOAD_TIMEOUT })
    const tasks = app.locator('.v-card-title')
    await expect(tasks).toHaveCount(2, { timeout: WORKFLOW_TIMEOUT })
    expect((await tasks.allInnerTexts()).map((title) => title.trim()).sort()).toEqual(['D3', 'D5'])
  } finally {
    await danActor.close()
  }
})
