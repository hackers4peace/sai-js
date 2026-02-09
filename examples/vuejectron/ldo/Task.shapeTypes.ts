import type { ShapeType } from '@ldo/ldo'
import { TaskContext } from './Task.context'
import { TaskSchema } from './Task.schema'
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
  schema: TaskSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Task',
  context: TaskContext,
}
