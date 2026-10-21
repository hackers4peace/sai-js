import { randomUUID } from 'node:crypto'

import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  getApplicationRegistration,
  getSocialAgentRegistration,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { type AgentId, getDataGrantIris } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import { Client, Connection } from '@temporalio/client'
import { describe, expect, test } from 'vitest'

/**
 * The black-box property this plan is about: an unchanged authorization state
 * regenerates to the SAME grant IRIs (source and delegated trees), so a re-run
 * creates no new resources/ACRs and issues no new delegations.
 *
 * The regeneration is invoked directly as its workflow (the per-grantee
 * consumer would coalesce two deliveries); each run uses a fresh workflowId.
 */

const acmeId = 'https://id/acme'
const aliceId = 'https://id/alice'
const testClientId = 'https://data/test-client/public/id'
const acmeRegForAlice = 'https://registry/acme/social-agent/je0s7n/'
const seedGrant = 'https://registry/acme/grant/g4yhtm'
const seedChildGrant = 'https://registry/acme/grant/wpqyds'

const agent = (id: string, type: string): AgentId => ({ id, type: [type] }) as AgentId

/** Run the grantee's full regeneration through the real workflow. */
async function regenerate(webId: string, grantee: AgentId): Promise<void> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  })
  const client = new Client({ connection })
  try {
    await client.workflow.execute('createGrantsForAgent', {
      taskQueue: 'create-grants',
      args: [{ webId: agent(webId, INTEROP.SocialAgent), grantee }],
      workflowId: `check-equivalence-${randomUUID()}`,
    })
  } finally {
    await connection.close()
  }
}

/** Fresh read of acme's registration of alice (the reused source tree). */
async function acmeRegistrationIris(): Promise<string[]> {
  const session = await buildSessionManager().getSession(acmeId)
  const registration = await getSocialAgentRegistration(
    localSparqlTransport(session.sparqlEndpoint),
    acmeRegForAlice
  )
  return getDataGrantIris(registration).toSorted()
}

/** Fresh read of alice's registration of the test client (source + delegated). */
async function applicationRegistrationIris(): Promise<string[]> {
  const session = await buildSessionManager().getSession(aliceId)
  const listed = await session.findApplicationRegistration(testClientId)
  if (!listed) throw new Error('alice has no registration of the test client')
  const registration = await getApplicationRegistration(
    localSparqlTransport(session.sparqlEndpoint),
    listed.id
  )
  return getDataGrantIris(registration).toSorted()
}

describe('checkEquivalence — unchanged regeneration keeps the same IRIs', () => {
  test('source grants: the seeded subtree survives and children are re-linked', async () => {
    await regenerate(acmeId, agent(aliceId, INTEROP.SocialAgent))
    const first = await acmeRegistrationIris()
    // the seed links only the parent; reuse re-links the child from the body
    expect(first).toContain(seedGrant)
    expect(first).toContain(seedChildGrant)

    await regenerate(acmeId, agent(aliceId, INTEROP.SocialAgent))
    const second = await acmeRegistrationIris()
    expect(second).toEqual(first)
  })

  test('delegated grants: the subtree issued on the first run is reused', async () => {
    // first run replaces the pre-replica delegated grants (their bodies do not
    // exist locally yet) and writes the replica for what it issued; the second
    // run must reuse those delegated grants instead of issuing again
    await regenerate(aliceId, agent(testClientId, INTEROP.Application))
    const first = await applicationRegistrationIris()
    expect(first.length).toBeGreaterThan(0)

    await regenerate(aliceId, agent(testClientId, INTEROP.Application))
    const second = await applicationRegistrationIris()
    expect(second).toEqual(first)
  })
})
