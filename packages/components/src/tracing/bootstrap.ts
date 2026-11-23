import { createRequire } from 'node:module'

import type { NodeSDK } from '@opentelemetry/sdk-node'

import { setTemporalPluginConfig } from './otel-state.js'

/**
 * Opt-in OpenTelemetry bootstrap.
 *
 * Gate: our own `SAI_OTLP_ENDPOINT` wins over the standard OTLP env vars —
 * infra (incl. the dagger engine) sets `OTEL_EXPORTER_OTLP_ENDPOINT`/
 * `OTEL_TRACES_EXPORTER` globally on every container, so prioritizing them
 * would ship our spans into their collector. Hard-off:
 * `OTEL_SDK_DISABLED=true` / `OTEL_TRACES_EXPORTER=none`. When the gate is
 * closed no OpenTelemetry module is loaded (lazy imports).
 *
 * Async variant — only use where the caller awaits it before any network
 * activity (worker main.ts, test/setup.ts). CSS servers must use
 * `preload.cjs` via `--require` (sync): `--import`/TLA does not reliably
 * complete instrumentation registration before the main module runs.
 */
export async function initNodeTracing(serviceName: string): Promise<NodeSDK | undefined> {
  // hard-off: standard escape hatch
  if (process.env.OTEL_SDK_DISABLED === 'true' || process.env.OTEL_TRACES_EXPORTER === 'none') {
    return undefined
  }
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  // dagger injects its own OTEL_EXPORTER_OTLP_ENDPOINT into exec containers for
  // its telemetry, overriding ours, so our collector endpoint travels in this
  // dedicated var and is handed to the exporter explicitly (which is also what
  // stops the exporter from reading the injected standard vars).
  const saiEndpoint = process.env.SAI_OTLP_ENDPOINT
  if (!saiEndpoint && !otlpEndpoint) {
    return undefined
  }

  try {
    const [
      { NodeSDK },
      { SimpleSpanProcessor },
      { HttpInstrumentation },
      { UndiciInstrumentation },
      { resourceFromAttributes },
      { ATTR_SERVICE_NAME },
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-undici'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ])

    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })

    // headers → span attributes: the subset the diagram http blocks care
    // about — auth/type headers + the discovery Link. Only when the caller opts
    // in with OTEL_CAPTURE_HEADERS=true (the dagger test collector sets it):
    // cookie and authorization carry real session tokens, so never send them
    // to an unrelated OTLP collector.
    const requestHeaders = [
      'authorization',
      'cookie',
      'content-type',
      'accept',
      'if-none-match',
      'link',
    ]
    const responseHeaders = ['link', 'content-type', 'location', 'vary']
    const captureHeaders = process.env.OTEL_CAPTURE_HEADERS === 'true'
    const headersToSpanAttributes = captureHeaders
      ? {
          client: { requestHeaders, responseHeaders },
          server: { requestHeaders, responseHeaders },
        }
      : undefined
    // undici takes a DIFFERENT shape ({request,response}Headers) than http
    // ({client,server}); same gate.
    const undiciHeadersToSpanAttributes = captureHeaders
      ? { requestHeaders, responseHeaders }
      : undefined

    // SimpleSpanProcessor (NOT batch): dagger tears the bound services down
    // right after the test exec — batch would buffer and lose the tail spans.
    // The exporter is handed SAI_OTLP_ENDPOINT explicitly — the standard OTLP
    // env is set globally by infra (e.g. the dagger engine's own telemetry
    // injects OTEL_EXPORTER_OTLP_ENDPOINT/_TRACES_EXPORTER into exec
    // containers), so letting it read those would silently send our spans
    // into their collector. Unset saiEndpoint → the exporter falls back to
    // the standard vars (compose dev loop -> the tempo service).
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    const spanProcessor = new SimpleSpanProcessor(
      new OTLPTraceExporter(saiEndpoint ? { url: `${saiEndpoint}/v1/traces` } : undefined)
    )
    setTemporalPluginConfig({ resource, spanProcessor })

    const sdk = new NodeSDK({
      // resource + spanProcessors (not the traceExporter shorthand) — the
      // @temporalio/interceptors-opentelemetry-v2 plugin needs the same
      // processor instance to sink Workflow/Activity/Client spans into.
      resource,
      spanProcessors: [spanProcessor],
      instrumentations: [
        new HttpInstrumentation({ headersToSpanAttributes }),
        new UndiciInstrumentation({
          headersToSpanAttributes: undiciHeadersToSpanAttributes,
          // optional: skip long-lived streams (GET /.sai/events)
          // ignoreRequestHook: (request) => request.path === '/.sai/events',
        }),
      ],
    })
    sdk.start()
    // Payload capture (bodies + parsed JWKS): a no-op unless
    // `OTEL_CAPTURE_BODIES=true`. Resolved through `src/` because `.cjs` files
    // are not emitted into `dist`, and this path resolves to the same file from
    // both `dist/tracing/` and `src/tracing/`.
    createRequire(import.meta.url)('../../src/tracing/http-capture.cjs').installHttpCapture()
    return sdk
  } catch (err) {
    // fail-soft: telemetry must never break the application
    console.warn(`[otel] failed to start OpenTelemetry for ${serviceName}:`, err)
    return undefined
  }
}
