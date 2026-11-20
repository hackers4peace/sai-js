import type { LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * fileContext: JSONLD Context for File
 * =============================================================================
 */
export const fileContext: LdoJsonldContext = {
  type: {
    '@id': '@type',
    '@isCollection': true,
  },
  File: {
    '@id': 'https://vocab.example/project-management/File',
    '@context': {
      type: {
        '@id': '@type',
        '@isCollection': true,
      },
      prefLabel: {
        '@id': 'http://www.w3.org/2004/02/skos/core#prefLabel',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
      fileName: {
        '@id': 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
      format: {
        '@id': 'http://www.w3.org/ns/ma-ont#format',
        '@type': 'http://www.w3.org/2001/XMLSchema#string',
      },
    },
  },
  prefLabel: {
    '@id': 'http://www.w3.org/2004/02/skos/core#prefLabel',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
  fileName: {
    '@id': 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
  format: {
    '@id': 'http://www.w3.org/ns/ma-ont#format',
    '@type': 'http://www.w3.org/2001/XMLSchema#string',
  },
}
