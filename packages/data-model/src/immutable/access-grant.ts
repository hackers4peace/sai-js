import { INTEROP, RDF, XSD } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { ImmutableResource } from '.'
import type { AuthorizationAgentFactory, DataGrant, ImmutableDataGrant } from '..'

type StringData = {
  grantedBy: string
  grantedWith: string
  grantee: string
  hasAccessNeedGroup?: string
}

export type AccessGrantData = StringData & {
  dataGrants: (ImmutableDataGrant | DataGrant)[]
  granted: boolean
}

export class ImmutableAccessGrant extends ImmutableResource {
  dataGrants: (ImmutableDataGrant | DataGrant)[]

  declare data: AccessGrantData

  public constructor(iri: string, factory: AuthorizationAgentFactory, data: AccessGrantData) {
    super(iri, factory, data)
    this.dataGrants = data.dataGrants ?? []
    this.dataset.add(DataFactory.quad(this.node, RDF.type, INTEROP.AccessGrant))
    const props: (keyof StringData)[] = [
      'grantedBy',
      'grantedWith',
      'grantee',
      'hasAccessNeedGroup',
    ]
    for (const prop of props) {
      if (data[prop]) {
        this.dataset.add(
          DataFactory.quad(this.node, INTEROP[prop], DataFactory.namedNode(data[prop]))
        )
      }
    }
    for (const dataGrant of this.dataGrants) {
      this.dataset.add(
        DataFactory.quad(this.node, INTEROP.hasDataGrant, DataFactory.namedNode(dataGrant.iri))
      )
    }
    this.dataset.add(
      DataFactory.quad(
        this.node,
        INTEROP.grantedAt,
        DataFactory.literal(new Date().toISOString(), XSD.dateTime)
      )
    )
    this.dataset.add(
      DataFactory.quad(
        this.node,
        INTEROP.granted,
        DataFactory.literal(data.granted.toString(), XSD.boolean)
      )
    )
  }
}
