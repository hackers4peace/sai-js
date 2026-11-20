import type { ShapeType } from '@ldo/ldo'

import { eventContext } from './Event.context'
import { eventSchema } from './Event.schema'
import type { Event, Role, Person, Organization } from './Event.typings'

/**
 * =============================================================================
 * LDO ShapeTypes Event
 * =============================================================================
 */

/**
 * Event ShapeType
 */
export const EventShapeType: ShapeType<Event> = {
  schema: eventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Event',
  context: eventContext,
}

/**
 * Role ShapeType
 */
export const RoleShapeType: ShapeType<Role> = {
  schema: eventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Role',
  context: eventContext,
}

/**
 * Person ShapeType
 */
export const PersonShapeType: ShapeType<Person> = {
  schema: eventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Person',
  context: eventContext,
}

/**
 * Organization ShapeType
 */
export const OrganizationShapeType: ShapeType<Organization> = {
  schema: eventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Organization',
  context: eventContext,
}
