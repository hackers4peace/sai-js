import { buildSessionManager } from '@elfpavlik/sai-components'
import { describe, expect, test } from 'vitest'

const rpcEndpoint = 'https://auth/.sai/api'
// TODO: import
const agentType = 'http://www.w3.org/ns/solid/interop#Application'
const clientId = 'https://data/test-client/public/id'

describe('get authorization data', () => {
  const aliceId = 'https://id/alice'
  const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'
  const lang = 'en'

  const payload = [
    {
      request: {
        _tag: 'GetAuthoriaztionData',
        agentId: clientId,
        agentType,
        lang,
      },
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]

  test('responds with authorization data', async () => {
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
    expect(value).toEqual(expect.objectContaining({ id: clientId, agentType }))
    expect(value.accessNeedGroup).toEqual(
      expect.objectContaining({
        label: 'Manage Projects',
        lang,
      })
    )
    expect(value.dataOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: aliceId }),
        expect.objectContaining({ id: 'https://id/acme' }),
      ])
    )
    expect(value.accessNeedGroup.needs).toEqual(
      expect.arrayContaining([
        {
          id: 'https://data/test-client/public/access-needs#need-project',
          label:
            'Access to Projects is essential for Projectron to perform its core function of Project Management.',
          required: true,
          access: [
            'http://www.w3.org/ns/auth/acl#Read',
            'http://www.w3.org/ns/auth/acl#Create',
            'http://www.w3.org/ns/auth/acl#Update',
            'http://www.w3.org/ns/auth/acl#Delete',
          ],
          shapeTree: { id: 'https://data/shapetrees/trees/Project', label: 'Projects' },
          children: expect.arrayContaining([
            expect.objectContaining({
              id: 'https://data/test-client/public/access-needs#need-task',
            }),
            expect.objectContaining({
              id: 'https://data/test-client/public/access-needs#need-image',
            }),
            expect.objectContaining({
              id: 'https://data/test-client/public/access-needs#need-file',
            }),
          ]),
        },
      ])
    )
  })
})

describe('denied', () => {
  const bobId = 'https://id/bob'
  const bobCookie = 'css-account=339642f3-f3ee-42e5-85b9-4b1ab6b27ddc'

  const authorization = {
    grantee: clientId,
    agentType,
    accessNeedGroup: 'https://data/test-client/public/access-needs#need-group-pm',
    granted: false,
  }
  const payload = [
    {
      request: {
        _tag: 'AuthorizeApp',
        authorization,
      },
      headers: {},
      traceId: '13c2035f72f45c1ebbf13b055b7dc526',
      spanId: '685581075752b8a2',
      sampled: true,
    },
  ]

  test('creates denied authorization', async () => {
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
    expect(value.granted).toBeFalsy()
    expect(value.id).toMatch('https://registry/bob/authorization/')
    expect(value.callbackEndpoint).toBe('https://data/test-client/public/id')

    const manager = buildSessionManager()
    const session = await manager.getSession(bobId)
    const accessAuthorization =
      await session.registrySet.hasAuthorizationRegistry.findAuthorization(clientId)
    expect(accessAuthorization?.granted).toBeFalsy()
    const registration = await session.findApplicationRegistration(clientId)
    expect(registration?.accessGrant?.granted).toBeFalsy()
  })
})
