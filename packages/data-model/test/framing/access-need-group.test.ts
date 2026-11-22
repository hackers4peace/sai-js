import { INTEROP } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { AccessNeedGroup } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const GROUP_IRI = 'https://data/test-client/public/access-needs#need-group-pm'
const ACCESS_NEEDS_GRAPH = 'https://data/test-client/public/access-needs'

// Graph <https://data/test-client/public/access-needs> in the local framing fixture:
// need-group-pm containing need-project.
describe('AccessNeedGroup framing', () => {
  test('frames the access needs graph into AccessNeedGroupData', async () => {
    const doc = await docFromGraphs([ACCESS_NEEDS_GRAPH])
    const group = await AccessNeedGroup.fromJsonLd(doc, GROUP_IRI)
    expect(group).toEqual({
      id: GROUP_IRI,
      type: [INTEROP.AccessNeedGroup],
      hasAccessNeed: ['https://data/test-client/public/access-needs#need-project'],
      accessNeeds: [],
    })
  })
})
