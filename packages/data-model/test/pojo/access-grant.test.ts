import { ACCESS_ACTIONS, INTEROP, LWS, ODRL, RDF, toStore } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, expect, test } from 'vitest'

import { Grant, grantAccess } from '../../src'
import type { FinalGrantData, GrantTargetInput } from '../../src'

const snippetIri = 'https://some.iri/'
const GRANTEE = 'https://id/bob'
const STORAGE = 'https://pro.alice.example/'
const REGISTRATION = 'https://pro.alice.example/123'
const SHAPE_TREE = 'https://solidshapes.example/tree/Project'
const DATA_OWNER = 'https://alice.example/#id'

function targetInput(
  scopeOfGrant: string,
  extra: Partial<GrantTargetInput> = {}
): GrantTargetInput {
  return {
    scopeOfGrant,
    owner: DATA_OWNER,
    storage: STORAGE,
    hasDataRegistration: REGISTRATION,
    registeredShapeTree: SHAPE_TREE,
    ...extra,
  }
}

function grantData(
  scopeOfGrant: string,
  extra: Partial<FinalGrantData> = {},
  targetExtra: Partial<GrantTargetInput> = {}
): FinalGrantData {
  return {
    id: snippetIri,
    type: [LWS.AccessGrant],
    storage: STORAGE,
    access: grantAccess({
      ...targetInput(scopeOfGrant, targetExtra),
      assigner: DATA_OWNER,
      assignee: GRANTEE,
      actions: [ACCESS_ACTIONS.read],
    }),
    grantedBy: DATA_OWNER,
    dataOwner: DATA_OWNER,
    registeredShapeTree: SHAPE_TREE,
    hasDataRegistration: REGISTRATION,
    scopeOfGrant,
    ...extra,
  }
}

describe('toJsonLd', () => {
  test('writes the ODRL grant shape', async () => {
    const grant = grantData(INTEROP.AllFromRegistry)
    const store = await toStore(Grant.toJsonLd(grant), snippetIri)
    const subject = DataFactory.namedNode(snippetIri)

    expect(store.getQuads(subject, RDF.terms.type, LWS.terms.AccessGrant, null)).toHaveLength(1)
    expect(store.getQuads(subject, INTEROP.terms.scopeOfGrant, null, null)[0].object.value).toBe(
      INTEROP.AllFromRegistry
    )
    expect(store.getQuads(subject, LWS.terms.storage, null, null)).toHaveLength(0)

    const policy = store.getQuads(subject, LWS.terms.access, null, null)[0].object
    expect(store.getQuads(policy, RDF.terms.type, ODRL.terms.Agreement, null)).toHaveLength(1)
    expect(store.getQuads(policy, ODRL.terms.profile, null, null)[0].object.value).toBe(
      INTEROP.AccessProfile
    )

    const permission = store.getQuads(policy, ODRL.terms.permission, null, null)[0].object
    expect(store.getQuads(permission, ODRL.terms.assigner, null, null)[0].object.value).toBe(
      DATA_OWNER
    )
    expect(store.getQuads(permission, ODRL.terms.assignee, null, null)[0].object.value).toBe(
      GRANTEE
    )
    expect(store.getQuads(permission, ODRL.terms.action, null, null)[0].object.value).toBe(
      ACCESS_ACTIONS.read
    )

    const target = store.getQuads(permission, ODRL.terms.target, null, null)[0].object
    expect(store.getQuads(target, RDF.terms.type, ODRL.terms.AssetCollection, null)).toHaveLength(1)
    expect(
      store.getQuads(target, RDF.terms.type, INTEROP.terms.DataRegistration, null)
    ).toHaveLength(1)
    expect(store.getQuads(target, ODRL.terms.source, null, null)[0].object.value).toBe(REGISTRATION)
    expect(store.getQuads(target, INTEROP.terms.dataOwner, null, null)[0].object.value).toBe(
      DATA_OWNER
    )
    expect(store.getQuads(target, LWS.terms.storage, null, null)[0].object.value).toBe(STORAGE)
  })

  test('uses one permission per selected resource', async () => {
    const instances = ['https://some.iri/a', 'https://some.iri/b']
    const grant = grantData(
      INTEROP.SelectedFromRegistry,
      { hasDataInstance: instances },
      { hasDataInstance: instances }
    )
    const store = await toStore(Grant.toJsonLd(grant), snippetIri)
    const policy = store.getQuads(
      DataFactory.namedNode(snippetIri),
      LWS.terms.access,
      null,
      null
    )[0].object
    const permissions = store.getQuads(policy, ODRL.terms.permission, null, null)
    expect(permissions).toHaveLength(2)
    const sources = permissions
      .map(
        (permission) => store.getQuads(permission.object, ODRL.terms.target, null, null)[0].object
      )
      .map((target) => store.getQuads(target, ODRL.terms.source, null, null)[0].object.value)
      .toSorted()
    expect(sources).toEqual([...instances].toSorted())
  })

  test('writes an AllFromAgent target with a shape tree and no registration', async () => {
    const agent = 'https://id/yoyo#id'
    const grant = grantData(INTEROP.AllFromAgent, {}, { agent })
    const store = await toStore(Grant.toJsonLd(grant), snippetIri)
    const policy = store.getQuads(
      DataFactory.namedNode(snippetIri),
      LWS.terms.access,
      null,
      null
    )[0].object
    const permission = store.getQuads(policy, ODRL.terms.permission, null, null)[0].object
    const target = store.getQuads(permission, ODRL.terms.target, null, null)[0].object

    expect(store.getQuads(target, RDF.terms.type, INTEROP.terms.SocialAgent, null)).toHaveLength(1)
    expect(store.getQuads(target, ODRL.terms.source, null, null)[0].object.value).toBe(agent)
    expect(
      store.getQuads(target, INTEROP.terms.registeredShapeTree, null, null)[0].object.value
    ).toBe(SHAPE_TREE)
    expect(store.getQuads(target, INTEROP.terms.hasDataRegistration, null, null)).toHaveLength(0)
    expect(store.getQuads(policy, INTEROP.terms.registeredShapeTree, null, null)).toHaveLength(0)
  })

  test('keeps the inherited link', async () => {
    const parent = 'https://some.iri/gr'
    const grant = grantData(INTEROP.Inherited, { inheritsFromGrant: parent })
    const store = await toStore(Grant.toJsonLd(grant), snippetIri)
    expect(
      store.getQuads(
        DataFactory.namedNode(snippetIri),
        INTEROP.terms.inheritsFromGrant,
        null,
        null
      )[0].object.value
    ).toBe(parent)
  })

  test('frames back through the canonical reader', async () => {
    const grant = grantData(INTEROP.AllFromRegistry)
    const roundTripped = await Grant.fromJsonLd(Grant.toJsonLd(grant), snippetIri)
    expect(roundTripped.storage).toBe(STORAGE)
    expect(roundTripped.dataOwner).toBe(DATA_OWNER)
    expect(roundTripped.hasDataRegistration).toBe(REGISTRATION)
    expect(roundTripped.registeredShapeTree).toBe(SHAPE_TREE)
    expect(roundTripped.access[0].permission[0].action).toEqual([ACCESS_ACTIONS.read])
  })
})
