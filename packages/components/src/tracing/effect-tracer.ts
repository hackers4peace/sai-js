import { Resource, Tracer } from '@effect/opentelemetry'
import { context, trace } from '@opentelemetry/api'
import { Effect, Layer } from 'effect'
import type { Effect as EffectType } from 'effect/Effect'

import { temporalPluginConfig } from './otel-state.js'

/**
 * Effect→OpenTelemetry bridge: runs the RPC's Effect program with the SDK's
 * `EffectTracer` so each method's Effect spans (`@effect/rpc` wraps handlers
 * in `Effect.withSpan(spanPrefix + request._tag)`) are exported through OUR
 * spanProcessor and parented into the REAL trace.
 *
 * - `Tracer.layerGlobal` reuses the GLOBAL OTel tracer provider our NodeSDK
 *   registered (no second processor/resource).
 * - `Tracer.withSpanContext(activeOtelSpanContext)` re-parents the Effect
 *   root to the active OTel span (`sai.rpc.handle`) — @effect/rpc otherwise
 *   parents Effect spans to the ENVELOPE `traceId`/`spanId` (which ApiHandler
 *   rewrites to the real trace when tracing is recording).
 *
 * Gate: no-op unless tracing is active.
 */
export function withEffectTracing<A, E>(
  program: EffectType<A, E>,
  serviceName: string
): EffectType<A, E> {
  const config = temporalPluginConfig()
  if (!config) {
    return program
  }
  const layers = Layer.provide(Tracer.layerGlobal, Resource.layer({ serviceName }))
  const provided = Effect.provide(program, layers)
  const otelSpan = trace.getSpan(context.active())
  if (!otelSpan) {
    return provided
  }
  return Tracer.withSpanContext(otelSpan.spanContext())(provided)
}
