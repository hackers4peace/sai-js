import { buildSessionManager } from '@elfpavlik/sai-components'
import { describe, expect, test } from 'vitest'

const rpcEndpoint = 'https://auth/.sai/api'

const aliceId = 'https://id/alice'
const bobId = 'https://id/bob'
const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'
const clientId = 'https://data/test-client/public/id'

describe('request access', () => {
  const requestData = {
    applicationId: clientId,
    agentId: aliceId,
  }
  const payload = [
    {
      request: {
        _tag: 'RequestAccessUsingApplicationNeeds',
        ...requestData,
      },
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]

  test('links registration to access need group', async () => {
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
    expect(value).toBeUndefined()

    const manager = buildSessionManager()
    const session = await manager.getSession(bobId)
    const registration = await session.findSocialAgentRegistration(aliceId)
    expect(registration?.hasAccessNeedGroup).toBe(
      'https://data/test-client/public/access-needs#need-group-pm'
    )
  })
})
