import { ACCESS_ACTIONS, INTEROP, RDF, toStore } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, test } from 'vitest'

import { DataAuthorization, type FinalDataAuthorizationData } from '../../src'
import { expect } from '../expect'

const webId = 'https://alice.example/#id'
const snippetIri = 'https://some.iri/'
const commonData = {
  type: [INTEROP.DataAuthorization],
  grantee: 'https://projectron.example/#app',
  grantedBy: webId,
  registeredShapeTree: 'https://solidshapes.example/tree/Project',
  hasDataRegistration: 'https://pro.alice.example/123',
  accessMode: [ACCESS_ACTIONS.read],
}
const commonQuads = [
  DataFactory.quad(
    DataFactory.namedNode(snippetIri),
    RDF.terms.type,
    INTEROP.terms.DataAuthorization
  ),
  DataFactory.quad(
    DataFactory.namedNode(snippetIri),
    INTEROP.terms.grantee,
    DataFactory.namedNode(commonData.grantee)
  ),
  DataFactory.quad(
    DataFactory.namedNode(snippetIri),
    INTEROP.terms.grantedBy,
    DataFactory.namedNode(commonData.grantedBy)
  ),
  DataFactory.quad(
    DataFactory.namedNode(snippetIri),
    INTEROP.terms.registeredShapeTree,
    DataFactory.namedNode(commonData.registeredShapeTree)
  ),
  DataFactory.quad(
    DataFactory.namedNode(snippetIri),
    INTEROP.terms.hasDataRegistration,
    DataFactory.namedNode(commonData.hasDataRegistration)
  ),
  DataFactory.quad(
    DataFactory.namedNode(snippetIri),
    INTEROP.terms.accessMode,
    ACCESS_ACTIONS.read
  ),
]

async function toJsonLdAndCheck(
  data: Omit<FinalDataAuthorizationData, 'id'>,
  expectedQuads: Array<any>
) {
  const finalData: FinalDataAuthorizationData = { id: snippetIri, ...data }
  const dataset = await toStore(DataAuthorization.toJsonLd(finalData), snippetIri)
  expect(dataset).toBeRdfDatasetContaining(...expectedQuads)
}

describe('toJsonLd', () => {
  test('should set dataset for AllFromRegistry scope', async () => {
    const allFromRegistryData = {
      dataOwner: 'https://alice.example/#id',
      scopeOfAuthorization: INTEROP.AllFromRegistry,
      ...commonData,
    }
    const allFromRegistryQuads = [
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.dataOwner,
        DataFactory.namedNode(allFromRegistryData.dataOwner)
      ),
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.scopeOfAuthorization,
        INTEROP.terms.AllFromRegistry
      ),
      ...commonQuads,
    ]

    await toJsonLdAndCheck(allFromRegistryData, allFromRegistryQuads)
  })

  test('should set dataset for SelectedFromRegistry scope', async () => {
    const selectedFromRegistryData = {
      dataOwner: 'https://alice.example/#id',
      scopeOfAuthorization: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['https://some.iri/a', 'https://some.iri/b'],
      ...commonData,
    }
    const selectedFromRegistryQuads = [
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.dataOwner,
        DataFactory.namedNode(selectedFromRegistryData.dataOwner)
      ),
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.scopeOfAuthorization,
        INTEROP.terms.SelectedFromRegistry
      ),
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.hasDataInstance,
        DataFactory.namedNode('https://some.iri/a')
      ),
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.hasDataInstance,
        DataFactory.namedNode('https://some.iri/b')
      ),
      ...commonQuads,
    ]

    await toJsonLdAndCheck(selectedFromRegistryData, selectedFromRegistryQuads)
  })

  test('should set dataset for Inherited scope', async () => {
    const inheritedData = {
      dataOwner: 'https://alice.example/#id',
      scopeOfAuthorization: INTEROP.Inherited,
      inheritsFromAuthorization: 'https://some.iri/gr',
      ...commonData,
    }
    const inheritedQuads = [
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.dataOwner,
        DataFactory.namedNode(inheritedData.dataOwner)
      ),
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.scopeOfAuthorization,
        INTEROP.terms.Inherited
      ),
      DataFactory.quad(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.inheritsFromAuthorization,
        DataFactory.namedNode(inheritedData.inheritsFromAuthorization)
      ),
      ...commonQuads,
    ]

    await toJsonLdAndCheck(inheritedData, inheritedQuads)
  })

  test('links back to children', async () => {
    const childIri = 'https://some.iri/child'

    const allFromRegistryData = {
      dataOwner: 'https://alice.example/#id',
      scopeOfAuthorization: INTEROP.AllFromRegistry,
      hasInheritingAuthorization: [childIri],
      ...commonData,
    }

    const finalData: FinalDataAuthorizationData = { id: snippetIri, ...allFromRegistryData }
    const dataset = await toStore(DataAuthorization.toJsonLd(finalData), snippetIri)

    const linkBackQuad = DataFactory.quad(
      DataFactory.namedNode(childIri),
      INTEROP.terms.inheritsFromAuthorization,
      DataFactory.namedNode(snippetIri)
    )
    expect(dataset).toBeRdfDatasetContaining(linkBackQuad)
  })
})
