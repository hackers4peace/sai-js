import { frameNode, projectNode } from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import { dataModelContext } from './context.ts'

type FramedRole = {
  id: string
  type?: Array<string>
  label?: LanguageMap
  members: Array<string>
}

const ROLE_TERMS = ['label', 'members'] as const

export type RoleId = {
  id: string
  type: Array<string>
}

export type RoleData = RoleId & {
  /** language map — the untagged label under `@none`, translations under their tags */
  label: LanguageMap
  members: Array<string>
}

export async function fromJsonLd(doc: unknown, id: string): Promise<RoleData> {
  const framed = (await frameNode(doc, dataModelContext, id)) as unknown as FramedRole
  const node = projectNode(framed, ROLE_TERMS)
  return {
    ...node,
    label: node.label ?? {},
  }
}
