import type { ShapeType } from '@ldo/ldo'

import { fileContext } from './File.context'
import { fileSchema } from './File.schema'
import type { File } from './File.typings'

/**
 * =============================================================================
 * LDO ShapeTypes File
 * =============================================================================
 */

/**
 * File ShapeType
 */
export const FileShapeType: ShapeType<File> = {
  schema: fileSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/File',
  context: fileContext,
}
