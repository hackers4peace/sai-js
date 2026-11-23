import {
  type ChildInfo,
  type DataInstanceData,
  DataRegistration,
  type DataRegistrationData,
  ShapeTree,
  frameDataInstance,
  isBlob,
  labelFromNode,
} from '@janeirodigital/interop-data-model'
const loadShapeTree = loader(ShapeTree.fromJsonLd)
const loadDataRegistration = loader(DataRegistration.fromJsonLd)

import type { ShapeTreeData } from '@janeirodigital/interop-data-model'
import {
  type WhatwgFetch,
  discoverDescriptionResource,
  loader,
  pickLanguage,
  upContainer,
} from '@janeirodigital/interop-utils'

/** Count the children of the data instance for each referenced shape tree. */
export async function computeChildren(
  node: Record<string, unknown>,
  shapeTree: ShapeTreeData,
  fetch: WhatwgFetch,
  lang: string
): Promise<Array<ChildInfo>> {
  return Promise.all(
    shapeTree.references.map(async (reference) => {
      const childTree = await loadShapeTree(reference.shapeTree, fetch)
      const description = await ShapeTree.getDescription(childTree, lang, fetch)
      return {
        count: ((node[reference.viaPredicate.value] as Array<string> | undefined) ?? []).length,
        // the shape tree's label is a language map — picked for the
        // requested language
        shapeTree: { id: reference.shapeTree, label: pickLanguage(description?.label, lang) ?? '' },
      }
    })
  )
}

/**
 * Fetch and load a data instance as a DataInstanceData POJO — the composed
 * read formerly `ApplicationFactory.dataInstance`: resolves the instance's
 * parent container / data registration, its shape tree, and (with
 * `descriptionLang`) the instance's label and children.
 *
 * `registrationIri` is the instance's containing data registration. Flat LWS
 * storage does not encode it in the instance URI, so the parent comes from the
 * storage's **stored** `lws:partOf` via the `up` link relation on the
 * instance's own response (LWS, §Containment) — never from the IRI path.
 * Callers that already know the registration pass it and save the HEAD.
 */
export async function loadDataInstance(
  id: string,
  fetch: WhatwgFetch,
  shapeTreeIri?: string,
  descriptionLang?: string,
  registrationIri?: string
): Promise<DataInstanceData> {
  let dataRegistration: DataRegistrationData | undefined
  let resolvedShapeTreeIri = shapeTreeIri
  let partOf = registrationIri
  if (!resolvedShapeTreeIri) {
    partOf = registrationIri ?? (await upContainer(id, fetch))
    if (!partOf) {
      throw new Error(
        `cannot resolve the parent container of ${id}: no \`up\` link relation on its response`
      )
    }
    dataRegistration = await loadDataRegistration(partOf, fetch)
    resolvedShapeTreeIri = dataRegistration.registeredShapeTree
  }
  const shapeTree = await loadShapeTree(resolvedShapeTreeIri, fetch)
  const blob = isBlob(shapeTree)
  const data: DataInstanceData = {
    id: id,
    ...(partOf ? { partOf } : {}),
    shapeTreeIri: resolvedShapeTreeIri,
    isBlob: blob,
    children: [],
    dataRegistration,
  }
  if (descriptionLang) {
    const node = blob
      ? await frameDataInstance(id, fetch, shapeTree, await discoverDescriptionResource(id, fetch))
      : await frameDataInstance(id, fetch, shapeTree)
    data.label = labelFromNode(node)
    data.children = await computeChildren(node, shapeTree, fetch, descriptionLang)
  }
  return data
}
