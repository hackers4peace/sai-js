import type { LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * ProjectContext: JSONLD Context for Project
 * =============================================================================
 */
export const ProjectContext: LdoJsonldContext = {
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
      label: {
        '@id': 'http://www.w3.org/2000/01/rdf-schema#label',
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
  label: {
    '@id': 'http://www.w3.org/2000/01/rdf-schema#label',
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
