import { AccessNeed, ShapeTree } from '@janeirodigital/interop-data-model'
import type { AccessNeedData, AccessNeedDescriptionData } from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)
const loadAccessNeed = loader(AccessNeed.fromJsonLd)

import { fetchJsonLd, loader, parseJsonld } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

import { findInLanguage, loadDescriptions } from './access-description-set.ts'

/**
 * Load an access need with its inheriting needs resolved recursively (the
 * composed read formerly `AuthorizationAgentFactory.accessNeed`).
 */
export async function accessNeed(
  id: string,
  fetch: WhatwgFetch,
  // oxlint-disable-next-line oxc/only-used-in-recursion -- reserved for future per-need language filtering
  descriptionLang?: string
): Promise<AccessNeedData> {
  const need = await loadAccessNeed(id, fetch)
  if (need.hasInheritingNeed.length) {
    need.children = await Promise.all(
      need.hasInheritingNeed.map((childIri) => accessNeed(childIri, fetch, descriptionLang))
    )
  }
  return need
}

/**
 * Fetch the access need description for the given language, or undefined when
 * the need's document has no description set for that language.
 */
export async function getDescription(
  need: AccessNeedData,
  lang: string,
  fetch: WhatwgFetch
): Promise<AccessNeedDescriptionData | undefined> {
  // the need's document lives on a data pod — read it through `fetchJsonLd`
  // (LWS JSON-LD profile, plain-`ld+json` fallback); a bare
  // `Accept: application/ld+json` is not the supported storage Accept
  const doc = await fetchJsonLd(need.id, fetch)
  const dataset = await parseJsonld(JSON.stringify(doc), need.id)
  const descriptionSetIri = findInLanguage(dataset, lang)
  if (!descriptionSetIri) {
    return undefined
  }
  const descriptionSet = { id: descriptionSetIri }
  const { accessNeedDescriptions } = await loadDescriptions(descriptionSet, fetch)
  return accessNeedDescriptions.find((description) => description.hasAccessNeed === need.id)
}

/**
 * Languages for which both the need and its shape tree have descriptions.
 */
export async function reliableDescriptionLanguages(
  need: AccessNeedData,
  fetch: WhatwgFetch
): Promise<Set<string>> {
  const shapeTree = await loadShapeTree(need.registeredShapeTree, fetch)
  const shapeTreeLanguages = new Set(shapeTree.descriptionLanguages)
  return new Set(need.descriptionLanguages.filter((lang) => shapeTreeLanguages.has(lang)))
}
