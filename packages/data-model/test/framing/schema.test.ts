import { INTEROP, withContext } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { DataRegistration, Role, dataModelContext } from '../../src'
import { expect } from '../expect'

const FOREIGN = 'https://example.example/foreign'
const REGISTRATION = 'https://data/alice-home/r1'
const TREE = 'https://data/shapetrees/trees/Project'
const ROLE = 'https://registry/alice/role/1'

/**
 * The frame is the schema (JSON-LD Framing §2.3.2 `@explicit`): a model's
 * `*_TERMS` constant is the frame's property list, so framed output carries
 * exactly `id`, `type` and those terms — never a foreign predicate as a raw-IRI
 * key, and never `[]` for a set term of the shared context the model does not
 * read.
 */
describe('frame-as-schema', () => {
  test('a framed POJO has exactly id, type and the model terms', async () => {
    const doc = withContext(dataModelContext, {
      id: REGISTRATION,
      type: [INTEROP.DataRegistration],
      registeredShapeTree: TREE,
      contains: [],
      // known to the shared context, not to this model
      hasDataGrant: ['https://registry/acme/g1'],
      [FOREIGN]: 'not part of the model',
    })

    const registration = await DataRegistration.fromJsonLd(doc, REGISTRATION)

    expect(Object.keys(registration).toSorted()).toEqual([
      'contains',
      'id',
      'registeredShapeTree',
      // `type` is emitted by the framing algorithm without being in the list
      'type',
    ])
    expect(Object.keys(registration).some((key) => key.includes('http'))).toBe(false)
  })

  test('a language-map model still filters through projectNode', async () => {
    const doc = withContext(dataModelContext, {
      id: ROLE,
      type: [INTEROP.Role],
      label: { en: 'Admins' },
      members: ['https://id/alice'],
      [FOREIGN]: 'not part of the model',
    })

    const role = await Role.fromJsonLd(doc, ROLE)

    // `@explicit` cannot express `@container: '@language'`, so these models
    // keep the context-wide frame and the projection filter
    expect(role.label).toEqual({ en: 'Admins' })
    expect(role.members).toEqual(['https://id/alice'])
    expect(Object.keys(role).some((key) => key.includes('http'))).toBe(false)
  })
})
