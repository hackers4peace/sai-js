import { SAI_CONTEXT_URI } from '@janeirodigital/interop-utils'
import type { LwsStorageDescriberInput } from '@solid/community-server'
import { describe, expect, test } from 'vitest'

import { SaiStorageTypeDescriber } from '../src/SaiStorageTypeDescriber.js'

function input(): LwsStorageDescriberInput {
  return {
    storage: { path: 'https://registry/alice/' },
    description: {
      '@context': ['https://www.w3.org/ns/cid/v1', 'https://www.w3.org/ns/lws/v1'],
      id: 'https://registry/alice/',
      type: 'Storage',
      service: [],
    },
  }
}

describe('SaiStorageTypeDescriber', () => {
  test('adds the compact SAI storage type and its context', async () => {
    const describer = new SaiStorageTypeDescriber('RegistryStorage')
    const description = input().description
    await describer.handle({ storage: { path: 'https://registry/alice/' }, description })

    expect(description.type).toEqual(['Storage', 'RegistryStorage'])
    expect(description['@context']).toContain(SAI_CONTEXT_URI)
  })

  test('does not duplicate an existing type or context', async () => {
    const describer = new SaiStorageTypeDescriber('DataStorage')
    const description = input().description
    description.type = ['Storage', 'DataStorage']
    description['@context'] = ['https://www.w3.org/ns/lws/v1', SAI_CONTEXT_URI]
    await describer.handle({ storage: { path: 'https://data/alice/' }, description })

    expect(description.type).toEqual(['Storage', 'DataStorage'])
    expect(description['@context']).toEqual(['https://www.w3.org/ns/lws/v1', SAI_CONTEXT_URI])
  })
})
