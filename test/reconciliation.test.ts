import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  getSocialAgentRegistration,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import { type AuthorizationGranted, getDataGrantIris } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import { Client, Connection } from '@temporalio/client'
import { describe, expect, test } from 'vitest'

import { waitFor } from './util'

const acmeId = 'https://id/acme'
const aliceId = 'https://id/alice'
const acmeRegForAlice = 'https://registry/acme/social-agent/je0s7n/'
const seedGrant = 'https://registry/acme/grant/g4yhtm'
const seedChildGrant = 'https://registry/acme/grant/wpqyds'

describe('reconciliation sweep', () => {
  test('processes a pending activity that was never delivered', async () => {
    const manager = buildSessionManager()
    const acmeSession = await manager.getSession(acmeId)

    // acme has NO pre-seeded activity-webhook channel → CSS never delivers →
    // the activity stays unprocessed until the sweep processes it. The
    // grantee rides the object (the seeded DataAuthorization for alice).
    const registry = acmeSession.registrySet.hasActivityRegistry!
    // embedded single-DA form (refinement §5.1) — the seed DA `k9m4vp` (a
    // real-id embedded projection; the materialize step find-first skips the
    // already-existing resource) rides the object; the parent groups by
    // grantee → one child regenerates alice's grants
    const activity: Omit<AuthorizationGranted, 'id'> = {
      type: ['Activity', 'AuthorizationGranted'],
      actor: acmeId,
      target: acmeSession.registrySet.hasAuthorizationRegistry.id,
      object: [
        {
          id: 'https://registry/acme/authorization/k9m4vp',
          type: [INTEROP.DataAuthorization],
          grantee: aliceId,
          grantedBy: acmeId,
          registeredShapeTree: 'https://data/shapetrees/trees/Project',
          scopeOfAuthorization: INTEROP.SelectedFromRegistry,
          dataOwner: acmeId,
          hasDataRegistration: 'https://data/acme-rnd/reb39k/',
          accessMode: [
            'http://www.w3.org/ns/auth/acl#Read',
            'http://www.w3.org/ns/auth/acl#Create',
            'http://www.w3.org/ns/auth/acl#Update',
            'http://www.w3.org/ns/auth/acl#Delete',
          ],
          hasDataInstance: ['https://data/acme-rnd/reb39k/pbh2yw'],
        },
      ],
      createdAt: new Date().toISOString(),
    }
    const created = await ActivityRegistry.createActivity(
      registry,
      { fetch: acmeSession.fetch, randomUUID: acmeSession.randomUUID },
      activity
    )

    // run the sweep (executed by workflow type name — registered on the worker)
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    })
    const client = new Client({ connection })
    await client.workflow.execute('reconcileActivities', {
      taskQueue: 'create-grants',
      args: [{ webId: { id: acmeId, type: [INTEROP.SocialAgent] } }],
      workflowId: 'reconciliation-test',
    })

    // the consumer drained it: a completion referencing the activity exists,
    // and alice's grants regenerated
    await waitFor(
      async () => {
        const completed = await ActivityRegistry.getCompletedActivityIris(
          registry,
          acmeSession.fetch
        )
        return completed.includes(created.id)
      },
      { timeout: 30_000 }
    )
    const regForAlice = await getSocialAgentRegistration(
      localSparqlTransport(acmeSession.sparqlEndpoint),
      acmeRegForAlice
    )
    const iris = await getDataGrantIris(regForAlice)
    expect(iris.length).toBeGreaterThan(0)
    // real equivalence (source trees): the unchanged seed subtree is REUSED —
    // same IRIs after the regeneration. The seed links only the parent; the
    // reused child is re-linked from the parent's `hasInheritingGrant`.
    expect(iris).toContain(seedGrant)
    expect(iris).toContain(seedChildGrant)
  })
})
