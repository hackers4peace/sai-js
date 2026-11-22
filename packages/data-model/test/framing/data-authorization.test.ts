import { ACCESS_ACTIONS, INTEROP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { DataAuthorization, type FinalDataAuthorizationData } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const AUTH_IRI = 'https://registry/acme/k9m4vp'

// Graph <https://registry/acme/k9m4vp> in the local framing fixture:
// SelectedFromRegistry DataAuthorization with hasDataInstance, plus the child
// authorization r5j8tw pointing inheritsFromAuthorization at it (frames to
// hasInheritingAuthorization via @reverse).
describe('DataAuthorization framing', () => {
  test('frames the DataAuthorization graph into DataAuthorizationData', async () => {
    const doc = await docFromGraphs([AUTH_IRI])
    const data = await DataAuthorization.fromJsonLd(doc, AUTH_IRI)
    expect(data).toEqual({
      id: AUTH_IRI,
      type: [INTEROP.DataAuthorization],
      grantee: 'https://id/alice',
      grantedBy: 'https://id/acme',
      registeredShapeTree: 'https://data/shapetrees/trees/Project',
      scopeOfAuthorization: INTEROP.SelectedFromRegistry,
      dataOwner: 'https://id/acme',
      hasDataRegistration: 'https://data/acme-rnd/reb39k',
      satisfiesAccessNeed: undefined,
      inheritsFromAuthorization: undefined,
      accessMode: [
        ACCESS_ACTIONS.read,
        ACCESS_ACTIONS.create,
        ACCESS_ACTIONS.modify,
        ACCESS_ACTIONS.delete,
      ],
      hasDataInstance: ['https://data/acme-rnd/pbh2yw'],
      hasInheritingAuthorization: ['https://registry/acme/r5j8tw'],
    })
  })
})

describe('DataAuthorization round-trip', () => {
  const allFromRegistryData: FinalDataAuthorizationData = {
    id: 'https://some.iri/da',
    type: [INTEROP.DataAuthorization],
    grantee: 'https://projectron.example/#app',
    grantedBy: 'https://alice.example/#id',
    registeredShapeTree: 'https://solidshapes.example/trees/Project',
    scopeOfAuthorization: INTEROP.AllFromRegistry,
    dataOwner: 'https://alice.example/#id',
    hasDataRegistration: 'https://pro.alice.example/123',
    accessMode: [
      ACCESS_ACTIONS.read,
      ACCESS_ACTIONS.modify,
      ACCESS_ACTIONS.create,
      ACCESS_ACTIONS.delete,
    ],
  }

  test('toJsonLd + fromJsonLd', async () => {
    const doc = DataAuthorization.toJsonLd(allFromRegistryData)
    const result = await DataAuthorization.fromJsonLd(doc, allFromRegistryData.id)
    expect(result).toMatchObject(allFromRegistryData)
  })

  test('toJsonLd + fromJsonLd with hasDataInstance', async () => {
    const data: FinalDataAuthorizationData = {
      ...allFromRegistryData,
      scopeOfAuthorization: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['https://some.iri/a', 'https://some.iri/b'],
    }
    const doc = DataAuthorization.toJsonLd(data)
    const result = await DataAuthorization.fromJsonLd(doc, data.id)
    expect(result).toMatchObject(data)
  })

  test('toJsonLd + fromJsonLd links back to children', async () => {
    const childIri = 'https://some.iri/child'
    const data: FinalDataAuthorizationData = {
      ...allFromRegistryData,
      hasInheritingAuthorization: [childIri],
    }
    const doc = DataAuthorization.toJsonLd(data)
    const result = await DataAuthorization.fromJsonLd(doc, data.id)
    expect(result.hasInheritingAuthorization).toEqual([childIri])
  })
})
