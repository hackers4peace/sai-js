import type { LdSet, LdoJsonldContext } from '@ldo/ldo'

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
  label: string
  fileName: string
  format: string
}
