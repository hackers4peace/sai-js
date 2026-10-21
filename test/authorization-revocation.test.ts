import { buildOidcSession, buildSessionManager } from '@elfpavlik/sai-components'
import { getDataGrantIris } from '@janeirodigital/interop-data-model'
import { LDP, toStore } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { rpcCall, rpcPayload, waitForActivityCompletion } from './util'

// C2 acceptance (user-run under dagger): the UI-shaped authorization
// revocation. Seeded in environments/data/registry.trig: acme's authorizations
// for bob — a Project parent (`p3j7mq`, AllFromAgent) and its inherited Task
// child (`m9k4wr`) — and the four source grants derived from them.

const acmeCookie = 'css-account=a1b9f0e2-3c4d-4e5f-8a7b-0c9d1e2f3a4b'
const acmeId = 'https://id/acme'
const bobId = 'https://id/bob'
const authorizationRegistry = 'https://registry/acme/authorization/'
const grantRegistry = 'https://registry/acme/grant/'
// seeded in environments/data/registry.trig
const seededGrantCount = 10

const parent = `${authorizationRegistry}p3j7mq` // Project, AllFromAgent
const child = `${authorizationRegistry}m9k4wr` // Task, Inherited

function revokePayload(authorizations: string[]) {
  return rpcPayload({
    _tag: 'RevokeAuthorizations',
    authorizations,
    context: acmeId,
  })
}

async function countContained(container: string): Promise<number> {
  const session = await buildOidcSession(acmeId)
  const response = await session.authFetch(container, {
    headers: { Accept: 'application/ld+json' },
  })
  expect(response.status).toBe(200)
  const dataset = await toStore((await response.json()) as Record<string, unknown>)
  return Array.from(dataset).filter((quad) => quad.predicate.value === LDP.contains).length
}

describe('authorization revocation (C2)', () => {
  test('revoking the grantee authorizations removes the DAs and the derived grants', async () => {
    const manager = buildSessionManager()
    const acme = await manager.getSession(acmeId)
    const authorizationsBefore = await countContained(authorizationRegistry)
    expect(await countContained(grantRegistry)).toBe(seededGrantCount)

    const ack = await rpcCall(revokePayload([parent, child]), acmeCookie)
    expect(ack.authorizations).toEqual(expect.arrayContaining([parent, child]))
    expect(ack.activityId).toBeTruthy()

    await waitForActivityCompletion(acme, 'AuthorizationRevoked')

    // parent + child DataAuthorizations are gone
    expect(await countContained(authorizationRegistry)).toBe(authorizationsBefore - 2)
    // the four source grants derived from bob's authorizations are gone
    expect(await countContained(grantRegistry)).toBe(seededGrantCount - 4)
    // acme's own projection of bob no longer links any grant
    const registration = await acme.findSocialAgentRegistration(bobId)
    expect(registration).toBeDefined()
    expect(getDataGrantIris(registration!)).toEqual([])
  })

  test('re-revoking already-removed authorizations is a no-op success', async () => {
    const manager = buildSessionManager()
    const acme = await manager.getSession(acmeId)

    await rpcCall(revokePayload([parent, child]), acmeCookie)
    await waitForActivityCompletion(acme, 'AuthorizationRevoked')

    const ack = await rpcCall(revokePayload([parent, child]), acmeCookie)
    expect(ack.authorizations).toEqual([])
    expect(ack.activityId).toBeUndefined()
  })
})
