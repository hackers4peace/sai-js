import { defineConfig, devices } from '@playwright/test'

// Runs against the dev stack (`make up`): the UI is served by the `ui` compose
// service behind traefik at https://ui.auth.docker and talks to the
// authorization agent at https://auth.docker (public/config.json).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // one shared, stateful stack (seeded once per run) — run files serially,
  // like the vitest integration suite (`--no-file-parallelism`). Two files
  // starting at once made the registry answer 500 for both users' pods.
  workers: 1,
  // the first screens of a run hit a cold stack (registry/data pods, Fuseki):
  // the authorization list took > 5s (the default) on GitHub runners
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.UI_BASE_URL ?? 'https://ui.auth.docker',
    // dev certificates come from mkcert; the CA may not be in Playwright's store
    ignoreHTTPSErrors: true,
    // record every test, passing or not: the HTML report is published as the
    // "journeys" page (https://sai.js.org/journeys/), so each step is viewable
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // `ignoreHTTPSErrors` does not cover the service worker script fetch:
        // with an untrusted cert the SW never registers, and Dashboard's
        // `navigator.serviceWorker.ready` (push subscription) never resolves,
        // leaving every dashboard view blank.
        launchOptions: { args: ['--ignore-certificate-errors'] },
      },
    },
  ],
})
