import { createRequire } from 'node:module'

import { describe, expect, test } from 'vitest'

// The capture hooks are plain CommonJS so both the CSS preload (CJS) and the
// worker bootstrap (ESM) can load them; the pure helpers are testable here.
const requireCjs = createRequire(import.meta.url)
const { isCapturableContentType, parseJwks, redact, truncate, MAX_BODY_BYTES } = requireCjs(
  '../src/tracing/http-capture.cjs'
) as {
  isCapturableContentType(value: string | undefined): boolean
  parseJwks(
    contentType: string,
    url: string,
    body: string
  ): { count: number; keys: string } | undefined
  redact(body: string): string
  truncate(body: string): string
  MAX_BODY_BYTES: number
}

const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJodHRwczovL2lkL2FsaWNlIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'

describe('isCapturableContentType', () => {
  test('accepts the payload types of the LWS chain', () => {
    for (const value of [
      'application/json',
      'application/json; charset=utf-8',
      'application/ld+json',
      'application/jwk-set+json',
      'application/x-www-form-urlencoded',
      'text/turtle',
      'application/n-quads',
    ]) {
      expect(isCapturableContentType(value)).toBe(true)
    }
  })

  test('skips binary and unknown types', () => {
    expect(isCapturableContentType(undefined)).toBe(false)
    expect(isCapturableContentType('image/png')).toBe(false)
    expect(isCapturableContentType('application/octet-stream')).toBe(false)
    // long-lived streams must never be buffered by the response capture
    expect(isCapturableContentType('application/x-ndjson')).toBe(false)
    expect(isCapturableContentType('text/event-stream')).toBe(false)
  })
})

describe('redact', () => {
  test('replaces JWTs with a stable digest and keeps the rest', () => {
    const body = `subject_token=${JWT}&audience=https%3A%2F%2Fdata%2F`
    const redacted = redact(body)
    expect(redacted).not.toContain(JWT)
    expect(redacted).toMatch(/subject_token=<jwt:[A-Za-z0-9_-]{12}>/u)
    expect(redacted).toContain('audience=https%3A%2F%2Fdata%2F')
    expect(redact(body)).toBe(redacted)
  })
})

describe('truncate', () => {
  test('caps a payload at the limit', () => {
    expect(truncate('short')).toBe('short')
    const long = truncate('x'.repeat(MAX_BODY_BYTES + 10))
    expect(long.endsWith('…[truncated]')).toBe(true)
    expect(long.length).toBeLessThan(MAX_BODY_BYTES + 20)
  })
})

describe('parseJwks', () => {
  test('summarizes the public parameters of a key set', () => {
    const body = JSON.stringify({
      keys: [
        { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'abc', use: 'sig', x: 'x', y: 'y' },
        { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'def', use: 'sig', d: 'private' },
      ],
    })
    const parsed = parseJwks('application/jwk-set+json', 'https://auth/.oidc/jwks', body)
    expect(parsed?.count).toBe(2)
    expect(JSON.parse(String(parsed?.keys))).toEqual([
      { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'abc', use: 'sig' },
      { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'def', use: 'sig' },
    ])
    // only for key-set documents
    expect(parseJwks('application/json', 'https://auth/.oidc/jwks', body)).toBeUndefined()
  })
})
