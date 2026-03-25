import { INTEROP, RDFS, SOLID } from '@janeirodigital/interop-utils'
import type { InteropFactory } from '..'
import { ReadableResource } from './resource'

export class ReadableWebIdProfile extends ReadableResource {
  get label(): string | undefined {
    return this.getObject(RDFS.label)?.value
  }

  get oidcIssuer(): string | undefined {
    return this.getObject(SOLID.oidcIssuer)?.value
  }

  private async bootstrap(): Promise<void> {
    await this.fetchData()
  }

  public static async build(iri: string, factory: InteropFactory): Promise<ReadableWebIdProfile> {
    const instance = new ReadableWebIdProfile(iri, factory)
    await instance.bootstrap()
    return instance
  }
}
