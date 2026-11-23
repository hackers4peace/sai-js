import type { Span } from '@opentelemetry/api'
import { decodeJwt, decodeProtectedHeader } from 'jose'

/**
 * Which credential a span is handling. Used as the attribute namespace so a
 * trace can tell the three JWTs of the LWS chain apart:
 *
 *  - `subject` — the authentication credential presented to an authorization
 *    server (self-issued or OP-issued ID token),
 *  - `id-jag` — the Identity Assertion JWT Authorization Grant issued by the
 *    user's authorization server for one resource authorization server,
 *  - `access` — the bearer access token a storage accepts.
 */
export type TokenRole = 'subject' | 'id-jag' | 'access'

export interface TokenCaptureOptions {
  /**
   * Record the serialized token as well. A JWT is a bearer credential, so this
   * is off unless `OTEL_CAPTURE_RAW_TOKENS=true` — the decoded claims are
   * enough to read a trace, and the collector may not be trusted with a
   * replayable token.
   */
  raw?: boolean
}

/**
 * Node's `createHash`, resolved lazily through `process.getBuiltinModule` so the
 * module stays bundleable for browsers: a static `node:crypto` import is
 * externalized there and breaks the build. Without it the digest attributes are
 * simply omitted (browser runtimes never enable tracing).
 */
function sha256(value: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
      .process
    const crypto = proc?.getBuiltinModule?.('node:crypto') as
      | typeof import('node:crypto')
      | undefined
    return crypto?.createHash('sha256').update(value).digest('base64url')
  } catch {
    return undefined
  }
}

const STRING_CLAIMS = ['iss', 'sub', 'client_id', 'azp', 'jti', 'scope'] as const
const NUMERIC_CLAIMS = ['exp', 'iat', 'nbf'] as const
const HEADER_FIELDS = ['typ', 'alg', 'kid'] as const

/**
 * Runtime override of the capture flags, for browser deployments that configure
 * tracing in `config.json` instead of env (the server preload keeps using env).
 * Set once from the tracing initializer before any span is created.
 */
const CAPTURE_CONFIG_KEY: symbol = Symbol.for('sai.otel.capture')

export interface CaptureConfig {
  tokens?: boolean
  bodies?: boolean
  rawTokens?: boolean
}

/** Configure capture at runtime (browser deployments). */
export function configureTokenCapture(config: CaptureConfig | undefined): void {
  ;(globalThis as Record<symbol, unknown>)[CAPTURE_CONFIG_KEY] = config
}

function captureConfig(): CaptureConfig | undefined {
  return (globalThis as Record<symbol, unknown>)[CAPTURE_CONFIG_KEY] as CaptureConfig | undefined
}

/**
 * Whether decoded credentials may be attached to spans. Explicit opt-in: the
 * Dagger suite sets `OTEL_CAPTURE_TOKENS=true` next to `OTEL_CAPTURE_HEADERS`,
 * compose leaves it unset. A runtime configuration (browser) wins.
 */
export function isTokenCaptureEnabled(): boolean {
  return captureConfig()?.tokens ?? process.env.OTEL_CAPTURE_TOKENS === 'true'
}

/** Whether the serialized JWT may be attached too. Never enable on a shared collector. */
export function isRawTokenCaptureEnabled(): boolean {
  return captureConfig()?.rawTokens ?? process.env.OTEL_CAPTURE_RAW_TOKENS === 'true'
}

function setStringAttributes(span: Span, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      span.setAttribute(key, value)
    }
  }
}

/**
 * Records a JWT as span attributes under `sai.token.<role>.*`.
 *
 * Intended for the protocol spans of the LWS token chain (`sai.lws.*`), the same
 * way `sai.jsonld.*` records whole documents: the full decoded header/claims as
 * JSON (gated by `isRecording()`), the flat fields the diagrams care about, and
 * a digest for correlating the same credential across processes without
 * recording it.
 *
 * Recording-only and gated: a no-op when tracing is off or token capture is
 * disabled, so callers can call it unconditionally.
 */
