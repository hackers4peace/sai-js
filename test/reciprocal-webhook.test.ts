import { buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import { ActivityRegistry, localSparqlTransport } from '@janeirodigital/interop-authorization-agent'
import {
  AS,
  discoverAgentRegistration,
  discoverAuthorizationAgent,
} from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { awaitEvent, openEventsStream, receivesNotification, waitFor } from './util'

const aliceId = 'https://id/alice'
const clientId = 'https://data/test-client/public/id'
const sendTo = 'https://auth/.sai/reciprocal-webhook/26bf5f67-7858-4c18-ab1a-7404ed530c1b'
// alice's account cookie (value 8187358a-… → account e4fcefdc-…, webId
// https://id/alice — the account with the pre-seeded activity-webhook
// channel the events stream relies on)
const aliceCookie = 'css-account=8187358a-2072-4dce-9c76-24caffcc84a4'

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
    const aliceAgentId = await discoverAuthorizationAgent(aliceId, fetch)
    if (!aliceAgentId) {
      throw new Error(`could not discover auth agent for ${aliceId}`)
    }
    const applicationRegistrationId = await discoverAgentRegistration(
      aliceAgentId,
      session.authFetch.bind(session)
    )
    if (!applicationRegistrationId) {
      throw new Error(`could not discover application registration for ${clientId} - ${aliceId}`)
    }
    // the notification stream is a registry-server service path: it takes the
    // storage's LWS token (the session fetch), not `.sai` DPoP credentials —
    // `servicePaths` in the registry config lets the extractor accept it and
    // the handler authorizes the decoded topic
    const manager = buildSessionManager()
    const aliceSession = await manager.getSession(aliceId)
    const check = await receivesNotification(
      aliceSession.fetch,
      applicationRegistrationId,
      AS.Update
    )
    expect(check).toBeTruthy()

    // the Update was routed through the outbox: a delegatedGrantsUpdated
    // activity exists in alice's Activity Registry and is completed
    // (a completion activity references it) after the workflow ran
    const registry = aliceSession.registrySet.hasActivityRegistry!
    await waitFor(
      async () => {
        const completed = await ActivityRegistry.getCompletedActivityIris(
          registry,
          localSparqlTransport(aliceSession.sparqlEndpoint)
        )
        if (!completed.length) {
          return false
        }
        const iris = await ActivityRegistry.getActivityIris(
          registry,
          localSparqlTransport(aliceSession.sparqlEndpoint)
        )
        for (const iri of iris) {
          const activity = await ActivityRegistry.loadActivity(iri, aliceSession.fetch)
          if (activity.type.includes('DelegatedGrantsUpdated') && completed.includes(activity.id)) {
            return true
          }
        }
        return false
      },
      { timeout: 30_000 }
    )
  })

  test('emits pending and done events for the delegatedGrantsUpdated activity', async () => {
    // listen first — the server never replays
    const stream = await openEventsStream(aliceCookie)
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

    // the container Add delivers the change activity → `pending` …
    const pending = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.type?.includes('DelegatedGrantsUpdated') &&
        message.activity.status === 'pending',
      { close: false }
    )
    expect(pending).toBeDefined()
    expect(pending?.activity.target).toBe('https://id/bob')

    // … and the completion Add → `done`, enriched with the original typed activity
    const done = await awaitEvent(
      stream,
      (message) =>
        message.type === 'activity' &&
        message.activity?.id === pending?.activity.id &&
        message.activity.status === 'done'
    )
    expect(done).toBeDefined()
    expect(done?.activity.target).toBe('https://id/bob')
  })
})
