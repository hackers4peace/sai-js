import type { LdoJsonldContext, LdSet } from '@ldo/ldo'

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
  prefLabel: string
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
