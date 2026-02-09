import type { Schema } from 'shexj'

/**
 * =============================================================================
 * ProjectSchema: ShexJ Schema for Project
 * =============================================================================
 */
export const ProjectSchema: Schema = {
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
              predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
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
