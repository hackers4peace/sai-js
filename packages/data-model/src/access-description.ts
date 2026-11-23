import { type LanguageMap } from '@janeirodigital/interop-utils'

export type AccessDescriptionId = {
  id: string
  type: Array<string>
}

export type AccessDescriptionData = AccessDescriptionId & {
  /** language map — the untagged label under `@none`, translations under their tags */
  label: LanguageMap
  /** language map — the untagged definition under `@none`, translations under their tags */
  definition?: LanguageMap
}
