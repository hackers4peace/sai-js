import type { ShapeType } from '@ldo/ldo'

import { taskContext } from './Task.context'
import { taskSchema } from './Task.schema'
import type { Task } from './Task.typings'

/**
 * =============================================================================
 * LDO ShapeTypes Task
 * =============================================================================
 */

/**
 * Task ShapeType
 */
export const TaskShapeType: ShapeType<Task> = {
  schema: taskSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Task',
  context: taskContext,
}
