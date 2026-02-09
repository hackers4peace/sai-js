import type { ShapeType } from '@ldo/ldo'
import { ProjectContext } from './Project.context'
import { ProjectSchema } from './Project.schema'
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
  schema: ProjectSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/Project',
  context: ProjectContext,
}
