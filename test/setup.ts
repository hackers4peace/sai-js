import { initNodeTracing } from '@elfpavlik/sai-components'
import { context, trace } from '@opentelemetry/api'
import type { Context, Span } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'

import { prepareTestSeed } from './seed'

// opt-in OpenTelemetry: a no-op unless an OTLP endpoint (SAI_OTLP_ENDPOINT in
// the dagger test env) is set. The test runner plays the browser/App role —
// this process holds the trace roots.
const otelSdk = await initNodeTracing('sai-test')

// seeding/teardown is harness I/O, not part of any interaction — keep it out
// of the traces (iso a no-op when no SDK/instrumentation is active)
const withoutTracing = <T>(fn: () => Promise<T>): Promise<T> =>
  context.with(suppressTracing(context.active()), fn)

// per-test root span: each test gets a named root so client/server children
// nest under it. `context.attach` is not on the public ContextAPI facade in
// @opentelemetry/api 1.9, but the registered context manager
// (AsyncHooksContextManager after SDK start) implements attach/detach —
// reached via the private _getContextManager, guarded for when no SDK runs.
type Scope = unknown
let rootToken: Scope | undefined
let rootSpan: Span | undefined

function attachContext(ctx: Context): Scope | undefined {
  const manager = (
    context as unknown as { _getContextManager(): { attach(c: Context): Scope } | undefined }
  )._getContextManager?.()
  return manager?.attach?.(ctx)
}

function detachContext(scope: Scope | undefined): void {
  if (scope === undefined) {
    return
  }
  const manager = (
    context as unknown as { _getContextManager(): { detach(s: Scope): void } | undefined }
  )._getContextManager?.()
  manager?.detach?.(scope)
}

beforeEach((ctx) => {
  detachContext(rootToken)
  const span = trace.getTracer('sai-test').startSpan(ctx.task?.name ?? 'test')
  rootToken = attachContext(trace.setSpan(context.active(), span))
  rootSpan = span
})

afterEach(() => {
  detachContext(rootToken)
  rootToken = undefined
  rootSpan?.end()
  rootSpan = undefined
})

// buildSessionManager()'s lazy per-pod endpoint store reads this env var to
// resolve the session's registry-pod endpoint
process.env.CSS_POSTGRES_CONNECTION_STRING ??= 'postgres://temporal:temporal@postgresql:5432/auth'

const testSeed = await prepareTestSeed()

beforeAll(async () => {
  await withoutTracing(() => testSeed.putClientId())
})
afterAll(async () => {
  await withoutTracing(() => testSeed.deleteClientId())
  // flush the trace root before vitest exits: the root span ends in the very
  // last afterEach, and SimpleSpanProcessor's OTLP export is fire-and-forget
  // (the HTTP POST completes asynchronously). NodeSDK.shutdown() flushes the
  // processors and the exporter awaits its in-flight sends before tearing
  // down (same pattern the worker has, packages/components/src/workers/main.ts).
  // Without it the process exit kills the request and the dump lands without
  // a root span.
  try {
    await otelSdk?.shutdown()
  } catch (err) {
    console.warn('[otel] runner shutdown error:', err)
  }
})
beforeEach(async () => {
  await withoutTracing(() => testSeed.seed())
})
