import { buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import { describe, expect, test } from 'vitest'

const rpcEndpoint = 'https://auth/.sai/api'

describe('create invitation', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'

  const invitationData = {
    label: 'Bob',
    note: 'Some note',
  }
  const payload = [
    {
      request: {
        _tag: 'CreateInvitation',
        ...invitationData,
      },
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]

  test('responds with invitation', async () => {
    const response = await fetch(rpcEndpoint, {
      method: 'POST',
      headers: {
        ContentType: 'application/json',
        Cookie: aliceCookie,
      },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    const { _tag, value } = body[0]
    expect(_tag).toBe('Success')
    expect(value).toEqual(expect.objectContaining(invitationData))
    expect(value.capabilityUrl).toMatch('https://auth/.sai/invitations')

    const session = await buildOidcSession(aliceId)
    const check = await session.authFetch(value.id)
    expect(check.status).toBe(200)
    // TODO: validate data using SocialAgentInvitation shape
  })
})

describe('accept invitation', () => {
  const bobId = 'https://id/bob'
  const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'
  const invKimToBob =
    'https://auth/.sai/invitations/aHR0cHM6Ly9pZC9raW0.8f19934d-b6a6-4a73-9d27-8cd20ed0657f'

  const acceptData = {
    label: 'Kim',
    note: 'Beep boop',
  }
  const payload = [
    {
      request: {
        _tag: 'AcceptInvitation',
        capabilityUrl: invKimToBob,
        ...acceptData,
      },
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]

  test('responds with agent registration', async () => {
    const response = await fetch(rpcEndpoint, {
      method: 'POST',
      headers: {
        ContentType: 'application/json',
        Cookie: bobCookie,
      },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    const { _tag, value } = body[0]
    expect(_tag).toBe('Success')
    expect(value.id).toBe('https://id/kim')
    expect(value).toEqual(expect.objectContaining(acceptData))

    const manager = buildSessionManager()
    const session = await manager.getSession(bobId)
    const registration = await session.findSocialAgentRegistration(value.id)
    expect(registration).toBeDefined()
    // TODO: validate data using SocialAgentRegistration shape
  })
})
