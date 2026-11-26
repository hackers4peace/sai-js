import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'

import { expect, reseedFixtures, test } from './fixtures'
import type { Account } from './support'
import {
  ACCOUNT_EMAILS,
  AUTH_ORIGIN,
  PASSWORD,
  UI_BASE_URL,
  VUEJECTRON_URL,
  attachDiagnostics,
  signIn,
  watchActivityDone,
} from './support'

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
// The authorization UI is the stack's OIDC interaction route
// (`CSS_AUTHORIZATION_ENDPOINT`): the app's Login redirects the browser there,
// and the UI completes the authorization-code interaction — sign in with the
// seeded account cookie or email + password, pick the WebID, consent. The
// authorization screen is therefore the login interaction itself; no separate
// authorization request from the app is involved.

const WORKFLOW_TIMEOUT = 60_000
const FIRST_LOAD_TIMEOUT = 30_000

interface Actor {
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

/**
 * Sign the app in with the seeded account cookie. The app's Login lands on the
 * authorization UI's interaction resolver; with an account session the UI
 * finds the app's registration and completes the interaction from its Sign In
 * button.
 */
async function signInVuejectron(page: Page): Promise<void> {
  const appOrigin = new URL(VUEJECTRON_URL).origin
  const uiOrigin = new URL(UI_BASE_URL).origin
  await page.goto(VUEJECTRON_URL)
  await page.getByRole('button', { name: 'Login' }).click()
  await page.waitForURL((url) => url.origin === uiOrigin && url.pathname === '/authorize', {
    timeout: FIRST_LOAD_TIMEOUT,
  })
  // a registered app: the UI only needs the consent, not a needs review
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  // the consent redirects to the app's /redirect; the router replaces it with
  // the restore path before the load event, so only the origin is observable
  await page.waitForURL((url) => url.origin === appOrigin, { timeout: FIRST_LOAD_TIMEOUT })
}

/**
 * A second, isolated browser for one actor, with no session yet. Service
 * workers stay enabled: the app's dashboard awaits
 * `navigator.serviceWorker.ready` for its push subscription, so blocking them
 * would leave the view blank.
 */
async function newVuejectronContext(
  browser: Browser,
  testInfo: TestInfo,
  name: string
): Promise<Actor> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    recordVideo: { dir: testInfo.outputPath(`${name}-video`) },
  })
  const page = await context.newPage()
  await attachDiagnostics(page, testInfo, name)
  return {
    context,
    page,
    async close() {
      await context.close()
      const video = await page.video()?.path()
      if (video) {
        await testInfo.attach(`${name} video`, { path: video, contentType: 'video/webm' })
      }
    },
  }
}

