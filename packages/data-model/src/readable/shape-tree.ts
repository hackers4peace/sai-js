import { SHAPETREES, XSD } from '@janeirodigital/interop-utils'
import type { NamedNode } from '@rdfjs/types'
import { DataFactory } from 'n3'
import { Memoize } from 'typescript-memoize'
import { ReadableResource, ReadableShapeTreeDescription } from '.'
import type { InteropFactory } from '..'

export interface ShapeTreeReference {
  shapeTree: string
  viaPredicate: NamedNode
}
export class ReadableShapeTree extends ReadableResource {
  shapeText?: string

  public descriptions: { [key: string]: ReadableShapeTreeDescription } = {}

  constructor(
    public iri: string,
    public factory: InteropFactory,
    public descriptionLang?: string
  ) {
    super(iri, factory)
  }

  private async bootstrap(): Promise<void> {
    await this.fetchData()
    // if (this.shape) {
    //   this.shapeText = await (
    //     await this.fetch(this.shape, { headers: { Accept: 'text/shex' } })
    //   ).text()
    // }
    if (this.descriptionLang) {
      await this.getDescription(this.descriptionLang)
    }
  }

  public static async build(
    iri: string,
    factory: InteropFactory,
    descriptionLang?: string
  ): Promise<ReadableShapeTree> {
    const instance = new ReadableShapeTree(iri, factory, descriptionLang)
    await instance.bootstrap()
    return instance
  }

  public async getDescription(lang: string): Promise<ReadableShapeTreeDescription> {
    if (this.descriptions[lang]) return this.descriptions[lang]
    const descriptionSetNode = this.getQuad(
      null,
      SHAPETREES.usesLanguage,
      DataFactory.literal(lang, XSD.language)
    )?.subject
    if (!descriptionSetNode) return null
    const descriptionNodes = this.getSubjectsArray(SHAPETREES.describes)
    // get description from the set for the language (in specific description set)
    const descriptionIri = descriptionNodes.find((node) =>
      this.getQuad(node, SHAPETREES.inDescriptionSet, descriptionSetNode)
    )?.value
    const description = descriptionIri
      ? await ReadableShapeTreeDescription.build(descriptionIri, this.factory)
      : null
    if (description) {
      this.descriptions[lang] = description
    }
    return description
  }

  getPredicateForReferenced(shapeTree: string): NamedNode {
    const referencedNode = this.getQuad(
      null,
      SHAPETREES.hasShapeTree,
      DataFactory.namedNode(shapeTree)
    ).subject
    return this.getQuad(referencedNode, SHAPETREES.viaPredicate).object as NamedNode
  }

  @Memoize()
  get shape(): string | undefined {
    return this.getObject('shape', SHAPETREES)?.value
  }

  @Memoize()
  get describesInstance(): NamedNode {
    return this.getObject('describesInstance', SHAPETREES)
  }

  @Memoize()
  get descriptionLanguages(): Set<string> {
    return new Set(
      this.getQuadArray(null, SHAPETREES.usesLanguage).map((quad) => quad.object.value)
    )
  }

  @Memoize()
  get references(): ShapeTreeReference[] {
    const nodes = this.getObjectsArray('references', SHAPETREES)
    return nodes.map((node) => ({
      shapeTree: this.getQuad(node, SHAPETREES.hasShapeTree).object.value, // TODO: update to st:referencesShapeTree
      viaPredicate: this.getQuad(node, SHAPETREES.viaPredicate).object as NamedNode,
    }))
  }

  @Memoize()
  get expectsType(): NamedNode {
    return this.getObject('expectsType', SHAPETREES)!
  }
}
