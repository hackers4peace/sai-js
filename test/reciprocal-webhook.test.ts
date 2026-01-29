import { buildOidcSession } from '@elfpavlik/sai-components'
import {
  AS,
  discoverAgentRegistration,
  discoverAuthorizationAgent,
  fetchWrapper,
} from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'
import { receivesNotification } from './util'

const aliceId = 'https://id/alice'
const clientId = 'https://data/test-client/public/id'
const sendTo = 'https://auth/.sai/reciprocal-webhook/26bf5f67-7858-4c18-ab1a-7404ed530c1b'

describe('reciprocal webhook', () => {
  test('id', async () => {
    const response = await fetch(sendTo, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
      },
      body: JSON.stringify({
        type: 'Update',
      }),
    })
    expect(response.status).toBe(200)
    const session = await buildOidcSession(aliceId, clientId)
    const aliceAgentId = await discoverAuthorizationAgent(aliceId, fetchWrapper(fetch))
    if (!aliceAgentId) throw new Error(`could not discover auth agent for ${aliceId}`)
    const applicationRegistrationId = await discoverAgentRegistration(
      aliceAgentId,
      session.authFetch.bind(session)
    )
    if (!applicationRegistrationId)
      throw new Error(`could not discover application registration for ${clientId} - ${aliceId}`)
    const check = await receivesNotification(
      session.authFetch.bind(session),
      applicationRegistrationId,
      AS.Update.value
    )
    expect(check).toBeTruthy()
  })
})
