import type { LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * projectContext: JSONLD Context for Project
 * =============================================================================
 */
export const projectContext: LdoJsonldContext = {
  type: {
    '@id': '@type',
    '@isCollection': true,
  },
  Project: {
    '@id': 'https://vocab.example/project-management/Project',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      prefLabel: {
        '@id': 'http://www.w3.org/2004/02/skos/core#prefLabel',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
      hasTask: {
        '@id': 'https://vocab.example/project-management/hasTask',
        '@type': '@id',
        '@isCollection': true,
      },
      hasImage: {
        '@id': 'https://vocab.example/project-management/hasImage',
        '@type': '@id',
        '@isCollection': true,
      },
      hasFile: {
        '@id': 'https://vocab.example/project-management/hasFile',
        '@type': '@id',
        '@isCollection': true,
      },
    },
  },
  prefLabel: {
    '@id': 'http://www.w3.org/2004/02/skos/core#prefLabel',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
  hasTask: {
    '@id': 'https://vocab.example/project-management/hasTask',
    '@type': '@id',
    '@isCollection': true,
  },
  hasImage: {
    '@id': 'https://vocab.example/project-management/hasImage',
    '@type': '@id',
    '@isCollection': true,
  },
  hasFile: {
    '@id': 'https://vocab.example/project-management/hasFile',
    '@type': '@id',
    '@isCollection': true,
  },
}
