import type { ShapeType } from '@ldo/ldo'

import { projectContext } from './Project.context'
import { projectSchema } from './Project.schema'
import type { Project } from './Project.typings'

/**
 * =============================================================================
 * LDO ShapeTypes Project
 * =============================================================================
 */

/**
 * Project ShapeType
 */
export const ProjectShapeType: ShapeType<Project> = {
  schema: projectSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Project',
  context: projectContext,
}
