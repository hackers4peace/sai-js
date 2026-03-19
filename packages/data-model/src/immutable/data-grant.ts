import { INTEROP, RDF } from '@janeirodigital/interop-utils'
import type { NamedNode } from '@rdfjs/types'
import { DataFactory } from 'n3'
import { ImmutableResource } from '.'
import type { AuthorizationAgentFactory } from '..'

type StringData = {
  grantee: string
  grantedBy: string
  dataOwner: string
  registeredShapeTree: string
  hasDataRegistration: string
  hasStorage: string
  scopeOfGrant: string
  inheritsFromGrant?: string
  delegationOfGrant?: string
}

type ArrayData = {
  accessMode: string[]
  creatorAccessMode?: string[]
  hasDataInstance?: string[]
}

type InverseArrayData = {
  id?: string
  hasInheritingGrant?: DataGrantData[]
}

export type DataGrantData = StringData & ArrayData & InverseArrayData

export type FinalDataGrantData = DataGrantData & { id: string }

export class ImmutableDataGrant extends ImmutableResource {
  declare data: DataGrantData

  public constructor(iri: string, factory: AuthorizationAgentFactory, data: DataGrantData) {
    super(iri, factory, data)
    const props: (keyof StringData)[] = [
      'grantee',
      'grantedBy',
      'dataOwner',
      'registeredShapeTree',
      'hasDataRegistration',
      'hasStorage',
      'scopeOfGrant',
      'inheritsFromGrant',
      'delegationOfGrant',
    ]

    // set type
    const type: NamedNode = data.delegationOfGrant ? INTEROP.DelegatedDataGrant : INTEROP.DataGrant
    this.dataset.add(DataFactory.quad(this.node, RDF.type, type))
    // set string data
    for (const prop of props) {
      if (data[prop]) {
        this.dataset.add(
          DataFactory.quad(this.node, INTEROP[prop], DataFactory.namedNode(data[prop]))
        )
      }
    }
    const arrProps: (keyof ArrayData)[] = ['accessMode', 'creatorAccessMode', 'hasDataInstance']
    for (const prop of arrProps) {
      if (data[prop]) {
        for (const element of data[prop]) {
          this.dataset.add(
            DataFactory.quad(this.node, INTEROP[prop], DataFactory.namedNode(element))
          )
        }
      }
    }
    if (data.hasInheritingGrant) {
      for (const child of data.hasInheritingGrant) {
        if (!child.id) throw new Error('hasInheritingGrant child missing id')
        this.dataset.add(
          DataFactory.quad(DataFactory.namedNode(child.id), INTEROP.inheritsFromGrant, this.node)
        )
      }
    }
  }

  // public checkEquivalence(otherGrant: DataGrant): boolean {
  //   const predicates = [
  //     INTEROP.dataOwner,
  //     INTEROP.registeredShapeTree,
  //     INTEROP.hasDataRegistration,
  //     INTEROP.scopeOfGrant,
  //   ]
  //   // INTEROP.inheritsFromGrant
  //   // we don't check values, just if both exist or both don't exist

  //   const generatedInherits = otherGrant.getObjectsArray(INTEROP.inheritsFromGrant)
  //   const equivalentInherits = this.getObjectsArray(INTEROP.inheritsFromGrant)
  //   if (generatedInherits.length !== equivalentInherits.length) return false

  //   // INTEROP.inheritsFromGrant - inverse
  //   const generatedInverseInherits = otherGrant.getSubjectsArray(INTEROP.inheritsFromGrant)
  //   const equivalentInverseInherits = this.getSubjectsArray(INTEROP.inheritsFromGrant)

  //   // check if same number of inheriting grants
  //   if (generatedInverseInherits.length !== equivalentInverseInherits.length) return false

  //   // if has inheriting grants
  //   // check if all children are equivalent as well
  //   if (generatedInverseInherits.length) {
  //     if (
  //       !this.data.hasInheritingGrant.every((inheritingGrant) =>
  //         [...(otherGrant as InheritableDataGrant).hasInheritingGrant].some(
  //           (otherInheritingGrant) => inheritingGrant.checkEquivalence(otherInheritingGrant)
  //         )
  //       )
  //     )
  //       return false
  //   }

  //   // INTEROP.delegationOfGrant
  //   // we check if either both don't exist or both exist
  //   // if both exist we compare values
  //   const generatedDelegation = otherGrant.getObject(INTEROP.delegationOfGrant)
  //   const equivalentDelegation = this.getObject(INTEROP.delegationOfGrant)

  //   if (generatedDelegation?.value !== equivalentDelegation?.value) return false

  //   for (const predicate of predicates) {
  //     const generatedObject = otherGrant.getObject(predicate)

  //     const equivalentObject = this.getObject(predicate)
  //     if (generatedObject.value !== equivalentObject.value) return false
  //   }

  //   // INTEROP.accessMode
  //   const generatedAccessModes = otherGrant
  //     .getObjectsArray(INTEROP.accessMode)
  //     .map((object) => object.value)
  //   const equivalentAccessModes = this.getObjectsArray(INTEROP.accessMode).map(
  //     (object) => object.value
  //   )

  //   return (
  //     generatedAccessModes.length === equivalentAccessModes.length &&
  //     generatedAccessModes.every((mode) => equivalentAccessModes.includes(mode))
  //   )
  // }
}
