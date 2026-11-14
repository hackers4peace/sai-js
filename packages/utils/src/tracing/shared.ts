import type { Span, Tracer, TracerProvider } from '@opentelemetry/api'
import { SpanStatusCode, context, trace } from '@opentelemetry/api'

/**
 * Cross-realm tracer plumbing for the two ways tracing starts in this repo:
 *
 *  - CSS servers use the synchronous CJS preload (`packages/components/src/tracing/preload.cjs`),
 *  - the Temporal worker and the `/test` runner use the async ESM bootstrap
 *    (`initNodeTracing` in `packages/components/src/tracing/bootstrap.ts`).
 *
 * The preload publishes its provider on `globalThis` (see below) because CSS
 * loads the components of this repo as **ESM**: inside those modules the API's
 * global-registry lookup did not reach the provider the CJS SDK registered
 * (observed: a recording `SpanImpl` whose span never reached the span
 * processor), so ESM components ask for their tracer through
 * {@link sharedTracer} instead of `trace.getTracer`.
 */
const TRACER_PROVIDER_KEY: symbol = Symbol.for('sai.otel.tracerProvider')

/** Used by the CSS preload to publish the provider its SDK created. */
export function setSharedTracerProvider(provider: TracerProvider | undefined): void {
  ;(globalThis as Record<symbol, unknown>)[TRACER_PROVIDER_KEY] = provider
}

/**
 * Returns a tracer for `name`: the provider shared by the CSS preload when there
 * is one (CSS/`auth`/`data`/`registry`/`id` processes), the module-local API
 * otherwise (vitest, the Temporal worker bootstrap).
 */
export function sharedTracer(name: string): Tracer {
  const provider = (globalThis as Record<symbol, unknown>)[TRACER_PROVIDER_KEY] as
    | TracerProvider
    | undefined
  return provider ? provider.getTracer(name) : trace.getTracer(name)
}

/**
 * Runs `fn` inside a recording span that is **active** for the whole async body
 * (child client spans nest under it) and ends exactly once.
 *
 * Use this instead of `tracer.startActiveSpan(name, async (span) => …)`: with an
 * async callback that helper ends the span as soon as the callback returns its
 * promise, so every attribute set while awaiting is discarded and the exported
 * span has no duration and no payload.
 *
 * Thrown errors are recorded on the span (status `ERROR`) and re-thrown; use a
 * bespoke span when a failure is an expected protocol outcome (e.g. a 400).
 */
export async function withSpan<T>(
  tracerName: string,
  spanName: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const span = sharedTracer(tracerName).startSpan(spanName)
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span))
  } catch (error: unknown) {
    span.recordException(error as Error)
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  } finally {
    span.end()
  }
}
