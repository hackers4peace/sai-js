import type { LdSet, LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * Typescript Typings for Project
 * =============================================================================
 */

/**
 * Project Type
 */
export interface Project {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'Project'
  }>
  label: string
  hasTask?: LdSet<{
    '@id': string
  }>
  hasImage?: LdSet<{
    '@id': string
  }>
  hasFile?: LdSet<{
    '@id': string
  }>
}
