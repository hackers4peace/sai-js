import { INTEROP, RDF, XSD } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { ImmutableResource } from '.'
import type { AuthorizationAgentFactory } from '..'
import type { FinalDataGrantData } from './data-grant'

type AccessGrantStringData = {
  id: string
  grantedBy: string
  grantedWith: string
  grantee: string
  hasAccessNeedGroup?: string
  granted: boolean
}

export type AccessGrantData = AccessGrantStringData & {
  sourceGrants: FinalDataGrantData[]
  delegatedGrants: FinalDataGrantData[]
}

export type FinalAccessGrantData = Omit<AccessGrantData, 'sourceGrants' | 'delegatedGrants'> & {
  dataGrants: FinalDataGrantData[]
}

export class ImmutableAccessGrant extends ImmutableResource {
  declare data: FinalAccessGrantData

  public constructor(iri: string, factory: AuthorizationAgentFactory, data: FinalAccessGrantData) {
    super(iri, factory, data)
    this.dataset.add(DataFactory.quad(this.node, RDF.type, INTEROP.AccessGrant))
    const props: (keyof Omit<AccessGrantStringData, 'granted'>)[] = [
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
    for (const dataGrant of data.dataGrants) {
      this.dataset.add(
        DataFactory.quad(this.node, INTEROP.hasDataGrant, DataFactory.namedNode(dataGrant.id))
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
