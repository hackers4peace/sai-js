import type { Schema } from 'shexj'

/**
 * =============================================================================
 * EventSchema: ShexJ Schema for Event
 * =============================================================================
 */
export const EventSchema: Schema = {
  type: 'Schema',
  shapes: [
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/Event',
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
                values: ['https://schema.org/Event'],
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://schema.org/name',
              valueExpr: {
                type: 'NodeConstraint',
                datatype: 'http://www.w3.org/2001/XMLSchema#string',
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://schema.org/startDate',
              valueExpr: {
                type: 'NodeConstraint',
                datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/events/chair',
              valueExpr: 'https://shapetrees.hackers4peace.net/shapes/Role',
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/events/scribe',
              valueExpr: 'https://shapetrees.hackers4peace.net/shapes/Role',
              min: 0,
              max: 1,
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/events/attendee',
              valueExpr: 'https://shapetrees.hackers4peace.net/shapes/Role',
              min: 0,
              max: -1,
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/events/absentee',
              valueExpr: 'https://shapetrees.hackers4peace.net/shapes/Role',
              min: 0,
              max: -1,
            },
          ],
        },
      },
    },
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/Role',
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
                values: ['https://schema.org/Role'],
              },
            },
            {
              type: 'TripleConstraint',
              predicate: 'https://vocab.example/events/agent',
              valueExpr: 'https://shapetrees.hackers4peace.net/shapes/Person',
            },
          ],
        },
      },
    },
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/Person',
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
                values: ['http://xmlns.com/foaf/0.1/Person'],
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
    {
      id: 'https://shapetrees.hackers4peace.net/shapes/Organization',
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
                values: ['http://xmlns.com/foaf/0.1/Organization'],
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
              predicate: 'https://schema.org/member',
              valueExpr: 'https://shapetrees.hackers4peace.net/shapes/Person',
              min: 0,
              max: -1,
            },
          ],
        },
      },
    },
  ],
}
