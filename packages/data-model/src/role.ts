import { type LanguageMap, frameNode, selectNode } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

export type RoleId = {
  id: string
  type: Array<string>
}

export type RoleData = RoleId & {
  /** language map — the untagged label under `@none`, translations under their tags */
  label: LanguageMap
  members: Array<string>
}

const ROLE_TERMS = ['label', 'members'] as const

export async function fromJsonLd(doc: unknown, id: string): Promise<RoleData> {
  // `label` is a language map in the shared context (`@container: '@language'`)
  return selectNode(await frameNode(doc, dataModelContext, id), ROLE_TERMS) as unknown as RoleData
}
