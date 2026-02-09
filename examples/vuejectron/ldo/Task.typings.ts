import type { LdSet, LdoJsonldContext } from '@ldo/ldo'

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
  label: string
}
