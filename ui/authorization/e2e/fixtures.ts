import { execFile, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { expect, test as base } from '@playwright/test'

// this file is transpiled to CommonJS by Playwright; __dirname is
// <repo>/ui/authorization/e2e
/** Run a child to completion and return its stdout. */
function run(file: string, args: Array<string>, options: { cwd: string }): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) {
        rejectRun(error)
      } else {
        resolveRun(stdout)
      }
    })
  })
}
const repoRoot = resolve(__dirname, '../../..')
/** `dagger call playwright` sets this; the host/dev run does not. */
const inDagger = !!process.env.SAI_TEMPORAL_READY
const cwd = inDagger ? '/sai' : repoRoot
const idleScript = inDagger
  ? '/sai/test/temporal-idle.ts'
  : resolve(repoRoot, 'test/temporal-idle.ts')

interface Seeder {
  seed(): Promise<void>
}

/** One line at a time from the seeder's stdout, queued until asked for. */
function lineReader(stream: NodeJS.ReadableStream): () => Promise<string> {
  const lines = createInterface({ input: stream })
  const queue: Array<string> = []
  const waiters: Array<(line: string) => void> = []
  lines.on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(line)
    } else {
      queue.push(line)
    }
  })
  return async () => {
    const line = queue.shift()
    if (line !== undefined) {
      return line
    }
    return new Promise((resolveLine) => {
      waiters.push(resolveLine)
    })
  }
}

let seeder: Promise<Seeder> | undefined

/**
 * Start the fixture seeder once per worker. It prepares the fixture (including
 * the per-pod Garage buckets/keys and their objectEndpoint records) and then
 * seeds the KV + Fuseki datasets on demand — the same prepare-once /
 * seed-per-test split as `test/setup.ts` for vitest. Re-preparing between tests
 * would mint new objectEndpoint records that the running services may not pick
 * up.
 */
function startSeeder(): Promise<Seeder> {
  const args = inDagger
    ? ['/sai/test/seed.ts', '--serve']
    : ['packages/repl/cmd.ts', '--', 'seed-serve']
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const nextLine = lineReader(child.stdout)
  return (async () => {
    const ready = await nextLine()
    if (ready !== 'test fixtures ready') {
      throw new Error(`fixture seeder did not start (got ${JSON.stringify(ready)})`)
    }
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`fixture seeder exited with ${code}`)
      }
    })
    return {
      async seed() {
        child.stdin.write('seed\n')
        const line = await nextLine()
        if (line !== 'test fixtures seeded') {
          throw new Error(`fixture seeder failed (got ${JSON.stringify(line)})`)
        }
      },
    }
  })()
}

async function seed(): Promise<void> {
  seeder ??= startSeeder()
  await (await seeder).seed()
}

/**
 * Block until Temporal has no running workflow and none that started since
 * `since`. Reports whether activity was observed: a workflow that started
 * after a seed (even one that already finished) invalidates that seed.
 */
async function temporalIdle(quietMs: number, since?: Date): Promise<boolean> {
  const args = [idleScript, String(quietMs), ...(since ? [since.toISOString()] : [])]
  const stdout = await run(process.execPath, args, { cwd })
  return stdout.includes('activity')
}

async function seedFixtures(): Promise<void> {
  // Seed, then verify that no workflow started after that seed. Any workflow
  // that did may have written to the stores after the seed (the registration
  // projection, a webhook follow-up), so seed again. `since` is taken before
  // the drain: a workflow that starts during the drain or the seed is counted
  // too, and the next attempt's `since` is after it.
  for (let attempt = 0; attempt < 6; attempt++) {
    const since = new Date()
    await temporalIdle(0)
    await seed()
    if (!(await temporalIdle(1000, since))) {
      return
    }
  }
  throw new Error('the fixture did not settle: workflows kept starting after the seed')
}

/**
 * Re-seed before EVERY test as an AUTOMATIC FIXTURE, not a module-level
 * `test.beforeEach`. Playwright binds a hook declared in an imported helper to
 * the first test file that loads that module (hooks are file-scoped at
 * collection time), so with `test.beforeEach` only ONE spec re-seeded per run;
 * every later spec (`vuejectron-share`, `invitation`, …) started on the
 * previous test's state — the earlier test's ApplicationRegistration was still
 * in `reg-<agent>`, so the authorization UI offered its consent-only "Sign In"
 * instead of the needs. A fixture belongs to the exported `test` object and
 * runs for every test of every file that imports it.
 */
export const test = base.extend<{ seed: void }>({
  seed: [
    // Playwright injects the fixture dependencies as the first argument and
    // REQUIRES it to be an object pattern; naming it (`_fixtures`) makes the
    // loader reject the file and collect 0 tests (all specs then import this
    // `test`), so the report published to /journeys/ is empty.
    // oxlint-disable-next-line no-empty-pattern -- the pattern is Playwright's signature, not a bug
    async ({}, use) => {
      await seedFixtures()
      await use()
    },
    { auto: true },
  ],
})
export { expect }
export { seedFixtures as reseedFixtures }
