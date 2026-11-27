import { ACCESS_ACTIONS, INTEROP, withContext } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { AccessNeed, dataModelContext } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const NEED_IRI = 'https://data/test-client/public/access-needs#need-project'
const ACCESS_NEEDS_GRAPH = 'https://data/test-client/public/access-needs'

// Graph <https://data/test-client/public/access-needs> in the local framing fixture:
// need-project (AccessRequired), with need-task/image/file inheriting from it
// (frames to hasInheritingNeed via @reverse), and the description sets
// carrying usesLanguage (collected into descriptionLanguages).
describe('AccessNeed framing', () => {
  test('frames the access needs graph into AccessNeedData', async () => {
    const doc = await docFromGraphs([ACCESS_NEEDS_GRAPH])
    const need = await AccessNeed.fromJsonLd(doc, NEED_IRI)
    expect(need).toEqual({
      id: NEED_IRI,
      type: [INTEROP.AccessNeed],
      registeredShapeTree: 'https://data/shapetrees/trees/Project',
      inheritsFromNeed: undefined,
      // reverse values are collected by iterating fromRDF's node list, which
      // is sorted by @id — deterministic: file < image < task
      hasInheritingNeed: [
        'https://data/test-client/public/access-needs#need-file',
        'https://data/test-client/public/access-needs#need-image',
        'https://data/test-client/public/access-needs#need-task',
      ],
      accessMode: [
        ACCESS_ACTIONS.read,
        ACCESS_ACTIONS.create,
        ACCESS_ACTIONS.modify,
        ACCESS_ACTIONS.delete,
      ],
      required: true,
      children: [],
      // a declared set term is always an array
      hasDataInstance: [],
      descriptionLanguages: ['en', 'es'],
    })
  })
})

describe('request-projection fields', () => {
  test('frames requested instances and a registration', async () => {
    const instance1 = 'https://data/alice-home/n1'
    const instance2 = 'https://data/alice-home/n2'
    const registration = 'https://data/alice-home/x1n3cm'
    const doc = withContext(dataModelContext, {
      id: NEED_IRI,
      type: [INTEROP.AccessNeed],
      registeredShapeTree: 'https://data/shapetrees/trees/Project',
      accessMode: [ACCESS_ACTIONS.read],
      required: INTEROP.AccessRequired,
      hasDataInstance: [instance1, instance2],
      hasDataRegistration: registration,
    })
    const need = await AccessNeed.fromJsonLd(doc, NEED_IRI)
    expect(need.hasDataInstance).toEqual([instance1, instance2])
    expect(need.hasDataRegistration).toBe(registration)
  })

  test('leaves instance/registration fields absent on a shape-tree need', async () => {
    const doc = await docFromGraphs([ACCESS_NEEDS_GRAPH])
    const need = await AccessNeed.fromJsonLd(doc, NEED_IRI)
    expect(need.hasDataInstance).toEqual([])
    expect(need.hasDataRegistration).toBeUndefined()
  })
})
