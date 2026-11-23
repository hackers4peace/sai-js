import {
  AccessNeedDescription,
  AccessNeedGroupDescription,
} from '@janeirodigital/interop-data-model'
import type {
  AccessNeedDescriptionData,
  AccessNeedGroupDescriptionData,
} from '@janeirodigital/interop-data-model'
const loadAccessNeedDescription = loader(AccessNeedDescription.fromJsonLd)
const loadAccessNeedGroupDescription = loader(AccessNeedGroupDescription.fromJsonLd)

import {
  INTEROP,
  XSD,
  fetchJsonLd,
  getAllMatchingQuads,
  getOneMatchingQuad,
  loader,
  parseJsonld,
} from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import type { DatasetCore } from '@rdfjs/types'
import { DataFactory } from 'n3'

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────

/** All subjects in the dataset that point interop:inAccessDescriptionSet at the set. */
function descriptionIrisInSet(dataset: DatasetCore, setIri: string): Array<string> {
  return getAllMatchingQuads(
    dataset,
    undefined,
    INTEROP.terms.inAccessDescriptionSet,
    DataFactory.namedNode(setIri)
  ).map((quad) => quad.subject.value)
}

/**
 * IRIs of the access need descriptions in the set.
 * A description belongs to the set when it points interop:inAccessDescriptionSet
 * at the set and carries interop:hasAccessNeed.
 */
export function forAccessNeed(dataset: DatasetCore, setIri: string): Array<string> {
  return descriptionIrisInSet(dataset, setIri).filter(
    (iri) => dataset.match(DataFactory.namedNode(iri), INTEROP.terms.hasAccessNeed).size > 0
  )
}

/**
 * IRIs of the access need group descriptions in the set.
 * A description belongs to the set when it points interop:inAccessDescriptionSet
 * at the set and carries interop:hasAccessNeedGroup.
 */
export function forAccessNeedGroup(dataset: DatasetCore, setIri: string): Array<string> {
  return descriptionIrisInSet(dataset, setIri).filter(
    (iri) => dataset.match(DataFactory.namedNode(iri), INTEROP.terms.hasAccessNeedGroup).size > 0
  )
}

/**
 * Find the access description set IRI that uses the given language in the
 * given dataset (e.g. the dataset of an access need or access need group
 * resource).
 */
export function findInLanguage(dataset: DatasetCore, descriptionLang: string): string | undefined {
  // we can skip matching on INTEROP.hasAccessDescriptionSet since nothing else uses INTEROP.terms.usesLanguage
  return getOneMatchingQuad(
    dataset,
    undefined,
    INTEROP.terms.usesLanguage,
    DataFactory.literal(descriptionLang, XSD.terms.language)
  )?.subject.value
}

/**
 * Resolve the description POJOs for the set (replaces the class bootstrap).
 *
 * Fetches the set's dataset, derives the description IRIs with
 * forAccessNeed / forAccessNeedGroup, and loads each description POJO.
 */
export async function loadDescriptions(
  set: { id: string },
  fetch: WhatwgFetch
): Promise<{
  accessNeedDescriptions: Array<AccessNeedDescriptionData>
  accessNeedGroupDescriptions: Array<AccessNeedGroupDescriptionData>
}> {
  // the description set's dataset lives on a data pod — read it through
  // `fetchJsonLd` (LWS JSON-LD profile, plain-`ld+json` fallback); a bare
  // `Accept: application/ld+json` is not the supported storage Accept
  const doc = await fetchJsonLd(set.id, fetch)
  const dataset = await parseJsonld(JSON.stringify(doc), set.id)
  const [accessNeedDescriptions, accessNeedGroupDescriptions] = await Promise.all([
    Promise.all(forAccessNeed(dataset, set.id).map((iri) => loadAccessNeedDescription(iri, fetch))),
    Promise.all(
      forAccessNeedGroup(dataset, set.id).map((iri) => loadAccessNeedGroupDescription(iri, fetch))
    ),
  ])
  return { accessNeedDescriptions, accessNeedGroupDescriptions }
}
