import { randomUUID } from 'node:crypto'

import { AccessNeed, accessNeed } from '@janeirodigital/interop-authorization-agent'
import { ACCESS_ACTIONS } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { expect } from './expect'
import { fetch } from './mock-fetch.ts'

const deps = { fetch, randomUUID }
const snippetIri = 'https://projectron.example/access-needs#need-project'
const childIri = 'https://projectron.example/access-needs#need-task'

test('factory should build an access need', async () => {
  const need = await accessNeed(snippetIri, deps.fetch)
  expect(need.id).toBe(snippetIri)
})

test('getters', async () => {
  const need = await accessNeed(snippetIri, deps.fetch)
  expect(need.registeredShapeTree).toBe('https://solidshapes.example/trees/Project')
  expect(need.inheritsFromNeed).toBeUndefined()
  expect(need.hasInheritingNeed).toEqual(expect.arrayContaining([childIri]))
  expect(need.accessMode).toEqual(
    expect.arrayContaining([
      ACCESS_ACTIONS.read,
      ACCESS_ACTIONS.create,
      ACCESS_ACTIONS.modify,
      ACCESS_ACTIONS.delete,
    ])
  )
  expect(need.required).toBe(true)
})

test('children', async () => {
  const need = await accessNeed(snippetIri, deps.fetch)
  expect(need.children).toHaveLength(1)
  expect(need.children[0].id).toBe(childIri)
})

test('parent', async () => {
  const childNeed = await accessNeed(childIri, deps.fetch)
  expect(childNeed.inheritsFromNeed).toBe(snippetIri)
  expect(childNeed.hasInheritingNeed).toHaveLength(0)
})

describe('descriptions', () => {
  test('should get description for language', async () => {
    const lang = 'en'
    const need = await accessNeed(snippetIri, deps.fetch)
    const description = await AccessNeed.getDescription(need, lang, deps.fetch)
    expect(description).toBeDefined()
    expect(description?.label).toEqual({
      en: 'Access to Projects is essential for Projectron to perform its core function of Project Management',
    })
  })

  test('should gracefully fail if no description set for language', async () => {
    const lang = 'fr'
    const need = await accessNeed(snippetIri, deps.fetch)
    const description = await AccessNeed.getDescription(need, lang, deps.fetch)
    expect(description).toBeUndefined()
  })

  test('should gracefully fail if description set with missing description for language', async () => {
    const lang = 'de'
    const need = await accessNeed(snippetIri, deps.fetch)
    const description = await AccessNeed.getDescription(need, lang, deps.fetch)
    expect(description).toBeUndefined()
  })

  test('should get description languages', async () => {
    const need = await accessNeed(snippetIri, deps.fetch)
    expect([...need.descriptionLanguages].toSorted()).toStrictEqual(['en', 'pl'])
  })

  test('should get reliable description languages', async () => {
    const need = await accessNeed(snippetIri, deps.fetch)
    const languages = await AccessNeed.reliableDescriptionLanguages(need, deps.fetch)
    expect([...languages].toSorted()).toStrictEqual(['en', 'pl'])
  })
})

describe('LWS reads', () => {
  test('every data-pod document read asks for the LWS JSON-LD profile', async () => {
    const accepts: string[] = []
    const recordingFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept
      if (accept) accepts.push(accept)
      return fetch(url, init)
    }) as unknown as typeof fetch

    const need = await accessNeed(snippetIri, recordingFetch)
    const description = await AccessNeed.getDescription(need, 'en', recordingFetch)
    expect(description).toBeDefined()

    // the need's own document, the description set and each description go
    // through `fetchJsonLd` — plain `application/ld+json` is only its 406/415
    // fallback, never the first request
    expect(accepts.length).toBeGreaterThan(0)
    for (const accept of accepts) {
      expect(accept).toContain('profile="https://www.w3.org/ns/lws/v1"')
    }
  })
})
