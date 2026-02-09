import type { Schema } from 'shexj'

/**
 * =============================================================================
 * TaskSchema: ShexJ Schema for Task
 * =============================================================================
 */
export const TaskSchema: Schema = {
  type: 'Schema',
  shapes: [
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/Task',
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
                values: ['https://vocab.example/project-management/Task'],
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
          ],
        },
      },
    },
  ],
}
