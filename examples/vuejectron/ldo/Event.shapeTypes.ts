import type { ShapeType } from '@ldo/ldo'
import { EventContext } from './Event.context'
import { EventSchema } from './Event.schema'
import type { Event, Organization, Person, Role } from './Event.typings'

/**
 * =============================================================================
 * LDO ShapeTypes Event
 * =============================================================================
 */

/**
 * Event ShapeType
 */
export const EventShapeType: ShapeType<Event> = {
  schema: EventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Event',
  context: EventContext,
}

/**
 * Role ShapeType
 */
export const RoleShapeType: ShapeType<Role> = {
  schema: EventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Role',
  context: EventContext,
}

/**
 * Person ShapeType
 */
export const PersonShapeType: ShapeType<Person> = {
  schema: EventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Person',
  context: EventContext,
}

/**
 * Organization ShapeType
 */
export const OrganizationShapeType: ShapeType<Organization> = {
  schema: EventSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Organization',
  context: EventContext,
}
