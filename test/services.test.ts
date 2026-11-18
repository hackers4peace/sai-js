import { buildSessionManager } from '@elfpavlik/sai-components'
import { describe, expect, test } from 'vitest'

const aliceId = 'https://id/alice'
const bobId = 'https://id/bob'
const segment = (webId: string): string => Buffer.from(webId).toString('base64url')

describe('main', () => {
  test('auth', async () => {
    const response = await fetch('https://auth')
    expect(response.ok).toBeTruthy()
  })
  test('registry', async () => {
    const response = await fetch('https://registry')
    expect(response.ok).toBeTruthy()
  })
  test('data', async () => {
    // The data pod advertises its LWS storage description publicly: a request
    // without a storage credential (wildcard/absent Accept) gets the
    // `application/lws+cid` description, not a 401 challenge — the storage
    // root is discoverable without authentication (§5).
    const response = await fetch('https://data/bob/')
    expect(response.ok).toBeTruthy()
    expect(response.headers.get('content-type')).toContain('application/lws+cid')
    const body = (await response.json()) as {
      service: { type: string; serviceEndpoint: string; conformsTo?: string[] }[]
    }
    expect(body.service).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'AccessRequestService',
          serviceEndpoint: `https://auth/.sai/access-requests/${segment(bobId)}`,
          conformsTo: ['http://www.w3.org/ns/solid/interop#AccessProfile'],
        }),
        expect.objectContaining({
          type: 'AccessGrantService',
          serviceEndpoint: `https://auth/.sai/grants/${segment(bobId)}`,
          conformsTo: ['http://www.w3.org/ns/solid/interop#AccessProfile'],
        }),
        expect.objectContaining({ type: 'NotificationService' }),
      ])
    )
  })
  test('data storage advertises sai:DataStorage in its public description', async () => {
    const response = await fetch('https://data/bob/', {
      headers: { accept: 'application/lws+cid' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { '@context': string[]; type: string | string[] }
    expect(body.type).toEqual(expect.arrayContaining(['Storage', 'DataStorage']))
    expect(body['@context']).toContain('https://www.w3.org/ns/solid/interop-context/v1')
  })
  test('registry storage advertises sai:RegistryStorage in its public description', async () => {
    const response = await fetch('https://registry/bob/', {
      headers: { accept: 'application/lws+cid' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { '@context': string[]; type: string | string[] }
    expect(body.type).toEqual(expect.arrayContaining(['Storage', 'RegistryStorage']))
    expect(body['@context']).toContain('https://www.w3.org/ns/solid/interop-context/v1')
  })
  test('data pod has no .lws access containers', async () => {
    const session = await buildSessionManager().getSession(aliceId)
    for (const path of ['.lws/grants/', '.lws/requests/']) {
      const response = await session.fetch(`https://data/alice-home/${path}`, {
        method: 'HEAD',
      })
      expect(response.status).toBe(404)
    }
  })
  test('id', async () => {
    const response = await fetch('https://id/alice')
    expect(response.ok).toBeTruthy()
  })
})
