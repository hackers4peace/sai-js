import { configureTokenCapture } from '@janeirodigital/interop-utils'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { StackContextManager, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

import type { RuntimeConfig } from './runtime-config'

/**
 * Browser tracing for the app (`docs/opentelemetry.md`, the UI half is
 * `ui/authorization/src/tracing.ts`).
 *
 * Everything is driven by `tracing` in the deployment's `config.json`:
 * `enabled` turns the SDK on, `otlpBaseUrl` is the collector base (a path is
 * resolved against the page origin, so `/otlp` posts same-origin — Tempo's
 * receiver sends no CORS headers; traefik strips the prefix), and
 * `propagateTo` lists the origin regexes that receive the W3C `traceparent`
 * header (the SAI servers reflect it in their CORS preflight).
 *
 * Two spans make the LWS chain readable from the browser:
 * `sai.lws.request-id-token` (mint, `packages/lws-auth`), the two exchange
 * spans (`request-id-jag`, `exchange-access-token`) and the `HTTP` span created
 * by the fetch instrumentation. Their `traceparent` is what links the server
 * spans (`/sai/id-token`, `/.well-known/lws/token`, …) into one trace.
 *
 * `StackContextManager`, not `ZoneContextManager`: the app targets ESNext, so
 * `await` is native and zone.js cannot carry the context across it. The LWS
 * client captures the span at the synchronous call site and re-enters it around
 * the actual fetch (see `packages/lws-auth/src/{tokens,session}.ts`).
 */

/** The key `packages/utils/src/tracing/shared.ts` publishes its provider under. */
const TRACER_PROVIDER_KEY: symbol = Symbol.for('sai.otel.tracerProvider')

const DEFAULT_PROPAGATE_TO = ['^https://[^/]*\\.docker/']

export function initTracing(config: RuntimeConfig): void {
  const tracing = config.tracing
  if (!tracing?.enabled) return

  // The `sai.lws.*` client spans record bodies/claims only when the deployment
  // asks for them (`OTEL_CAPTURE_*` is the server-side equivalent).
  configureTokenCapture({
    tokens: tracing.captureTokens,
    bodies: tracing.captureBodies,
  })

  const base = tracing.otlpBaseUrl ?? '/otlp'
  const tracesUrl = new URL(
    `${base.replace(/\/$/u, '')}/v1/traces`,
    window.location.origin
  ).toString()

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: tracing.serviceName ?? 'sai-vuejectron',
      [ATTR_SERVICE_VERSION]: '0.1.0',
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl }), {
        scheduledDelayMillis: 1_000,
      }),
    ],
  })

  provider.register({
    contextManager: new StackContextManager(),
    propagator: new W3CTraceContextPropagator(),
  })

  // `packages/lws-auth` asks `@janeirodigital/interop-utils` for its tracer;
  // publishing the provider here keeps the LWS client spans (`withSpan`) on the
  // same provider even when the browser bundle has more than one copy of the
  // API package (the workspace and npm builds).
  ;(globalThis as Record<symbol, unknown>)[TRACER_PROVIDER_KEY] = provider

  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        // The exporter itself must not be traced (or it would export itself).
        ignoreUrls: [/\/v1\/traces(?:\?|$)/u],
        propagateTraceHeaderCorsUrls: (tracing.propagateTo ?? DEFAULT_PROPAGATE_TO).map(
          (pattern) => new RegExp(pattern, 'u')
        ),
        clearTimingResources: true,
      }),
    ],
  })

  // Batch spans would be lost on navigation/reload without a flush.
  window.addEventListener('pagehide', () => {
    void provider.forceFlush()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void provider.forceFlush()
  })
}
