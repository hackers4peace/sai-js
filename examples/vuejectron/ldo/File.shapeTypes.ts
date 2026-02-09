import type { ShapeType } from '@ldo/ldo'
import { FileContext } from './File.context'
import { FileSchema } from './File.schema'
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
  schema: FileSchema,
  shape: 'https://shapetrees.hackers4peace.net/shapes/File',
  context: FileContext,
}
