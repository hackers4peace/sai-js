import { INTEROP, RDF } from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { CRUDContainer } from '.'
import type { AuthorizationAgentFactory } from '..'
import type { CRUDData } from './resource'

export class CRUDGrantRegistry extends CRUDContainer {
  declare factory: AuthorizationAgentFactory

  async bootstrap(): Promise<void> {
    await this.fetchData()
    if (this.data) {
      this.dataset.add(DataFactory.quad(this.node, RDF.type, INTEROP.GrantRegistry))
    }
  }

  public static async build(
    iri: string,
    factory: AuthorizationAgentFactory,
    data?: CRUDData
  ): Promise<CRUDGrantRegistry> {
    const instance = new CRUDGrantRegistry(iri, factory, data)
    await instance.bootstrap()
    return instance
  }
}
