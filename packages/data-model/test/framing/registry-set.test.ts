import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { INTEROP, LDP, SPACE, jsonld, loader, toStore } from '@janeirodigital/interop-utils'
import { DataFactory, Parser } from 'n3'
import { describe, test } from 'vitest'

import { RegistrySet, registrySetAcrJsonLd, registrySetTemplate } from '../../src'
const loadRegistrySet = loader(RegistrySet.fromJsonLd)

import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const REGISTRY_SET_IRI = 'https://registry/alice/'

// Graph <meta:https://registry/alice/> in the local framing fixture: the RegistrySet with
// its nine registries (hasDataRegistry is multi-valued; the agent-side split
// into social-agent, application, invitation and access-request registries).
describe('RegistrySet framing', () => {
  test('frames the registry set graph into RegistrySetData', async () => {
    const doc = await docFromGraphs([`meta:${REGISTRY_SET_IRI}`])
    const fetch = (async () => ({
      ok: true,
      url: REGISTRY_SET_IRI,
      json: async () => doc,
    })) as unknown as WhatwgFetch
    const registrySet = await loadRegistrySet(REGISTRY_SET_IRI, fetch)
    expect(registrySet).toEqual({
      id: REGISTRY_SET_IRI,
      type: [INTEROP.RegistrySet, LDP.Resource, SPACE.Storage],
      hasAuthorizationRegistry: { id: 'https://registry/alice/authorization/' },
      hasGrantRegistry: { id: 'https://registry/alice/grant/' },
      hasSocialAgentRegistry: { id: 'https://registry/alice/social-agent/' },
      hasApplicationRegistry: { id: 'https://registry/alice/application/' },
      hasInvitationRegistry: { id: 'https://registry/alice/invitation/' },
      hasRoleRegistry: { id: 'https://registry/alice/role/' },
      hasActivityRegistry: { id: 'https://registry/alice/activity/' },
      hasAccessRequestRegistry: { id: 'https://registry/alice/access-request/' },
      hasDataRegistry: [{ id: 'https://data/alice-home/' }, { id: 'https://data/alice-work/' }],
    })
  })
})

/**
 * The account bootstrap's registry set (`templates/RegistrySet.ts`, posted by
 * `postBootstrapTriG`) must satisfy the required read model — this is the
 * contract that lets `fromJsonLd` reject a registry set without one of the six
 * core registries instead of returning `{ id: '' }`.
 */
describe('RegistrySet bootstrap template', () => {
  const id = 'https://auth.alice.example/c0ffee/'
  const webId = 'https://alice.example/#me'
  const uas = 'https://auth.alice.example/uas#id'
  const template = registrySetTemplate({
    id,
    webId,
    uas,
    dataRegistry: 'https://pro.alice.example/1/',
  })

  // the bootstrap TriG is RDF, not JSON-LD: parse it and flatten the named
  // graphs into the expanded document a GET would return
  const bootstrapDoc = async (): Promise<unknown> => {
    const quads = new Parser({ format: 'application/trig' }).parse(template)
    return jsonld.fromRDF(
      quads.map((quad) => DataFactory.quad(quad.subject, quad.predicate, quad.object))
    )
  }

  test('declares every registry the read model requires', async () => {
    const registrySet = await RegistrySet.fromJsonLd(await bootstrapDoc(), id)

    expect(registrySet.hasAuthorizationRegistry.id).toBe(`${id}authorization/`)
    expect(registrySet.hasGrantRegistry.id).toBe(`${id}grant/`)
    expect(registrySet.hasSocialAgentRegistry.id).toBe(`${id}social-agent/`)
    expect(registrySet.hasApplicationRegistry.id).toBe(`${id}application/`)
    expect(registrySet.hasInvitationRegistry.id).toBe(`${id}invitation/`)
    expect(registrySet.hasRoleRegistry.id).toBe(`${id}role/`)
    expect(registrySet.hasActivityRegistry?.id).toBe(`${id}activity/`)
    expect(registrySet.hasAccessRequestRegistry?.id).toBe(`${id}access-request/`)
    expect(registrySet.hasDataRegistry).toEqual([{ id: 'https://pro.alice.example/1/' }])
  })

  // the ACR graph is also emitted by `acr.ts` (registrySetAcrJsonLd) — compare
  // the two serializations so the TriG template cannot drift from it
  test('emits the registrySetAcrJsonLd ACR graph', async () => {
    const acr = `${id}.acr`
    const acrQuads = new Parser({ format: 'application/trig' })
      .parse(template)
      .filter((quad) => quad.graph.value === acr)
      .map((quad) => DataFactory.quad(quad.subject, quad.predicate, quad.object))
    const built = await toStore(registrySetAcrJsonLd({ id, owner: { agent: webId, client: uas } }))

    expect(acrQuads).toBeRdfIsomorphic(built)
  })

  test('a registry set without the grant or role registry is malformed', async () => {
    const doc = (await bootstrapDoc()) as Array<Record<string, unknown>>
    const node = doc.find((candidate) => candidate['@id'] === id)!
    delete node[INTEROP.hasGrantRegistry]
    await expect(RegistrySet.fromJsonLd(doc, id)).rejects.toThrow(
      `is missing required term hasGrantRegistry`
    )

    const roleDoc = (await bootstrapDoc()) as Array<Record<string, unknown>>
    delete roleDoc.find((candidate) => candidate['@id'] === id)![INTEROP.hasRoleRegistry]
    await expect(RegistrySet.fromJsonLd(roleDoc, id)).rejects.toThrow(
      `is missing required term hasRoleRegistry`
    )
  })
})
