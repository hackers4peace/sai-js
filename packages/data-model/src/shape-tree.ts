import {
  SHAPETREES,
  documentValues,
  fetchJsonLd,
  frameMatches,
  frameNode,
  framedValue,
  projectNode,
  strs,
  withContext,
} from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import type { NamedNode } from '@rdfjs/types'
import { DataFactory } from 'n3'

import { dataModelContext } from './context.ts'
import type { ShapeTreeDescriptionData } from './index.ts'
import { fromJsonLd as shapeTreeDescriptionFromJsonLd } from './shape-tree-description.ts'

export interface ShapeTreeReference {
  shapeTree: string
  viaPredicate: NamedNode
}

// ──────────────────────────
// Types
// ──────────────────────────

/** A reference node: a child node of the tree document, not a plain IRI. */
type FramedShapeTreeReference = {
  id?: string
  hasShapeTree?: string
  viaPredicate?: string
}

/** Identity of a shape tree. */
type FramedShapeTree = {
  id: string
  type?: Array<string>
  shape?: string
  describesInstance?: string
  expectsType?: string
  references: Array<FramedShapeTreeReference>
}

const SHAPE_TREE_TERMS = ['shape', 'describesInstance', 'expectsType'] as const
/** The frame's property list: node properties + the embedded reference nodes. */
const SHAPE_TREE_FRAME_TERMS = [...SHAPE_TREE_TERMS, 'references'] as const

export type ShapeTreeId = {
  id: string
  /** rdf:type IRIs — captured from the document on read (e.g. `[SHAPETREES.ShapeTree]`) */
  type: Array<string>
}

/** Plain JSON representation of a shape tree. */
export type ShapeTreeData = ShapeTreeId & {
  shape?: string
  describesInstance?: string
  expectsType?: string
  /** Languages used by description sets in the shape tree document. */
  descriptionLanguages: Array<string>
  references: Array<ShapeTreeReference>
}

// ──────────────────────────
// Document helpers (framed nodes, no expanded-document walks)
// ──────────────────────────

/**
 * The tree's `references` as content pairs, from the reference nodes the frame
 * embedded (`references: { '@embed': '@once' }`).
 *
 * A reference node carries `hasShapeTree` and `viaPredicate`; one missing
 * either (e.g. a dangling reference the framer left as a plain IRI string) is a
 * malformed shape tree. References are deduplicated by (shape tree, predicate):
 * a document may reference the same child shape tree more than once.
 */
function referenceNodes(
  references: ReadonlyArray<FramedShapeTreeReference> | undefined,
  treeId: string
): Array<ShapeTreeReference> {
  const seen = new Set<string>()
  const pairs: Array<ShapeTreeReference> = []
  for (const reference of references ?? []) {
    if (
      typeof reference !== 'object' ||
      reference === null ||
      !reference.hasShapeTree ||
      !reference.viaPredicate
    ) {
      throw new Error(`shape tree ${treeId} has a reference missing hasShapeTree/viaPredicate`)
    }
    const key = `${reference.hasShapeTree} ${reference.viaPredicate}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    pairs.push({
      shapeTree: reference.hasShapeTree,
      viaPredicate: DataFactory.namedNode(reference.viaPredicate),
    })
  }
  return pairs
}

// ──────────────────────────
// Read path: JSON-LD → ShapeTreeData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * ShapeTreeData POJO. The document can be in expanded, compacted, or flattened
 * form.
 *
 * Node-level properties and the `references` (child nodes carrying
 * `hasShapeTree`/`viaPredicate`) come from one frame — the references embed
 * with `@embed: '@once'`, so no expanded-document walk is needed. The
 * `descriptionLanguages` stay a document-wide lookup: they live on the
 * description sets, which are separate nodes linked only by `inDescriptionSet`.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<ShapeTreeData> {
  const framed = (await frameNode(doc, dataModelContext, id, {
    terms: SHAPE_TREE_FRAME_TERMS,
    overrides: {
      // reference nodes are child nodes of the tree document, not plain IRI
      // references: embed each once. No sub-patterns — a subframe would make a
      // dangling reference match nothing and drop it silently, while a bare
      // `@embed` leaves it as an id-only node `referenceNodes` can reject.
      references: { '@embed': '@once' },
    },
  })) as unknown as FramedShapeTree
  return {
    ...projectNode(framed, SHAPE_TREE_TERMS),
    descriptionLanguages: await documentValues(doc, id, SHAPETREES.usesLanguage),
    references: referenceNodes(framed.references, id),
  }
}

// ──────────────────────────
// Write path: ShapeTreeData → JSON-LD (test-only round-trip support)
// ──────────────────────────

/** Build a JSON-LD document (with embedded context) ready for PUT as application/ld+json. */
export function toJsonLd(data: ShapeTreeData): Record<string, unknown> {
  return withContext(dataModelContext, {
    ...data,
    references: data.references.map((reference) => ({
      hasShapeTree: reference.shapeTree,
      viaPredicate: reference.viaPredicate.value,
    })),
  })
}

/**
 * Fetch and load a shape tree resource as a ShapeTreeData POJO
 * (fetched as application/ld+json).
 */

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────

/**
 * Fetch the shape tree description for the given language, or null when the
 * tree has no description set for that language.
 *
 * Two selector frames replace the former expanded-document scans: the
 * description sets are matched by the languages they declare (the tree document
 * does not type them — `a shapetrees:DescriptionSet` lives in the set's own
 * graph), then the description is the node whose `describes` is the tree and
 * whose `inDescriptionSet` is that set.
 */
export async function getDescription(
  tree: ShapeTreeData,
  lang: string,
  fetch: WhatwgFetch
): Promise<ShapeTreeDescriptionData | null> {
  const doc = await fetchJsonLd(tree.id, fetch)
  const sets = await frameMatches(
    doc,
    dataModelContext,
    { descriptionLanguages: { '@embed': '@never' } },
    `${tree.id} description sets`
  )
  const descriptionSet = sets.find((candidate) =>
    strs(candidate, 'descriptionLanguages').includes(lang)
  )
  const descriptionSetIri = descriptionSet?.id
  if (!descriptionSetIri) {
    return null
  }
  // the selector returns every description of this tree: jsonld@9 matches a
  // node when ANY frame property matches (`@requireAll: true` did not restrict
  // it), so the exact pair is filtered here
  const descriptions = await frameMatches(
    doc,
    dataModelContext,
    {
      [SHAPETREES.describes]: { '@id': tree.id, '@embed': '@never' },
      [SHAPETREES.inDescriptionSet]: { '@id': descriptionSetIri, '@embed': '@never' },
    },
    `${tree.id} description`
  )
  const description = descriptions.find(
    (candidate) => framedValue(candidate[SHAPETREES.inDescriptionSet]) === descriptionSetIri
  )
  const descriptionIri = description?.id as string | undefined
  return descriptionIri
    ? shapeTreeDescriptionFromJsonLd(await fetchJsonLd(descriptionIri, fetch), descriptionIri)
    : null
}