export function setTokenAttributes(
  span: Span,
  role: TokenRole,
  token: string,
  options: TokenCaptureOptions = {}
): void {
  if (!span.isRecording() || !isTokenCaptureEnabled()) {
    return
  }

  const prefix = `sai.token.${role}`
  span.setAttribute(`${prefix}.bytes`, token.length)
  const digest = sha256(token)
  if (digest) {
    span.setAttribute(`${prefix}.sha256`, digest)
  }

  const raw = options.raw ?? isRawTokenCaptureEnabled()
  if (raw) {
    span.setAttribute(`${prefix}.jwt`, token)
  }

  let header: Record<string, unknown> | undefined
  try {
    header = decodeProtectedHeader(token)
  } catch {
    // not a JWT — leave only the digest behind
    return
  }

  setStringAttributes(
    span,
    Object.fromEntries(HEADER_FIELDS.map((field) => [`${prefix}.${field}`, header?.[field]]))
  )
  if (header !== undefined) {
    span.setAttribute(`${prefix}.header`, JSON.stringify(header))
  }

  let claims: Record<string, unknown>
  try {
    claims = decodeJwt(token) as Record<string, unknown>
  } catch (error: unknown) {
    span.setAttribute(`${prefix}.invalid`, (error as Error).message)
    return
  }

  span.setAttribute(`${prefix}.claims`, JSON.stringify(claims))
  setStringAttributes(
    span,
    Object.fromEntries(STRING_CLAIMS.map((claim) => [`${prefix}.${claim}`, claims[claim]]))
  )
  for (const claim of NUMERIC_CLAIMS) {
    const value = claims[claim]
    if (typeof value === 'number') {
      span.setAttribute(`${prefix}.${claim}`, value)
    }
  }

  const aud = claims.aud
  if (typeof aud === 'string') {
    span.setAttribute(`${prefix}.aud`, aud)
  } else if (Array.isArray(aud) && aud.every((value) => typeof value === 'string')) {
    span.setAttribute(`${prefix}.aud`, aud)
  }

  const cnf = claims.cnf
  if (
    cnf !== null &&
    typeof cnf === 'object' &&
    typeof (cnf as { jkt?: unknown }).jkt === 'string'
  ) {
    span.setAttribute(`${prefix}.cnf_jkt`, (cnf as { jkt: string }).jkt)
  }
}

/** Whether request/response payloads may be attached to spans (`OTEL_CAPTURE_BODIES`). */
export function isBodyCaptureEnabled(): boolean {
  return captureConfig()?.bodies ?? process.env.OTEL_CAPTURE_BODIES === 'true'
}

/** Largest payload recorded on a span; keeps one big document from bloating a trace. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * JWS compact serializations are three base64url segments starting with `eyJ`;
 * every token carried in a captured body is replaced by a digest unless raw
 * capture is enabled.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu

/**
 * Records a request or response payload on a span (`sai.lws.request.body`,
 * `sai.lws.response.body`, ...), truncated to {@link MAX_BODY_BYTES}.
 *
 * Opt-in via `OTEL_CAPTURE_BODIES`, like the token claims: payloads can carry
 * credentials, so only a collector we control should receive them.
 */
export function setBodyAttribute(span: Span, key: string, body: string): void {
  if (!span.isRecording() || !isBodyCaptureEnabled()) {
    return
  }
  const redacted = isRawTokenCaptureEnabled() ? body : redactTokens(body)
  span.setAttribute(
    key,
    redacted.length > MAX_BODY_BYTES ? `${redacted.slice(0, MAX_BODY_BYTES)}…[truncated]` : redacted
  )
}

/** Replaces every JWT in `body` with a stable digest of it. */
function redactTokens(body: string): string {
  return body.replaceAll(JWT_PATTERN, (token) => {
    const digest = sha256(token)
    return `<jwt:${digest ? digest.slice(0, 12) : 'redacted'}>`
  })
}
