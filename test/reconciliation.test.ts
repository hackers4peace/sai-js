import { buildSessionManager } from '@elfpavlik/sai-components'
import {
  getSocialAgentRegistration,
  localSparqlTransport,
  presentGraphs,
} from '@janeirodigital/interop-authorization-agent'
import { ActivityRegistry } from '@janeirodigital/interop-authorization-agent'
import { type AuthorizationGranted, getDataGrantIris } from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import { Client, Connection } from '@temporalio/client'
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint'
import { describe, expect, test } from 'vitest'

import { waitFor, waitForQuiescence } from './util'

const acmeId = 'https://id/acme'
const aliceId = 'https://id/alice'
const bobId = 'https://id/bob'
const acmeRegForAlice = 'https://registry/acme/social-agent/je0s7n/'
const seedGrant = 'https://registry/acme/grant/g4yhtm'
const seedChildGrant = 'https://registry/acme/grant/wpqyds'
// bob's mirror of acme: acme's registration of bob + the grants it links
const acmeRegForBob = 'https://registry/acme/social-agent/m4k9wp/'
const mirroredGrant = 'https://registry/acme/grant/p9m2vr'
const GRANT_PREDICATE = 'http://www.w3.org/ns/solid/interop#hasDataGrant'

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
    await waitForQuiescence([acmeId, aliceId, bobId])
  })

  test('re-creates grants deleted from the registry with no pending activity (drift arm)', async () => {
    const manager = buildSessionManager()
    const acmeSession = await manager.getSession(acmeId)
    const transport = localSparqlTransport(acmeSession.sparqlEndpoint)

    // the authorizations stay; only the grants are gone (direct owner delete —
    // no activity row, so the pending-activity drain can never see this)
    for (const grantIri of [seedGrant, seedChildGrant]) {
      const response = await acmeSession.fetch(grantIri, { method: 'DELETE' })
      // CSS answers a successful DELETE with 205 Reset Content; 404 keeps the
      // delete idempotent (already gone)
      expect(response.ok || response.status === 404).toBe(true)
    }

    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    })
    const client = new Client({ connection })
    try {
      await client.workflow.execute('reconcileActivities', {
        taskQueue: 'create-grants',
        args: [{ webId: { id: acmeId, type: [INTEROP.SocialAgent] } }],
        workflowId: 'reconciliation-drift-test',
      })
    } finally {
      await connection.close()
    }

    // the sweep re-derives every registered grantee from the authorization
    // state; the deleted bodies are not reusable, so the grants are created
    // again (new IRIs) and the projection is re-linked
    await waitFor(
      async () => {
        const current = await getSocialAgentRegistration(transport, acmeRegForAlice)
        const iris = await getDataGrantIris(current)
        return iris.length > 0 && !iris.includes(seedGrant) && !iris.includes(seedChildGrant)
      },
      { timeout: 30_000 }
    )
    await waitForQuiescence([acmeId, aliceId, bobId])
  })
})

describe('reciprocal mirror reconciliation (C5 #2)', () => {
  const fetcher = new SparqlEndpointFetcher()

  test('restores a mirror body missing with no pending activity (local completeness)', async () => {
    const manager = buildSessionManager()
    const bobSession = await manager.getSession(bobId)
    const transport = localSparqlTransport(bobSession.sparqlEndpoint)

    // the peer registration still links the grant, but the mirrored body is
    // gone (graph-at-a-time loss — no activity, no notification)
    expect(await presentGraphs(transport, [mirroredGrant])).toContain(mirroredGrant)
    await fetcher.fetchUpdate(
      bobSession.sparqlEndpoint,
      `DROP SILENT GRAPH <${mirroredGrant}>; DROP SILENT GRAPH <meta:${mirroredGrant}>;`
    )
    expect(await presentGraphs(transport, [mirroredGrant])).not.toContain(mirroredGrant)

    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    })
    const client = new Client({ connection })
    try {
      await client.workflow.execute('reconcileActivities', {
        taskQueue: 'create-grants',
        args: [{ webId: { id: bobId, type: [INTEROP.SocialAgent] } }],
        workflowId: 'mirror-completeness-test',
      })
    } finally {
      await connection.close()
    }

    // the sync re-fetches the still-linked grant (presence oracle)
    await waitFor(
      async () => (await presentGraphs(transport, [mirroredGrant])).has(mirroredGrant),
      { timeout: 30_000 }
    )
    await waitForQuiescence([bobId, acmeId])
  })

  test('drops an upstream grant whose webhook was missed (peer freshness)', async () => {
    const manager = buildSessionManager()
    const acmeSession = await manager.getSession(acmeId)
    const bobSession = await manager.getSession(bobId)
    const bobTransport = localSparqlTransport(bobSession.sparqlEndpoint)

    // bob's mirror currently links the grant
    const before = await getSocialAgentRegistration(bobTransport, acmeRegForBob)
    expect(before.hasDataGrant ?? []).toContain(mirroredGrant)

    // remove the link from acme's registration via direct SPARQL (no CSS
    // notification → bob's reciprocal webhook is never delivered)
    await fetcher.fetchUpdate(
      acmeSession.sparqlEndpoint,
      `DELETE DATA {
  GRAPH <${acmeRegForBob}> { <${acmeRegForBob}> <${GRANT_PREDICATE}> <${mirroredGrant}> }
};
DELETE DATA {
  GRAPH <meta:${acmeRegForBob}> { <${acmeRegForBob}> <${GRANT_PREDICATE}> <${mirroredGrant}> }
};`
    )

    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    })
    const client = new Client({ connection })
    try {
      await client.workflow.execute('reconcilePeerMirrors', {
        taskQueue: 'create-grants',
        args: [{ webId: { id: bobId, type: [INTEROP.SocialAgent] } }],
        workflowId: 'mirror-freshness-test',
      })
    } finally {
      await connection.close()
    }

    // the freshness sync re-fetches acme's registration and drops the unlinked
    // grant from bob's mirror
    await waitFor(
      async () => {
        const after = await getSocialAgentRegistration(bobTransport, acmeRegForBob)
        return !(after.hasDataGrant ?? []).includes(mirroredGrant)
      },
      { timeout: 30_000 }
    )
    await waitForQuiescence([bobId, acmeId])
  })
})
