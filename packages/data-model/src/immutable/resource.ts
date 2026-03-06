import { Store } from 'n3'
import { type AuthorizationAgentFactory, Resource } from '..'

type Data = { [key: string]: any }

export class ImmutableResource extends Resource {
  data: Data

  stored = false

  // dataset gets populated in consturtor of each sub class
  constructor(iri: string, factory: AuthorizationAgentFactory, data: Data) {
    super(iri, factory)
    this.data = data
    this.dataset = new Store()
  }

  /*
   * Immutable resource is always created new, never updated
   * for that reason it will always use If-None-Match: * header.
   * TODO: take into account retry - 412 shouldn't fail operation
   */
  public async put(): Promise<void> {
    if (this.stored) {
      throw new Error('this resource has been already stored')
    }
    const response = await this.fetch(this.iri, {
      method: 'PUT',
      dataset: this.dataset,
      headers: {
        'If-None-Match': '*',
      },
    })
    if (response.ok) {
      this.stored = true
      return
    }
    throw new Error('failed to store')
  }
}
