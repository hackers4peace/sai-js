import { CONTEXT, CONTEXT_IRI } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { Grant } from '../../src'
import { docFromGraphs } from './helpers'

const GRANT_IRI = 'https://registry/acme/p9m2vr'

describe('Grant framing', () => {
  test('frames the ODRL grant graph', async () => {
    const doc = await docFromGraphs([GRANT_IRI])
    const grant = await Grant.fromJsonLd(doc, GRANT_IRI)
    expect(grant.id).toBe(GRANT_IRI)
    expect(grant.type).toContain(CONTEXT.AccessGrant)
    expect(grant.scopeOfGrant).toBe(CONTEXT.AllFromRegistry)
    expect(grant.storage).toBe('https://data/acme-rnd/')
    expect(grant.hasDataRegistration).toBe('https://data/acme-rnd/reb39k')
    expect(grant.registeredShapeTree).toBe('https://data/shapetrees/trees/Project')
    expect(grant.hasInheritingGrant).toEqual(['https://registry/acme/hdaymz'])

    const policy = grant.access[0]
    expect(policy.type).toContain(CONTEXT.Agreement)
    const permission = policy.permission[0]
    expect(permission.assigner).toBe('https://id/acme')
    expect(permission.assignee).toBe('https://id/bob')
    expect(permission.target.type).toContain(CONTEXT.AssetCollection)
    expect(permission.target.type).toContain(CONTEXT.DataRegistration)
    expect(permission.target.source).toEqual(['https://data/acme-rnd/reb39k'])
    expect(permission.target.owner).toBe('https://id/acme')
    expect(permission.target.storage).toBe('https://data/acme-rnd/')
  })

  test('keeps array containers and multi-valued rdf:type', async () => {
    // the seed carries admin grants as `lws:AccessGrant, interop:AdminGrant`;
    // the LWS type-scoped context must not collapse `type`/`access` to scalars
    const iri = 'https://registry/acme/p9m2vr'
    const doc = (await docFromGraphs([iri])) as Array<Record<string, unknown>>
    const node = doc.find((candidate) => candidate['@id'] === iri)!
    ;(node['@type'] as Array<string>).push(CONTEXT_IRI.AdminGrant)
    const grant = await Grant.fromJsonLd(doc, iri)
    expect(grant.type).toEqual([CONTEXT.AccessGrant, CONTEXT.AdminGrant])
    expect(Array.isArray(grant.access)).toBe(true)
    expect(grant.access[0].type).toContain(CONTEXT.Agreement)
  })
})

describe('Grant scopes and access actions (local fixture)', () => {
  const allFromRegistryIri = 'https://registry/acme/p9m2vr'
  const selectedFromRegistryIri = 'https://registry/acme/g4yhtm'
  const inheritedIri = 'https://registry/acme/hdaymz'

  test('exposes the permission actions', async () => {
    const grant = await Grant.fromJsonLd(
      await docFromGraphs([allFromRegistryIri]),
      allFromRegistryIri
    )
    expect(grant.access[0].permission[0].action).toEqual([
      CONTEXT.read,
      CONTEXT.create,
      CONTEXT.modify,
      CONTEXT.delete,
    ])
  })

  test('frames a SelectedFromRegistry grant', async () => {
    const grant = await Grant.fromJsonLd(
      await docFromGraphs([selectedFromRegistryIri]),
      selectedFromRegistryIri
    )
    expect(grant.scopeOfGrant).toBe(CONTEXT.SelectedFromRegistry)
    expect(grant.hasDataRegistration).toBe('https://data/acme-rnd/reb39k')
    expect(Grant.dataRegistryIri(grant)).toBe('https://data/acme-rnd/')
  })

  test('frames an Inherited grant', async () => {
    const grant = await Grant.fromJsonLd(await docFromGraphs([inheritedIri]), inheritedIri)
    expect(grant.scopeOfGrant).toBe(CONTEXT.Inherited)
    expect(grant.inheritsFromGrant).toBe(allFromRegistryIri)
    expect(grant.hasDataRegistration).toBe('https://data/acme-rnd/x0md9s')
    expect(Grant.dataRegistryIri(grant)).toBe('https://data/acme-rnd/')
  })
})
