import type { Schema } from 'shexj'

/**
 * =============================================================================
 * fileSchema: ShexJ Schema for File
 * =============================================================================
 */
export const fileSchema: Schema = {
  type: 'Schema',
  shapes: [
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/File',
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
                values: ['https://vocab.example/project-management/File'],
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
              predicate: 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName',
              valueExpr: {
                type: 'NodeConstraint',
                datatype: 'http://www.w3.org/2001/XMLSchema#string',
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'http://www.w3.org/ns/ma-ont#format',
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
