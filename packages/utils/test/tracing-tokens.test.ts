import type { Span } from '@opentelemetry/api'
import { SignJWT, generateKeyPair, exportJWK, calculateJwkThumbprint } from 'jose'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  configureTokenCapture,
  setBodyAttribute,
  setTokenAttributes,
} from '../src/tracing/tokens.js'

/** Minimal span stand-in: only `isRecording`/`setAttribute` are used by the helper. */
function createSpan(recording = true): { span: Span; attributes: Map<string, unknown> } {
  const attributes = new Map<string, unknown>()
  const span = {
    isRecording: () => recording,
    setAttribute: (key: string, value: unknown) => {
      attributes.set(key, value)
      return span
    },
  } as unknown as Span
  return { span, attributes }
}

let token: string
let jkt: string

beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  jkt = await calculateJwkThumbprint(await exportJWK(publicKey))
  token = await new SignJWT({ client_id: 'https://data/test-client/public/id', cnf: { jkt } })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'key-1' })
    .setIssuer('https://auth/')
    .setSubject('https://id/alice')
    .setAudience(['solid', 'https://data/'])
    .setIssuedAt()
    .setExpirationTime('300s')
    .setJti('c0ffee00-0000-4000-8000-000000000000')
    .sign(privateKey)
  process.env.OTEL_CAPTURE_TOKENS = 'true'
  delete process.env.OTEL_CAPTURE_RAW_TOKENS
})

afterEach(() => {
  configureTokenCapture(undefined)
  delete process.env.OTEL_CAPTURE_TOKENS
  delete process.env.OTEL_CAPTURE_RAW_TOKENS
  delete process.env.OTEL_CAPTURE_BODIES
})

describe('setTokenAttributes', () => {
  test('records the decoded header and claims of a credential', () => {
    const { span, attributes } = createSpan()
    setTokenAttributes(span, 'subject', token)

    expect(attributes.get('sai.token.subject.typ')).toBe('at+jwt')
    expect(attributes.get('sai.token.subject.alg')).toBe('ES256')
    expect(attributes.get('sai.token.subject.kid')).toBe('key-1')
    expect(attributes.get('sai.token.subject.iss')).toBe('https://auth/')
    expect(attributes.get('sai.token.subject.sub')).toBe('https://id/alice')
    expect(attributes.get('sai.token.subject.client_id')).toBe('https://data/test-client/public/id')
    expect(attributes.get('sai.token.subject.jti')).toBe('c0ffee00-0000-4000-8000-000000000000')
    expect(attributes.get('sai.token.subject.aud')).toEqual(['solid', 'https://data/'])
    expect(attributes.get('sai.token.subject.cnf_jkt')).toBe(jkt)
    expect(attributes.get('sai.token.subject.exp')).toEqual(expect.any(Number))
    expect(attributes.get('sai.token.subject.bytes')).toBe(token.length)
    expect(JSON.parse(String(attributes.get('sai.token.subject.claims')))).toMatchObject({
      iss: 'https://auth/',
    })
  })

  test('keeps the raw credential out unless it is explicitly allowed', () => {
    const { span, attributes } = createSpan()
    setTokenAttributes(span, 'subject', token)
    expect(attributes.has('sai.token.subject.jwt')).toBe(false)

    process.env.OTEL_CAPTURE_RAW_TOKENS = 'true'
    const raw = createSpan()
    setTokenAttributes(raw.span, 'subject', token)
    expect(raw.attributes.get('sai.token.subject.jwt')).toBe(token)
    // an explicit per-call opt-out wins over the environment
    const denied = createSpan()
    setTokenAttributes(denied.span, 'subject', token, { raw: false })
    expect(denied.attributes.has('sai.token.subject.jwt')).toBe(false)
  })

  test('is a no-op when token capture is disabled or the span does not record', () => {
    delete process.env.OTEL_CAPTURE_TOKENS
    const disabled = createSpan()
    setTokenAttributes(disabled.span, 'subject', token)
    expect(disabled.attributes.size).toBe(0)

    process.env.OTEL_CAPTURE_TOKENS = 'true'
    const notRecording = createSpan(false)
    setTokenAttributes(notRecording.span, 'subject', token)
    expect(notRecording.attributes.size).toBe(0)
  })

  test('takes the capture flags from a runtime configuration (browser)', () => {
    delete process.env.OTEL_CAPTURE_TOKENS
    configureTokenCapture({ tokens: true, bodies: true })
    const { span, attributes } = createSpan()
    setTokenAttributes(span, 'subject', token)
    expect(attributes.get('sai.token.subject.iss')).toBe('https://auth/')

    // an explicit runtime false wins over a true environment flag
    process.env.OTEL_CAPTURE_TOKENS = 'true'
    configureTokenCapture({ tokens: false })
    const disabled = createSpan()
    setTokenAttributes(disabled.span, 'subject', token)
    expect(disabled.attributes.size).toBe(0)
  })

  test('records only the digest for a value that is not a JWT', () => {
    const { span, attributes } = createSpan()
    setTokenAttributes(span, 'access', 'opaque-token')
    expect(attributes.get('sai.token.access.bytes')).toBe(12)
    expect(attributes.get('sai.token.access.sha256')).toEqual(expect.any(String))
    expect(attributes.has('sai.token.access.claims')).toBe(false)
  })
})

describe('setBodyAttribute', () => {
  test('records a payload only when body capture is enabled', () => {
    const disabled = createSpan()
    setBodyAttribute(disabled.span, 'sai.lws.request.body', 'grant_type=token-exchange')
    expect(disabled.attributes.size).toBe(0)

    process.env.OTEL_CAPTURE_BODIES = 'true'
    const enabled = createSpan()
    setBodyAttribute(enabled.span, 'sai.lws.request.body', 'grant_type=token-exchange')
    expect(enabled.attributes.get('sai.lws.request.body')).toBe('grant_type=token-exchange')

    delete process.env.OTEL_CAPTURE_BODIES
    configureTokenCapture({ bodies: true })
    const runtime = createSpan()
    setBodyAttribute(runtime.span, 'sai.lws.request.body', 'grant_type=token-exchange')
    expect(runtime.attributes.get('sai.lws.request.body')).toBe('grant_type=token-exchange')
  })

  test('redacts the tokens a payload carries', () => {
    process.env.OTEL_CAPTURE_BODIES = 'true'
    const { span, attributes } = createSpan()
    setBodyAttribute(
      span,
      'sai.lws.request.body',
      `subject_token=${token}&audience=https%3A%2F%2Fdata%2F`
    )
    const body = String(attributes.get('sai.lws.request.body'))
    expect(body).not.toContain(token)
    expect(body).toMatch(/subject_token=<jwt:[A-Za-z0-9_-]{12}>/u)
    expect(body).toContain('audience=https%3A%2F%2Fdata%2F')

    process.env.OTEL_CAPTURE_RAW_TOKENS = 'true'
    const raw = createSpan()
    setBodyAttribute(raw.span, 'sai.lws.request.body', `subject_token=${token}`)
    expect(raw.attributes.get('sai.lws.request.body')).toContain(token)
  })

  test('truncates a payload that exceeds the cap', () => {
    process.env.OTEL_CAPTURE_BODIES = 'true'
    const { span, attributes } = createSpan()
    setBodyAttribute(span, 'sai.lws.response.body', 'x'.repeat(70 * 1024))
    const value = String(attributes.get('sai.lws.response.body'))
    expect(value.endsWith('…[truncated]')).toBe(true)
    expect(value.length).toBeLessThan(70 * 1024)
  })
})
