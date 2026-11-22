import { SHAPETREES } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { ShapeTreeDescription } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const DESCRIPTION_IRI = 'https://data/shapetrees/trees/desc-en#Project'
const DESCRIPTIONS_GRAPH = 'https://data/shapetrees/trees/desc-en'

// Graph <https://data/shapetrees/trees/desc-en> in the local framing fixture: the English
// description set; #Project carries skos:prefLabel (language-tagged).
describe('ShapeTreeDescription framing', () => {
  test('frames the shape tree description into ShapeTreeDescriptionData', async () => {
    const doc = await docFromGraphs([DESCRIPTIONS_GRAPH])
    const description = await ShapeTreeDescription.fromJsonLd(doc, DESCRIPTION_IRI)
    expect(description).toEqual({
      id: DESCRIPTION_IRI,
      type: [SHAPETREES.Description],
      label: { en: 'Projects' },
      definition: undefined,
    })
  })
})
