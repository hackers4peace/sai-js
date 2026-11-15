import { INTEROP, LWS, ODRL } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import { Grant } from '../../src'
import { docFromGraphs } from './helpers'

const GRANT_IRI = 'https://registry/acme/p9m2vr'

describe('Grant framing', () => {
  test('frames the ODRL grant graph', async () => {
    const doc = await docFromGraphs([GRANT_IRI])
    const grant = await Grant.fromJsonLd(doc, GRANT_IRI)
    expect(grant.id).toBe(GRANT_IRI)
    expect(grant.type).toContain(LWS.AccessGrant)
    expect(grant.scopeOfGrant).toBe(INTEROP.AllFromRegistry)
    expect(grant.storage).toBe('https://data/acme-rnd/')
    expect(grant.hasDataRegistration).toBe('https://data/acme-rnd/reb39k')
    expect(grant.registeredShapeTree).toBe('https://data/shapetrees/trees/Project')
    expect(grant.hasInheritingGrant).toEqual(['https://registry/acme/hdaymz'])

    const policy = grant.access[0]
    expect(policy.type).toContain(ODRL.Agreement)
    const permission = policy.permission[0]
    expect(permission.assigner).toBe('https://id/acme')
    expect(permission.assignee).toBe('https://id/bob')
    expect(permission.target.type).toContain(ODRL.AssetCollection)
    expect(permission.target.type).toContain(INTEROP.DataRegistration)
    expect(permission.target.source).toEqual(['https://data/acme-rnd/reb39k'])
    expect(permission.target.owner).toBe('https://id/acme')
    expect(permission.target.storage).toBe('https://data/acme-rnd/')
  })
})
