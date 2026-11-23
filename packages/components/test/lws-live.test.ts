import {
  AgentRegistry,
  getDataRegistration,
  listContained,
  loadDataInstance,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { containedIrisJsonLd, fetchJsonLd, putJsonLd } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { buildSessionManager } from '../src/builders/sessionManager.js'

// Live check against the compose stack (skipped in CI/unit runs).
describe.skipIf(!process.env.LWS_LIVE)('LWS session (live)', () => {
  test('builds a dan session and reads the LWS registry set', async () => {
    const manager = buildSessionManager()
    const session = await manager.getSession('https://dan.id.docker')
    expect(session.registrySet.id).toBe('https://reg.docker/dan/')
    expect(session.registrySet.hasDataRegistry.map((registry) => registry.id)).toEqual([
      'https://dan-east.data.docker/',
      'https://dan-west.data.docker/',
    ])
  }, 60_000)

  test('creates a data instance in a registration with POST and writes it with PUT', async () => {
    const manager = buildSessionManager()
    const session = await manager.getSession('https://bob.id.docker')
    const registration = 'https://bob.data.docker/avn9hv'
    const created = await session.fetch(registration, {
      method: 'POST',
      headers: { slug: crypto.randomUUID(), 'content-type': 'application/ld+json' },
      body: '[]',
    })
    expect(created.status).toBe(201)
    const id = created.headers.get('location')
    expect(id).toBeTruthy()
    await putJsonLd(id!, session.fetch, {
      '@id': id!,
      '@type': 'https://vocab.example/project-management/Project',
      'http://www.w3.org/2004/02/skos/core#prefLabel': 'LWS write test',
    })
    const read = (await fetchJsonLd(id!, session.fetch)) as Array<Record<string, unknown>>
    const node = read.find((entry) => entry['@id'] === id)
    expect(node?.['http://www.w3.org/2004/02/skos/core#prefLabel']).toEqual([
      { '@value': 'LWS write test' },
    ])
    const deleted = await session.fetch(id!, { method: 'DELETE' })
    expect(deleted.status).toBeLessThan(300)
  }, 60_000)

  test('creates a social agent registration container with its description', async () => {
    const manager = buildSessionManager()
    const session = await manager.getSession('https://bob.id.docker')
    // idempotent: remove a registration left behind by an earlier failed run
    const existing = await session.findSocialAgentRegistration('https://kim.id.docker')
    if (existing) await session.fetch(existing.id, { method: 'DELETE' })
    const registration = await AgentRegistry.addSocialAgentRegistration(
      session.registrySet.hasSocialAgentRegistry,
      { fetch: session.fetch, randomUUID: crypto.randomUUID.bind(crypto) },
      localSparqlTransport(session.sparqlEndpoint),
      { agent: session.webId, client: session.agentId },
      'https://kim.id.docker',
      { '@none': 'Kim' }
    )
    expect(registration.id.startsWith(session.registrySet.hasSocialAgentRegistry.id)).toBe(true)
    const listed = await listContained(
      localSparqlTransport(session.sparqlEndpoint),
      session.registrySet.hasSocialAgentRegistry.id
    )
    expect(listed).toContain(registration.id)
    const found = await session.findSocialAgentRegistration('https://kim.id.docker')
    expect(found?.id).toBe(registration.id)
    await session.fetch(registration.id, { method: 'DELETE' })
  }, 60_000)

  test('lists registry members stored as lws:contains over HTTP', async () => {
    const manager = buildSessionManager()
    const yoyo = await manager.getSession('https://yoyo.id.docker')
    const adminAuthorizations = await yoyo.adminAuthorizations()
    expect(adminAuthorizations.map((entry) => entry.id)).toContain(
      'https://reg.docker/yoyo/authorization/gwxh7q'
    )
    const listedAuthorizations = await containedIrisJsonLd(
      yoyo.registrySet.hasAuthorizationRegistry.id,
      yoyo.fetch
    )
    expect(listedAuthorizations).toContain('https://reg.docker/yoyo/authorization/gwxh7q')

    const alice = await manager.getSession('https://alice.id.docker')
    const role = 'https://reg.docker/alice/role/j1g128'
    const listedRoles = await containedIrisJsonLd(alice.registrySet.hasRoleRegistry.id, alice.fetch)
    expect(listedRoles).toContain(role)
  }, 60_000)

  test('fetches a peer registration from another storage on the same server', async () => {
    const manager = buildSessionManager()
    const bob = await manager.getSession('https://bob.id.docker')
    // acme's registration of bob is outside bob's storages; the request must
    // use the challenge storage (acme), not bob's registry pod
    const doc = (await fetchJsonLd(
      'https://reg.docker/acme/social-agent/m4k9wp/',
      bob.fetch
    )) as Array<Record<string, unknown>>
    const registration = doc.find(
      (node) => node['@id'] === 'https://reg.docker/acme/social-agent/m4k9wp/'
    )
    expect(registration?.['http://www.w3.org/ns/solid/interop#registeredAgent']).toEqual([
      { '@id': 'https://bob.id.docker' },
    ])
  }, 60_000)

  test('reads a flat data instance through its lws:partOf registration', async () => {
    const manager = buildSessionManager()
    const session = await manager.getSession('https://bob.id.docker')
    const registration = await session.findDataRegistration(
      'https://bob.data.docker/',
      'https://shapetrees.hackers4peace.net/trees/Project'
    )
    expect(registration?.id).toBe('https://bob.data.docker/avn9hv')
    expect(registration?.contains).toContain('https://bob.data.docker/gl1tch')
    expect(registration?.partOf).toBe('https://bob.data.docker/')

    const endpoint = session.sparqlEndpoints.get('https://bob.data.docker/')!
    const fromSparql = await getDataRegistration(
      localSparqlTransport(endpoint),
      'https://bob.data.docker/avn9hv'
    )
    expect(fromSparql.registeredShapeTree).toBe(
      'https://shapetrees.hackers4peace.net/trees/Project'
    )

    const instance = await loadDataInstance(
      'https://bob.data.docker/gl1tch',
      session.fetch,
      undefined,
      'en',
      'https://bob.data.docker/avn9hv'
    )
    expect(instance.label).toBe('Glitch')
    expect(instance.shapeTreeIri).toBe('https://shapetrees.hackers4peace.net/trees/Project')
  }, 60_000)
})
