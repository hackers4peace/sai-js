'use strict'

/**
 * Synchronous CJS side-effect bootstrap for CSS servers (no app-level
 * entrypoint we own). Usage:
 *
 *   node --require /sai/packages/components/src/tracing/preload.cjs <css-server.js>
 *
 * MUST use a *preload* (not an import): it runs synchronously before the main
 * module, so the http instrumentation patches `http.Server.prototype.emit`
 * before CSS builds its server. Nothing outside our compose/dagger command
 * lines adds this.
 */
const hardDisabled =
  process.env.OTEL_SDK_DISABLED === 'true' || process.env.OTEL_TRACES_EXPORTER === 'none'
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
// dagger overrides OTEL_EXPORTER_OTLP_ENDPOINT with its own telemetry endpoint,
// so our collector endpoint travels in this dedicated var and is passed to the
// exporter explicitly (see bootstrap.ts)
const saiEndpoint = process.env.SAI_OTLP_ENDPOINT
if (!hardDisabled && (saiEndpoint || otlpEndpoint)) {
  try {
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
    const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici')
    const { resourceFromAttributes } = require('@opentelemetry/resources')
    const { NodeSDK } = require('@opentelemetry/sdk-node')
    const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
    const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions')

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'sai-uas'

    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })
    // headers → span attributes: the subset the diagram http blocks care
    // about — auth/type headers + the discovery Link. TEST/CI only:
    // cookie/authorization carry real session tokens; keep this OFF unless
    // the collector is ours (OTEL_CAPTURE_HEADERS=true, dagger test env).
    const requestHeaders = [
      'authorization',
      'cookie',
      'content-type',
      'accept',
      'if-none-match',
      'link',
    ]
    const responseHeaders = ['link', 'content-type', 'location', 'vary']
    // Headers only when the caller opts in (OTEL_CAPTURE_HEADERS=true — the
    // dagger test collector sets it): authorization/cookie carry real session
    // tokens, so never send them to an unrelated collector. undici takes a
    // DIFFERENT shape than http.
    const captureHeaders = process.env.OTEL_CAPTURE_HEADERS === 'true'
    const headersToSpanAttributes = captureHeaders
      ? {
          client: { requestHeaders, responseHeaders },
          server: { requestHeaders, responseHeaders },
        }
      : undefined
    const undiciHeadersToSpanAttributes = captureHeaders
      ? { requestHeaders, responseHeaders }
      : undefined
    // SimpleSpanProcessor (NOT batch): dagger kills the service right after
    // the test exec — batch would lose tail spans. The exporter is handed
    // SAI_OTLP_ENDPOINT explicitly — the dagger engine injects standard OTLP
    // env (OTEL_EXPORTER_OTLP_ENDPOINT/_TRACES_EXPORTER) into exec containers
    // for its own telemetry, so letting it read those would silently ship our
    // spans to their collector. Unset saiEndpoint → falls back to the
    // standard vars (compose dev loop -> the tempo service).
    const spanProcessor = new SimpleSpanProcessor(
      new (require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter)(
        saiEndpoint ? { url: `${saiEndpoint}/v1/traces` } : undefined
      )
    )
    // cross-realm holder — read by temporal/client.ts in this same process
    globalThis[Symbol.for('sai.otel.temporalPluginConfig')] = { resource, spanProcessor }

    // registry/data/id re-query the SPARQL store for every operation (91% of
    // sai-registry spans and 50% of sai-id = its own sparql POSTs) — skip
    // those client spans in those processes only; sai-uas keeps them
    // (diagram [Data]/[Grant] hops)
    const skipSparqlStoreSpans = ['sai-registry', 'sai-data', 'sai-id'].includes(
      process.env.OTEL_SERVICE_NAME
    )

    const sdk = new NodeSDK({
      resource,
      spanProcessors: [spanProcessor],
      instrumentations: [
        new HttpInstrumentation({
          headersToSpanAttributes,
          ignoreOutgoingRequestHook: (options) =>
            skipSparqlStoreSpans && `${options.hostname ?? options.host ?? ''}`.includes('sparql'),
        }),
        new UndiciInstrumentation({
          headersToSpanAttributes: undiciHeadersToSpanAttributes,
          ignoreRequestHook: (request) => skipSparqlStoreSpans && request.origin.includes('sparql'),
        }),
      ],
    })
    sdk.start()

    // CSS loads the components of this package as ESM, and the provider lookup
    // through `@opentelemetry/api`'s global registry does not reliably reach the
    // SDK registered here — spans created through that proxy were never passed to
    // the span processor (observed on the `sai.lws.issue-id-jag` span while the
    // HTTP instrumentation spans, which get the provider directly, did export).
    // Publish this SDK's own provider on the bridge `otel-state.ts` reads, so
    // `sharedTracer(name)` always returns a tracer whose spans flow through the
    // processor/exporter configured above. The provider is read off the SDK
    // (it is set by `NodeSDK.start()` whenever span processors are configured,
    // which ours always are); the API lookup is only a fallback.
    globalThis[Symbol.for('sai.otel.tracerProvider')] =
      sdk._tracerProvider ?? require('@opentelemetry/api').trace.getTracerProvider()

    // Payload capture (bodies + parsed JWKS) for this CJS process; a no-op
    // unless `OTEL_CAPTURE_BODIES=true`.
    require('./http-capture.cjs').installHttpCapture()
  } catch (err) {
    // fail-soft: telemetry must never break the application
    console.warn(
      `[otel] failed to start OpenTelemetry for ${process.env.OTEL_SERVICE_NAME ?? 'sai-uas'}:`,
      err
    )
  }
}
