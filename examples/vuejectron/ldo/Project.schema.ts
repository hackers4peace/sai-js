import type { Schema } from 'shexj'

/**
 * =============================================================================
 * projectSchema: ShexJ Schema for Project
 * =============================================================================
 */
export const projectSchema: Schema = {
  type: 'Schema',
  shapes: [
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/Project',
      type: 'ShapeDecl',
      shapeExpr: {
        type: 'Shape',
        expression: {
          type: 'EachOf',
          expressions: [
            {
              type: 'TripleConstraint',
              predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
              valueExpr: {
                type: 'NodeConstraint',
                values: ['https://vocab.example/project-management/Project'],
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'http://www.w3.org/2004/02/skos/core#prefLabel',
              valueExpr: {
                type: 'NodeConstraint',
                datatype: 'http://www.w3.org/2001/XMLSchema#string',
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/project-management/hasTask',
              valueExpr: {
                type: 'NodeConstraint',
                nodeKind: 'iri',
              },
              min: 0,
              max: -1,
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/project-management/hasImage',
              valueExpr: {
                type: 'NodeConstraint',
                nodeKind: 'iri',
              },
              min: 0,
              max: -1,
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/project-management/hasFile',
              valueExpr: {
                type: 'NodeConstraint',
                nodeKind: 'iri',
              },
              min: 0,
              max: -1,
            },
          ],
        },
      },
    },
  ],
}
