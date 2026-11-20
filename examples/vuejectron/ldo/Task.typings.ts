import type { LdoJsonldContext, LdSet } from '@ldo/ldo'

/**
 * =============================================================================
 * Typescript Typings for Task
 * =============================================================================
 */

/**
 * Task Type
 */
export interface Task {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'Task'
  }>
  prefLabel: string
}
