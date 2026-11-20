import type { LdoJsonldContext, LdSet } from '@ldo/ldo'

/**
 * =============================================================================
 * Typescript Typings for File
 * =============================================================================
 */

/**
 * File Type
 */
export interface File {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'File'
  }>
  prefLabel: string
  fileName: string
  format: string
}
