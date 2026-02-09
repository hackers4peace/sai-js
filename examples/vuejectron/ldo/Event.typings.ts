import type { LdSet, LdoJsonldContext } from '@ldo/ldo'

/**
 * =============================================================================
 * Typescript Typings for Event
 * =============================================================================
 */

/**
 * Event Type
 */
export interface Event {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'Event'
  }>
  name: string
  startDate: string
  chair: Role
  scribe?: Role
  attendee?: LdSet<Role>
  absentee?: LdSet<Role>
}

/**
 * Role Type
 */
export interface Role {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'Role'
  }>
  agent: Person
}

/**
 * Person Type
 */
export interface Person {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'Person'
  }>
  label: string
}

/**
 * Organization Type
 */
export interface Organization {
  '@id'?: string
  '@context'?: LdoJsonldContext
  type: LdSet<{
    '@id': 'Organization'
  }>
  label: string
  member?: LdSet<Person>
}
