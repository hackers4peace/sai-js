import {
  SHAPETREES,
  XSD,
  documentLoader,
  documentValues,
  expandJsonLd,
  fetchJsonLd,
  frameNode,
  projectNode,
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

/** Identity of a shape tree. */
type FramedShapeTree = {
  id: string
  type?: Array<string>
  shape?: string
  describesInstance?: string
  expectsType?: string
}

const SHAPE_TREE_TERMS = ['shape', 'describesInstance', 'expectsType'] as const

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
// Document helpers (expanded form, no N3)
// ──────────────────────────

/**
 * Expand a JSON-LD document (fetched as application/ld+json — expanded,
 * compacted, or flattened form) to the expanded node array. Loads contexts via
 * the shared local document loader (no remote fetching).
 */
async function expandedNodes(doc: unknown, base: string): Promise<Array<any>> {
  return (await expandJsonLd(doc, { base, documentLoader })) as Array<any>
}

/**
 * The tree's `references` as content pairs. Reference nodes carry
 * `hasShapeTree`/`viaPredicate` and are not capturable by node-centric framing
 * (`buildFrame` forces `@embed: '@never'`, yielding id-only references), so
 * they are paired from the expanded document by node id.
 */
function referencePairs(expanded: Array<any>, treeId: string): Array<ShapeTreeReference> {
  const treeNode = expanded.find((node) => node['@id'] === treeId)
  if (!treeNode) {
    return []
  }
  const byId = new Map(expanded.map((node) => [node['@id'], node]))
  const references: Array<unknown> = Array.isArray(treeNode[SHAPETREES.references])
    ? treeNode[SHAPETREES.references]
    : []
  return references.map((reference: any) => {
    // Two shapes: server documents reference named/blank nodes by id
    // (`urn:uuid` IRIs, real docs) while expanded toJsonLd output embeds the
    // reference object inline (no @id). Resolve either.
    const referenceNode =
      reference[SHAPETREES.hasShapeTree] !== undefined ? reference : byId.get(reference['@id'])
    const hasShapeTree: string | undefined = referenceNode?.[SHAPETREES.hasShapeTree]?.[0]?.['@id']
    const viaPredicate: string | undefined = referenceNode?.[SHAPETREES.viaPredicate]?.[0]?.['@id']
    if (!hasShapeTree || !viaPredicate) {
      throw new Error(`shape tree ${treeId} has a reference missing hasShapeTree/viaPredicate`)
    }
    return {
      shapeTree: hasShapeTree,
      viaPredicate: DataFactory.namedNode(viaPredicate),
    }
  })
}

// ──────────────────────────
// Read path: JSON-LD → ShapeTreeData
// ──────────────────────────

/**
 * Convert a JSON-LD document (fetched as application/ld+json) directly into a
 * ShapeTreeData POJO. The document can be in expanded, compacted, or flattened
 * form.
 *
 * Node-level properties come from framing (like every other model). The
 * `references` (blank/named node objects with `hasShapeTree`/`viaPredicate`)
 * and the `descriptionLanguages` (typed literals on the description sets —
 * foreign nodes) are extracted from the expanded document instead, since a
 * node-centric frame can't capture either shape.
 */
export async function fromJsonLd(doc: unknown, id: string): Promise<ShapeTreeData> {
  const framed = (await frameNode(doc, dataModelContext, id, {
    terms: SHAPE_TREE_TERMS,
  })) as unknown as FramedShapeTree
  const node = projectNode(framed, SHAPE_TREE_TERMS)
  return {
    ...node,
    descriptionLanguages: await documentValues(doc, id, SHAPETREES.usesLanguage),
    references: referencePairs(await expandedNodes(doc, id), id),
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
 * The description set node (with `usesLanguage`) is located in the expanded
 * document; the description node is the one that `describes` the tree and
 * points `inDescriptionSet` at it.
 */
export async function getDescription(
  tree: ShapeTreeData,
  lang: string,
  fetch: WhatwgFetch
): Promise<ShapeTreeDescriptionData | null> {
  const doc = await fetchJsonLd(tree.id, fetch)
  const expanded = await expandedNodes(doc, tree.id)
  const isLanguage = (value: any) =>
    value['@value'] === lang && value['@type'] === XSD.terms.language.value
  const descriptionSetNode = expanded.find((node) =>
    (node[SHAPETREES.usesLanguage] ?? []).some(isLanguage)
  )
  if (!descriptionSetNode) {
    return null
  }
  const descriptionIri = expanded.find(
    (node) =>
      (node[SHAPETREES.describes] ?? []).some((value: any) => value['@id'] === tree.id) &&
      (node[SHAPETREES.inDescriptionSet] ?? []).some(
        (value: any) => value['@id'] === descriptionSetNode['@id']
      )
  )?.['@id']
  return descriptionIri
    ? shapeTreeDescriptionFromJsonLd(await fetchJsonLd(descriptionIri, fetch), descriptionIri)
    : null
}
