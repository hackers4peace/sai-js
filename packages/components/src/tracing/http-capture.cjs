'use strict'

/**
 * Generic HTTP payload capture for traces: request/response bodies and parsed
 * JWKS, on top of the header capture the instrumentations already do.
 *
 * Opt-in (`OTEL_CAPTURE_BODIES=true`, set by the Dagger `--tempo-endpoint` run):
 * buffering payloads costs memory and bodies can carry credentials, so only a
 * collector we control should receive them.
 *
 * Both ends of the LWS chain are covered:
 *  - client: `globalThis.fetch` is wrapped, so every outgoing request body and
 *    incoming response body is recorded — including requests made inside
 *    third-party code (jose's JWKS fetch, oauth4webapi's token requests);
 *  - server: `ServerResponse` is patched, so responses of the CSS services are
 *    recorded without their handlers cooperating.
 *
 * Server-side *request* bodies are deliberately not captured: tapping
 * `IncomingMessage` means putting the stream in flowing mode, which would steal
 * data from the handler that is supposed to read it. The client-side span of the
 * same request carries that payload instead (same trace).
 *
 * Plain CommonJS with no dependencies: it is loaded by `preload.cjs` (`--require`,
 * CSS servers) and by the ESM bootstrap through `createRequire` (worker, /test),
 * i.e. from both module graphs.
 *
 * JWTs are redacted unless `OTEL_CAPTURE_RAW_TOKENS=true`; the cap keeps one
 * large payload from bloating a trace. `sai.jwks.*` carries the parsed key set
 * (public material only), so a trace shows *which* keys verified a token
 * without needing the raw document.
 */

const CAPTURED = Symbol.for('sai.otel.httpCapture')
const MAX_BODY_BYTES = 64 * 1024
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

/** Content types worth recording; anything else is skipped as binary or streamed. */
function isCapturableContentType(contentType) {
  if (typeof contentType !== 'string' || contentType.length === 0) return false
  const value = contentType.split(';')[0].trim().toLowerCase()
  if (value.includes('octet-stream')) return false
  // Long-lived stream formats: cloning/buffering their body stalls the client
  // fetch until the stream ends (notification streams never do).
  if (value.includes('x-ndjson') || value.includes('event-stream')) return false
  if (value.startsWith('application/') || value.startsWith('text/')) return true
  return value.endsWith('+json') || value.endsWith('+xml')
}

function truncate(body) {
  return body.length > MAX_BODY_BYTES ? `${body.slice(0, MAX_BODY_BYTES)}…[truncated]` : body
}

function redact(body) {
  return body.replace(
    JWT_PATTERN,
    (token) =>
      `<jwt:${require('node:crypto').createHash('sha256').update(token).digest('base64url').slice(0, 12)}>`
  )
}

function toText(body) {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return undefined
}

function record(span, key, value) {
  /* istanbul ignore next -- defensive: a broken span must never break the app */
  if (!span || typeof span.setAttribute !== 'function') return
  if (typeof span.isRecording === 'function' && !span.isRecording()) return
  span.setAttribute(key, value)
}

function parseJwks(contentType, url, body) {
  if (!/jwk-set\+json/iu.test(String(contentType))) return undefined
  try {
    const document = JSON.parse(body)
    if (!Array.isArray(document.keys)) return undefined
    return {
      url: String(url),
      count: document.keys.length,
      keys: JSON.stringify(
        document.keys.map((key) => ({
          kty: key.kty,
          crv: key.crv,
          alg: key.alg,
          kid: key.kid,
          use: key.use,
        }))
      ),
    }
  } catch {
    return undefined
  }
}

function captureResponseChunk(response, chunk) {
  if (chunk === undefined || chunk === null) return
  const state = response[CAPTURED] || (response[CAPTURED] = { body: '', skipped: false })
  if (state.skipped) return
  const contentType = response.getHeader && response.getHeader('content-type')
  if (state.body.length === 0 && !isCapturableContentType(contentType)) {
    state.skipped = true
    return
  }
  state.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  if (state.body.length > MAX_BODY_BYTES) {
    state.body = state.body.slice(0, MAX_BODY_BYTES)
    state.truncated = true
    state.skipped = true
  }
}

function installFetchCapture(options) {
  const original = globalThis.fetch
  if (typeof original !== 'function' || original[CAPTURED]) return

  const wrapped = async function (input, init) {
    const { trace } = require('@opentelemetry/api')
    const span = trace.getActiveSpan()
    const requestBody = toText(init && init.body)
    if (requestBody !== undefined) {
      record(span, 'http.request.body', truncate(options.redact(requestBody)))
    }

    const response = await original.call(this, input, init)

    try {
      const contentType = response.headers.get('content-type') || ''
      const length = Number(response.headers.get('content-length') || 0)
      if (isCapturableContentType(contentType) && length <= MAX_BODY_BYTES) {
        const body = await response.clone().text()
        if (body.length > 0) {
          record(span, 'http.response.body', truncate(options.redact(body)))
          const jwks = parseJwks(contentType, response.url || input, body)
          if (jwks) {
            record(span, 'sai.jwks.url', jwks.url)
            record(span, 'sai.jwks.count', jwks.count)
            record(span, 'sai.jwks.keys', jwks.keys)
          }
        }
      }
    } catch {
      // body capture is best-effort
    }
    return response
  }
  wrapped[CAPTURED] = true
  globalThis.fetch = wrapped
}

function installServerResponseCapture(options) {
  const { ServerResponse } = require('node:http')
  const originals = {
    write: ServerResponse.prototype.write,
    end: ServerResponse.prototype.end,
  }

  ServerResponse.prototype.write = function (chunk, ...rest) {
    try {
      captureResponseChunk(this, chunk)
    } catch {
      // never break the response
    }
    return originals.write.call(this, chunk, ...rest)
  }

  ServerResponse.prototype.end = function (chunk, ...rest) {
    try {
      captureResponseChunk(this, chunk)
      const state = this[CAPTURED]
      if (state && state.body.length > 0) {
        const { trace } = require('@opentelemetry/api')
        const span = trace.getActiveSpan()
        record(span, 'http.response.body', truncate(options.redact(state.body)))
        // The verifier fetches a JWKS through jose, which captures `fetch` at
        // import time and so bypasses the client wrapper above; the serving side
        // still sees the document and can parse it here.
        const jwks = parseJwks(this.getHeader('content-type'), this.req && this.req.url, state.body)
        if (jwks) {
          record(span, 'sai.jwks.url', jwks.url)
          record(span, 'sai.jwks.count', jwks.count)
          record(span, 'sai.jwks.keys', jwks.keys)
        }
      }
    } catch {
      // never break the response
    }
    return originals.end.call(this, chunk, ...rest)
  }
}

/**
 * Installs the capture hooks once per process. Reads `OTEL_CAPTURE_BODIES` and
 * `OTEL_CAPTURE_RAW_TOKENS` (the latter disables redaction, local debugging only).
 */
function installHttpCapture() {
  if (globalThis[CAPTURED]) return
  globalThis[CAPTURED] = true
  if (process.env.OTEL_CAPTURE_BODIES !== 'true') return

  const rawTokens = process.env.OTEL_CAPTURE_RAW_TOKENS === 'true'
  const config = { redact: rawTokens ? (body) => body : redact }
  installFetchCapture(config)
  installServerResponseCapture(config)
}

module.exports = {
  installHttpCapture,
  isCapturableContentType,
  redact,
  truncate,
  parseJwks,
  MAX_BODY_BYTES,
}
