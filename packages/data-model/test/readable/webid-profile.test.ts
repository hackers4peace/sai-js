import { randomUUID } from 'node:crypto'
import { fetch } from '@janeirodigital/interop-test-utils'
import { describe, test } from 'vitest'
import { ApplicationFactory } from '../../src'
import { expect } from '../expect'

const factory = new ApplicationFactory({ fetch, randomUUID })
const webId = 'https://alice.example/#id'

describe('getters', () => {
  test('label', async () => {
    const webIdProfile = await factory.readable.webIdProfile(webId)
    expect(webIdProfile.label).toBe('Alice')
  })

  test.todo('oidcIssuer')
})
