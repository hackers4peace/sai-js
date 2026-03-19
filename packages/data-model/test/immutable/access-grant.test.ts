import { randomUUID } from 'node:crypto'
import { fetch } from '@janeirodigital/interop-test-utils'
import { ACL, INTEROP } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { test, vi } from 'vitest'
import { AuthorizationAgentFactory, type FinalAccessGrantData } from '../../src'
import { expect } from '../expect'

const webId = 'https://alice.example/#id'
const agentId = 'https://jarvis.alice.example/#agent'

test('should set data and store', async () => {
  const factory = new AuthorizationAgentFactory(webId, agentId, { fetch, randomUUID })
  const immutableDataGrantIri = 'https://auth.alice.example/25b18e05-7f75-4e13-94f6-9950a67a89dd'
  const readableDataGrantIri = 'https://auth.alice.example/7b2bc4ff-b4b8-47b8-96f6-06695f4c5126'
  const immutableDataGrant = {
    id: immutableDataGrantIri,
    grantee: 'https://alice.example/#me',
    dataOwner: 'https://acme.example/#corp',
    grantedBy: 'https://acme.example/#corp',
    registeredShapeTree: 'https://solidshapes.example/trees/Project',
    hasStorage: 'https://finance.acme.example/',
    hasDataRegistration: 'https://finance.acme.example/4f3fbf70-49df-47ce-a573-dc54366b01ad',
    accessMode: [ACL.Read.value, ACL.Write.value],
    scopeOfGrant: INTEROP.AllFromRegistry.value,
  }

  const accessGrantData: FinalAccessGrantData = {
    granted: true,
    grantedBy: webId,
    grantedWith: agentId,
    grantee: 'https://projectron.example/#app',
    hasAccessNeedGroup: 'https://projectron.example/#some-access-group',
    dataGrants: [immutableDataGrant],
  }
  const accessGrantIri = 'https://auth.alice.example/5e8d3d6f-9e61-4e5c-acff-adee83b68ad1'
  const accessGrantQuads = [
    DataFactory.quad(
      DataFactory.namedNode(accessGrantIri),
      INTEROP.hasDataGrant,
      DataFactory.namedNode(immutableDataGrant.id)
    ),
  ]
  const props: (keyof FinalAccessGrantData)[] = [
    'grantedBy',
    'grantedWith',
    'grantee',
    'hasAccessNeedGroup',
  ]
  for (const prop of props) {
    accessGrantQuads.push(
      DataFactory.quad(
        DataFactory.namedNode(accessGrantIri),
        INTEROP[prop],
        DataFactory.namedNode(accessGrantData[prop] as string)
      )
    )
  }
  const accessGrant = factory.immutable.accessGrant(accessGrantIri, accessGrantData)
  expect(accessGrant.dataset).toBeRdfDatasetContaining(...accessGrantQuads)

  const accessGrantPutSpy = vi.spyOn(accessGrant, 'put')
  // @ts-ignore
  accessGrant.factory = { readable: { accessGrant: vi.fn() } }
})
