import {
  AccessNeedGroup,
  type AccessNeedGroupData,
  type AccessNeedGroupDescriptionData,
} from '@janeirodigital/interop-data-model'
const loadAccessNeedGroup = loader(AccessNeedGroup.fromJsonLd)

import { type WhatwgFetch, fetchJsonLd, loader, parseJsonld } from '@janeirodigital/interop-utils'

import { findInLanguage, loadDescriptions } from './access-description-set.ts'
import {
  accessNeed,
  reliableDescriptionLanguages as needReliableDescriptionLanguages,
} from './access-need.ts'

/**
 * Load an access need group with its access needs resolved recursively (the
 * composed read formerly `AuthorizationAgentFactory.accessNeedGroup`).
 */
export async function accessNeedGroup(
  id: string,
  fetch: WhatwgFetch,
  descriptionLang?: string
): Promise<AccessNeedGroupData> {
  const group = await loadAccessNeedGroup(id, fetch)
  group.accessNeeds = await Promise.all(
    group.hasAccessNeed.map((needIri) => accessNeed(needIri, fetch, descriptionLang))
  )
  return group
}

/**
 * Fetch the access need group description for the given language, or undefined
 * when the group's document has no description set for that language.
 */
export async function getDescription(
  group: AccessNeedGroupData,
  lang: string,
  fetch: WhatwgFetch
): Promise<AccessNeedGroupDescriptionData | undefined> {
  // the need group's document lives on a data pod — read it through
  // `fetchJsonLd` (LWS JSON-LD profile, plain-`ld+json` fallback for servers
  // without it); a bare `Accept: application/ld+json` is not the supported
  // storage Accept
  const doc = await fetchJsonLd(group.id, fetch)
  const dataset = await parseJsonld(JSON.stringify(doc), group.id)
  const descriptionSetIri = findInLanguage(dataset, lang)
  if (!descriptionSetIri) {
    return undefined
  }
  const descriptionSet = { id: descriptionSetIri }
  const { accessNeedGroupDescriptions } = await loadDescriptions(descriptionSet, fetch)
  return accessNeedGroupDescriptions.find(
    (description) => description.hasAccessNeedGroup === group.id
  )
}

/**
 * Languages for which every access need in the group (and its shape tree) has
 * descriptions.
 */
export async function reliableDescriptionLanguages(
  group: AccessNeedGroupData,
  fetch: WhatwgFetch
): Promise<Set<string>> {
  let languages: Set<string> | null = null
  for (const need of group.accessNeeds) {
    const needLanguages = await needReliableDescriptionLanguages(need, fetch)
    if (!languages) {
      languages = needLanguages
    } else {
      const current: Set<string> = languages
      languages = new Set([...current].filter((lang) => needLanguages.has(lang)))
    }
  }
  return languages ?? new Set()
}
