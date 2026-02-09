import type { LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * EventContext: JSONLD Context for Event
 * =============================================================================
 */
export const EventContext: LdoJsonldContext = {
  type: {
    '@id': '@type',
    '@isCollection': true,
  },
  Event: {
    '@id': 'https://schema.org/Event',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      name: {
        '@id': 'https://schema.org/name',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
      startDate: {
        '@id': 'https://schema.org/startDate',
        '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
      },
      chair: {
        '@id': 'https://vocab.example/events/chair',
        '@type': '@id',
      },
      scribe: {
        '@id': 'https://vocab.example/events/scribe',
        '@type': '@id',
      },
      attendee: {
        '@id': 'https://vocab.example/events/attendee',
        '@type': '@id',
        '@isCollection': true,
      },
      absentee: {
        '@id': 'https://vocab.example/events/absentee',
        '@type': '@id',
        '@isCollection': true,
      },
    },
  },
  name: {
    '@id': 'https://schema.org/name',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
  startDate: {
    '@id': 'https://schema.org/startDate',
    '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
  },
  chair: {
    '@id': 'https://vocab.example/events/chair',
    '@type': '@id',
  },
  Role: {
    '@id': 'https://schema.org/Role',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      agent: {
        '@id': 'https://vocab.example/events/agent',
        '@type': '@id',
      },
    },
  },
  agent: {
    '@id': 'https://vocab.example/events/agent',
    '@type': '@id',
  },
  Person: {
    '@id': 'http://xmlns.com/foaf/0.1/Person',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      label: {
        '@id': 'http://www.w3.org/2000/01/rdf-schema#label',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
    },
  },
  label: {
    '@id': 'http://www.w3.org/2000/01/rdf-schema#label',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
  scribe: {
    '@id': 'https://vocab.example/events/scribe',
    '@type': '@id',
  },
  attendee: {
    '@id': 'https://vocab.example/events/attendee',
    '@type': '@id',
    '@isCollection': true,
  },
  absentee: {
    '@id': 'https://vocab.example/events/absentee',
    '@type': '@id',
    '@isCollection': true,
  },
  Organization: {
    '@id': 'http://xmlns.com/foaf/0.1/Organization',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      label: {
        '@id': 'http://www.w3.org/2000/01/rdf-schema#label',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
      member: {
        '@id': 'https://schema.org/member',
        '@type': '@id',
        '@isCollection': true,
      },
    },
  },
  member: {
    '@id': 'https://schema.org/member',
    '@type': '@id',
    '@isCollection': true,
  },
}