/** A browser signed in to the app with the seeded account cookie. */
async function newVuejectronActor(
  browser: Browser,
  testInfo: TestInfo,
  account: Extract<Account, 'alice' | 'dan' | 'kim'>
): Promise<Actor> {
  const actor = await newVuejectronContext(browser, testInfo, account)
  // the seeded CSS account cookie and the app's own OIDC session both come from
  // the same account
  await signIn(actor.context, account)
  await signInVuejectron(actor.page)
  return actor
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
// authorization flow — reach the authorization screen, review the needs,
// authorize — and then wait for the grant generation and the registration
// projection to reach it. Two variants:
//
// - no session: the app's Login reaches the authorization UI, which sends the
//   browser to /login; the email + password login resumes the OIDC interaction
//   onto the authorization screen;
// - a seeded account cookie (the auth UI session): Login lands on the
//   authorization screen directly.
//
// Seed (environments/data/registry.trig): Dan owns two data pods — `dan-east`
// ("Hydra", "Nimbus") and `dan-west` ("Vega") with two Tasks each — and holds
// NO `test-client` application registration, exactly like a first-time user.
// Both of his peers (Bob, YoYo) registered Dan without granting him any of
// their data, so he is the only data owner on the screen.
//
// The authorization is `AllFromAgent` (the per-agent scope inside the UI's
// "Selected data" toggle): one data authorization for Project, inherited by
// Task, so every project in BOTH pods and their tasks become readable — the
// grants are generated per data registration after the redirect back.
//
// `e2e/fixtures.ts` re-seeds the KV + Fuseki fixture before every test and
// waits for the SAI worker queues to drain; each test also waits for the
// `AuthorizationGranted` done row, so the grant generation and registration
// projection cannot leak into the next test.

/**
 * Reach the authorization screen through the app's Login. The fixture's
 * Temporal barrier covers workflows that started before the seed; one that
 * starts later (a delayed webhook follow-up) can still leave the app
 * registered, in which case the UI offers the consent-only Sign In instead of
 * the needs. Re-create the fixture and start the login over; the account
 * cookie survives the registry reset, so the retry may skip the /login form.
 */
async function reachNeedsScreen(actor: Actor, login: () => Promise<void>): Promise<void> {
  const app = actor.page
  const needs = app.getByText('Project').first()
  const appSignIn = app.getByRole('button', { name: 'Sign In', exact: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    await login()
    const visible = await needs
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (visible) {
      return
    }
    if (!(await appSignIn.isVisible().catch(() => false))) {
      break
    }
    await reseedFixtures()
  }
  await expect(needs).toBeVisible({ timeout: WORKFLOW_TIMEOUT })
}

/**
 * Review Dan's needs on the authorization UI, authorize, and wait for the app
 * to load the three projects and their tasks. Subscribes to the
 * `AuthorizationGranted` activity before the click: the data can appear before
 * the workflow writes its done row.
 */
async function authorizeDan(actor: Actor): Promise<void> {
  const app = actor.page
  const appOrigin = new URL(VUEJECTRON_URL).origin
  await expect(app).toHaveURL(/\/authorize/, { timeout: FIRST_LOAD_TIMEOUT })
  await expect(app.getByText('Project').first()).toBeVisible({ timeout: WORKFLOW_TIMEOUT })

  // Keep a page on the auth origin subscribed to the activity stream while the
  // main page authorizes and navigates back to the app. Use a public
  // well-known path: a `/.account/` visit would refresh the account cookie.
  const authPage = await actor.context.newPage()
  await authPage.goto(`${AUTH_ORIGIN}/.well-known/openid-configuration`)
  const { done } = await watchActivityDone(authPage, 'AuthorizationGranted')
  void done.catch(() => undefined)
  try {
    // grant ALL of Dan's own data — not all data: switching the top level to
    // the per-agent scope makes the single top-level Project authorization
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

    // The registration is visible before the workflow writes its completion;
    // wait for it so it cannot write after the next test's seed.
    await done
  } finally {
    await authPage.close()
  }
}

test('dan authorizes vuejectron for all his projects and tasks', async ({ browser }, testInfo) => {
  // sign-in round trips, the authorization workflow and the app's pull for
  // the registration + grants
  test.setTimeout(4 * WORKFLOW_TIMEOUT)

  const danActor = await newVuejectronContext(browser, testInfo, 'dan')
  const app = danActor.page
  const uiOrigin = new URL(UI_BASE_URL).origin

  try {
    // ── the app: login, then the authorization UI's sign-in screen ──
    // The interaction has no account session, so the UI's router guard sends
    // the browser to /login instead of showing an empty authorization screen.
    // A retry after a fixture reset may already have the account cookie and
    // land on /authorize directly.
    await reachNeedsScreen(danActor, async () => {
      await app.goto(VUEJECTRON_URL)
      await app.getByRole('button', { name: 'Login' }).click()
      await app.waitForURL((url) => url.origin === uiOrigin, { timeout: FIRST_LOAD_TIMEOUT })
      // the guard may still be redirecting from /authorize to /login
      const email = app.getByRole('textbox', { name: 'email' })
      const consent = app.getByRole('button', { name: /^(Authorize|Sign In)$/ })
      await expect(email.or(consent).first()).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT })
      if (!(await email.isVisible())) {
        return
      }
      await email.fill(ACCOUNT_EMAILS.dan)
      await app.getByRole('textbox', { name: 'password' }).fill(PASSWORD)
      await app.getByRole('button', { name: 'Sign In', exact: true }).click()
    })

    // the login response resumes the interaction onto the authorization screen
    await authorizeDan(danActor)
  } finally {
    await danActor.close()
  }
})

test('dan authorizes vuejectron with an existing auth session', async ({ browser }, testInfo) => {
  test.setTimeout(4 * WORKFLOW_TIMEOUT)

  const danActor = await newVuejectronContext(browser, testInfo, 'dan')
  const app = danActor.page
  const uiOrigin = new URL(UI_BASE_URL).origin

  try {
    // ── the seeded account cookie is the auth UI session: Login lands on the
    // authorization screen directly, with no /login step ──
    await signIn(danActor.context, 'dan')
    await reachNeedsScreen(danActor, async () => {
      await app.goto(VUEJECTRON_URL)
      await app.getByRole('button', { name: 'Login' }).click()
      await app.waitForURL((url) => url.origin === uiOrigin && url.pathname === '/authorize', {
        timeout: FIRST_LOAD_TIMEOUT,
      })
    })

    await authorizeDan(danActor)
  } finally {
    await danActor.close()
  }
})
