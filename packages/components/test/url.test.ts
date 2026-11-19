import { describe, expect, test } from 'vitest'

import { isSaiUrl, isWithinBaseUrl, saiAudience } from '../src/util/url.js'

describe('saiAudience', () => {
  test('uses the target UAS base URL for agent discovery', () => {
    expect(saiAudience('https://auth/.sai/agents/aHR0cHM6Ly9pZC9hbGljZQ')).toBe('https://auth/')
    expect(saiAudience('https://other-uas.example/.sai/agents/aHR0cHM6Ly9pZC9hbGljZQ?x=1')).toBe(
      'https://other-uas.example/'
    )
  })

  test('uses the full request URL for one-time interactions', () => {
    for (const path of [
      '.sai/access-requests/aHR0cHM6Ly9pZC9hbGljZQ',
      '.sai/grants/aHR0cHM6Ly9pZC9hbGljZQ',
      '.sai/invitations/aHR0cHM6Ly9pZC9hbGljZQ',
      '.sai/sparql-admin/aHR0cHM6Ly9pZC9hbGljZQ',
      '.sai/reciprocal-webhook/aHR0cHM6Ly9pZC9hbGljZQ',
    ]) {
      const url = `https://auth/${path}?view=full`
      expect(saiAudience(url), path).toBe(url)
    }
  })
})

describe('isWithinBaseUrl', () => {
  test('accepts URLs under the base path and the base itself', () => {
    expect(isWithinBaseUrl('https://auth/.sai/grants/x', 'https://auth/')).toBe(true)
    expect(isWithinBaseUrl('https://auth/', 'https://auth/')).toBe(true)
    expect(isWithinBaseUrl('https://auth/base', 'https://auth/base')).toBe(true)
    expect(isWithinBaseUrl('https://auth/base/x', 'https://auth/base')).toBe(true)
    expect(isWithinBaseUrl('https://auth/base/x', 'https://auth/base/')).toBe(true)
  })

  test('rejects other origins, lookalikes, and sibling paths', () => {
    expect(isWithinBaseUrl('https://auth.evil/.sai/x', 'https://auth/')).toBe(false)
    expect(isWithinBaseUrl('https://auth/baseball', 'https://auth/base')).toBe(false)
    expect(isWithinBaseUrl('https://other/.sai/x', 'https://auth/')).toBe(false)
    expect(isWithinBaseUrl('not a URL', 'https://auth/')).toBe(false)
  })
})

describe('isSaiUrl', () => {
  test('recognizes any `.sai` route on any UAS', () => {
    expect(isSaiUrl('https://auth/.sai/agents/x')).toBe(true)
    expect(isSaiUrl('https://other/.sai/grants/x')).toBe(true)
    expect(isSaiUrl('https://auth/.well-known/lws/token')).toBe(false)
    expect(isSaiUrl('not a URL')).toBe(false)
  })
})
