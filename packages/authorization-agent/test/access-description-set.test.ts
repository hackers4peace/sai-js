import { randomUUID } from 'node:crypto'

import { findInLanguage, loadDescriptions } from '@janeirodigital/interop-authorization-agent'
import { fetchJsonLd, toStore } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { expect } from './expect'
import { fetch } from './mock-fetch.ts'

const deps = { fetch, randomUUID }
const snippetIri = 'https://projectron.example/descriptions-en'

test('factory should build an access description set', async () => {
  const descriptionSet = { id: snippetIri }
  expect(descriptionSet).toEqual({ id: snippetIri })
})

test('should build the descriptions', async () => {
  const descriptionSet = { id: snippetIri }
  const { accessNeedDescriptions, accessNeedGroupDescriptions } = await loadDescriptions(
    descriptionSet,
    deps.fetch
  )
  expect(accessNeedDescriptions).toHaveLength(2)
  for (const description of accessNeedDescriptions) {
    expect(description.hasAccessNeed).toBeDefined()
  }
  expect(accessNeedGroupDescriptions).toHaveLength(1)
  for (const description of accessNeedGroupDescriptions) {
    expect(description.hasAccessNeedGroup).toBeDefined()
  }
})

describe('findInLanguage', () => {
  test('finds description set in language given a resource', async () => {
    const lang = 'en'
    const accessNeedIri = 'https://projectron.example/access-needs#need-project'
    const doc = (await fetchJsonLd(accessNeedIri, deps.fetch)) as Record<string, unknown>
    const dataset = await toStore(doc, accessNeedIri)
    const descriptionSetIri = findInLanguage(dataset, lang)
    expect(descriptionSetIri).toBe('https://projectron.example/descriptions-en')
  })
})
