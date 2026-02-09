import type { LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * TaskContext: JSONLD Context for Task
 * =============================================================================
 */
export const TaskContext: LdoJsonldContext = {
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
}
