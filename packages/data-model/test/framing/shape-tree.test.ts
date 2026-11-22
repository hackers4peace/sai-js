import { SHAPETREES } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { ShapeTree } from '../../src'
import { expect } from '../expect'
import { docFromGraphs, fixtureFetch } from './helpers'

const TREE_IRI = 'https://data/shapetrees/trees/Project'
const TREE_GRAPH = 'https://data/shapetrees/trees/Project'

// Graph <https://data/shapetrees/trees/Project> in the local framing fixture:
// ShapeTree with expectsType, shape, describesInstance (skos:prefLabel), three
// references (hasShapeTree/viaPredicate nodes) and the description sets
// carrying usesLanguage. The read path frames the node-level properties and
// extracts references + descriptionLanguages from the expanded document; the
// toJsonLd round-trip below exercises the shape tree context.
describe('ShapeTree framing', () => {
  test('converts the shape tree graph into ShapeTreeData', async () => {
    const doc = await docFromGraphs([TREE_GRAPH])
    const tree = await ShapeTree.fromJsonLd(doc, TREE_IRI)
    expect({
      ...tree,
      // viaPredicate is a NamedNode in ShapeTreeData (quad-based read path)
      references: tree.references.map((reference) => ({
        shapeTree: reference.shapeTree,
        viaPredicate: reference.viaPredicate.value,
      })),
    }).toEqual({
      id: TREE_IRI,
      type: [SHAPETREES.ShapeTree],
      shape: 'https://data/shapetrees/shapes/Project',
      describesInstance: 'http://www.w3.org/2004/02/skos/core#prefLabel',
      expectsType: SHAPETREES.Resource,
      descriptionLanguages: ['en', 'es', 'pl'],
      references: [
        {
          shapeTree: 'https://data/shapetrees/trees/Task',
          viaPredicate: 'https://vocab.example/project-management/hasTask',
        },
        {
          shapeTree: 'https://data/shapetrees/trees/Image',
          viaPredicate: 'https://vocab.example/project-management/hasImage',
        },
        {
          shapeTree: 'https://data/shapetrees/trees/File',
          viaPredicate: 'https://vocab.example/project-management/hasFile',
        },
      ],
    })
  })

  test('toJsonLd round-trips through fromJsonLd', async () => {
    const doc = await docFromGraphs([TREE_GRAPH])
    const tree = await ShapeTree.fromJsonLd(doc, TREE_IRI)
    const roundTripped = await ShapeTree.fromJsonLd(ShapeTree.toJsonLd(tree), TREE_IRI)
    expect(roundTripped.shape).toBe(tree.shape)
    expect(roundTripped.type).toEqual(tree.type)
    expect(roundTripped.describesInstance).toBe(tree.describesInstance)
    expect(roundTripped.expectsType).toBe(tree.expectsType)
    expect(roundTripped.descriptionLanguages).toEqual(tree.descriptionLanguages)
    expect(
      roundTripped.references.map((reference) => [
        reference.shapeTree,
        reference.viaPredicate.value,
      ])
    ).toEqual(
      tree.references.map((reference) => [reference.shapeTree, reference.viaPredicate.value])
    )
  })
})

describe('ShapeTree.getDescription (local fixture)', () => {
  test('returns the description for a language', async () => {
    const tree = await ShapeTree.fromJsonLd(await docFromGraphs([TREE_GRAPH]), TREE_IRI)
    expect((await ShapeTree.getDescription(tree, 'en', fixtureFetch))?.label).toEqual({
      en: 'Projects',
    })
    expect((await ShapeTree.getDescription(tree, 'es', fixtureFetch))?.label).toEqual({
      es: 'Proyectos',
    })
    expect((await ShapeTree.getDescription(tree, 'pl', fixtureFetch))?.label).toEqual({
      pl: 'Projekty',
    })
  })

  test('returns null when no description set exists for the language', async () => {
    const tree = await ShapeTree.fromJsonLd(await docFromGraphs([TREE_GRAPH]), TREE_IRI)
    await expect(ShapeTree.getDescription(tree, 'fr', fixtureFetch)).resolves.toBeNull()
  })
})
