import type { LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * taskContext: JSONLD Context for Task
 * =============================================================================
 */
export const taskContext: LdoJsonldContext = {
  type: {
    '@id': '@type',
    '@isCollection': true,
  },
  Task: {
    '@id': 'https://vocab.example/project-management/Task',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      prefLabel: {
        '@id': 'http://www.w3.org/2004/02/skos/core#prefLabel',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
    },
  },
  prefLabel: {
    '@id': 'http://www.w3.org/2004/02/skos/core#prefLabel',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
}
