import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./setup.ts'],
    testTimeout: 60_000,
    // setup.ts's beforeEach waits for the previous test's Temporal workflows to
    // settle (the delegated-grants cascade after a PATCH runs ~10s, longer on a
    // loaded runner) and then re-seeds the fixtures. Keep this above the
    // barrier's own 60s bound so an unquiesced namespace fails with the
    // workflow ids instead of an opaque HookTimeoutError.
    hookTimeout: 90_000,
  },
})
