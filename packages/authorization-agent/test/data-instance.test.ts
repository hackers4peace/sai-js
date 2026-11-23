import { randomUUID } from 'node:crypto'

import { loadDataInstance } from '@janeirodigital/interop-authorization-agent'
import { describe, expect, test } from 'vitest'

import { fetch } from './mock-fetch.ts'

const deps = { fetch, randomUUID }
const projectIri = 'https://pro.alice.example/7a130c38-668a-4775-821a-08b38f2306fb#project'
const projectShapeTree = 'https://solidshapes.example/trees/Project'
const taskShapeTree = 'https://solidshapes.example/trees/Task'

describe('build', () => {
  test('should return a data instance POJO', async () => {
    const dataInstance = await loadDataInstance(projectIri, deps.fetch, projectShapeTree)
    expect(dataInstance.id).toBe(projectIri)
    expect(dataInstance.shapeTreeIri).toBe(projectShapeTree)
    expect(dataInstance.isBlob).toBe(false)
    expect(dataInstance.children).toEqual([])
  })

  test('should throw if unable to build data registration', async () => {
    await expect(
      loadDataInstance('https://pro.alice.example/ccbd77ae-f769-4e07-b41f-5136501e13e7', deps.fetch)
    ).rejects.toThrow()
  })

  test('should provide label and children if language provided', async () => {
    const dataInstance = await loadDataInstance(projectIri, deps.fetch, projectShapeTree, 'en')
    // Project tree does not define describesInstance, so no label is derived
    expect(dataInstance.label).toBeUndefined()
    expect(dataInstance.children).toHaveLength(1)
    expect(dataInstance.children[0].shapeTree.id).toBe(taskShapeTree)
    expect(dataInstance.children[0].count).toBe(1)
  })
})

describe('loadDataInstance — flat LWS parent resolution (`up` link)', () => {
  const instance = 'https://data.yoyo.example/3f2a9c1e-uuid'
  // NOT the path parent of the instance: flat storage allocates members as
  // UUIDs directly under the storage root
  const registration = 'https://data.yoyo.example/k9m4wx'
  const tree = 'https://shapetrees.example/trees/Project'

  const jsonResponse = (body: unknown): Response =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/ld+json' }),
      json: async () => body,
    }) as unknown as Response

  const docs: Record<string, unknown> = {
    [registration]: {
      '@id': registration,
      'http://www.w3.org/ns/solid/interop#registeredShapeTree': [{ '@id': tree }],
      'http://www.w3.org/ns/ldp#contains': [],
    },
    [tree]: { '@id': tree, 'http://www.w3.org/ns/shapetrees#references': [] },
  }

  test('the instance response `Link: rel="up"` supplies partOf + the registration', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === instance && init?.method === 'HEAD') {
        // LWS, §Containment: the stored `lws:partOf`, not a path guess
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            link: `<${registration}>; rel="up", <https://data.yoyo.example/>; rel="https://www.w3.org/ns/lws#storage"`,
          }),
          json: async () => ({}),
        } as unknown as Response
      }
      if (docs[url]) {
        return jsonResponse(docs[url])
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }) as unknown as Parameters<typeof loadDataInstance>[1]

    const dataInstance = await loadDataInstance(instance, fakeFetch)

    expect(dataInstance.partOf).toBe(registration)
    expect(dataInstance.dataRegistration?.id).toBe(registration)
    expect(dataInstance.shapeTreeIri).toBe(tree)
    expect(dataInstance.isBlob).toBe(false)
    // one HEAD for the parent, then the registration + shape tree — never a
    // request for the guessed path parent
    expect(calls).toEqual([`HEAD ${instance}`, `GET ${registration}`, `GET ${tree}`])
  })

  test('no `up` link and no known registration is a clear error — no path fallback', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({}),
    })) as unknown as Parameters<typeof loadDataInstance>[1]

    await expect(loadDataInstance(instance, fakeFetch)).rejects.toThrow(
      `cannot resolve the parent container of ${instance}: no \`up\` link relation on its response`
    )
  })
})
