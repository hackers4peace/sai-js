import { randomUUID } from 'node:crypto'

import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  getApplicationRegistration,
  getSocialAgentRegistration,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { type AgentId, getAccessGrantIris } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import { Client, Connection } from '@temporalio/client'
import { describe, expect, test } from 'vitest'

import { waitFor, waitForQuiescence } from './util'

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
const acmeRegForAlice = 'https://registry/acme/je0s7n'
const seedGrant = 'https://registry/acme/g4yhtm'
const seedChildGrant = 'https://registry/acme/wpqyds'

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
  // the registration PATCH fires a reciprocal webhook that starts a second
  // regeneration (the delegated-grants consumer); wait for it to settle before
  // the test reads the projection, otherwise the two runs race and the read
  // sees an intermediate set
  await waitForQuiescence([acmeId, aliceId])
}

/** Fresh read of acme's registration of alice (the reused source tree). */
async function acmeRegistrationIris(): Promise<string[]> {
  const session = await buildSessionManager().getSession(acmeId)
  const registration = await getSocialAgentRegistration(
    localSparqlTransport(session.sparqlEndpoint),
    acmeRegForAlice
  )
  return getAccessGrantIris(registration).toSorted()
}

/** Fresh read of alice's registration of the test client (source + delegated). */
async function applicationRegistrationIris(): Promise<string[]> {
  const session = await buildSessionManager().getSession(aliceId)
  const listed = await session.findApplicationRegistration(testClientId)
  if (!listed) {
    throw new Error('alice has no registration of the test client')
  }
  const registration = await getApplicationRegistration(
    localSparqlTransport(session.sparqlEndpoint),
    listed.id
  )
  return getAccessGrantIris(registration).toSorted()
}

/**
 * The projection after a regeneration can still move: the registration PATCH
 * fires a reciprocal webhook that starts a second (consumer) regeneration.
 * Wait until two consecutive reads agree before asserting on it.
 */
async function stableApplicationRegistrationIris(): Promise<string[]> {
  let previous: string | undefined
  const result = await waitFor<string[] | false>(async () => {
    const current = await applicationRegistrationIris()
    const key = current.join(',')
    if (previous !== undefined && key === previous) {
      return current
    }
    previous = key
    return false
  })
  if (result === false) {
    throw new Error('registration projection never stabilized')
  }
  return result
}

describe('checkEquivalence — unchanged regeneration keeps the same IRIs', () => {
  test('source grants: the seeded subtree survives and children are re-linked', async () => {
    await regenerate(acmeId, agent(aliceId, INTEROP.SocialAgent))
    const first = await acmeRegistrationIris()
    // the seed links both the parent and its inherited child
    expect(first).toContain(seedGrant)
    expect(first).toContain(seedChildGrant)

    await regenerate(acmeId, agent(aliceId, INTEROP.SocialAgent))
    const second = await acmeRegistrationIris()
    expect(second).toEqual(first)
  }, 40_000)

  test('delegated grants: the subtree in the assigner registry is reused', async () => {
    // The seed already stores Alice's delegated grants in Alice's own registry.
    // Both runs must reuse the unchanged tree instead of issuing new IRIs.
    await regenerate(aliceId, agent(testClientId, INTEROP.Application))
    const first = await stableApplicationRegistrationIris()
    expect(first.length).toBeGreaterThan(0)

    await regenerate(aliceId, agent(testClientId, INTEROP.Application))
    const second = await stableApplicationRegistrationIris()
    expect(second).toEqual(first)
  }, 40_000)
})
