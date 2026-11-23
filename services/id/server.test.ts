import type { Hono } from 'hono'
import { DataFactory } from 'n3'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

const mockFetchTriples = vi.fn()

vi.mock('fetch-sparql-endpoint', () => {
  return {
    // a class, not an arrow fn — `new SparqlEndpointFetcher()` requires a constructor
    SparqlEndpointFetcher: class {
      public fetchTriples = mockFetchTriples.mockResolvedValue({
        toArray: vi.fn().mockResolvedValue([]),
      })
    },
  }
})

const idOrigin = 'example.org'
const docOrigin = 'doc.example.org'
const sparqlEndpoint = 'http://test.example.org/sparql'

let app: Hono

beforeAll(async () => {
  vi.stubEnv('ID_ORIGIN', idOrigin)
  vi.stubEnv('DOC_ORIGIN', docOrigin)
  vi.stubEnv('CSS_ID_SPARQL_ENDPOINT', sparqlEndpoint)
  app = (await import('./server.ts')).default
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('id', () => {
  test('request id without host', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('missing host')
  })
  test('request id without subdomain', async () => {
    const res = await app.request('/', {
      headers: {
        Host: idOrigin,
      },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('invalid subdomain count')
  })

  // this will end up handled by doc route
  test('request id with subdomain and path', async () => {
    const res = await app.request('/oops', {
      headers: {
        Host: `sub.${idOrigin}`,
      },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('wrong doc origin')
  })
  test('request id with subdomain', async () => {
    const res = await app.request('/', {
      headers: {
        Host: `sub.${idOrigin}`,
      },
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe(`https://${docOrigin}/sub`)
  })
  test('request id with invalid domain', async () => {
    const res = await app.request('/', {
      headers: {
        Host: 'sub.wrong.org',
      },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('invalid domain')
  })
})
describe('doc', () => {
  test('request doc without subdomain for unknown webid returns 404', async () => {
    const res = await app.request('/somehandle', {
      headers: {
        Host: `${docOrigin}`,
      },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
    expect(mockFetchTriples).toHaveBeenCalledWith(
      sparqlEndpoint,
      expect.stringContaining(`GRAPH <https://${docOrigin}/somehandle>`)
    )
  })
  test('request doc as turtle', async () => {
    mockFetchTriples.mockResolvedValue({
      toArray: vi
        .fn()
        .mockResolvedValue([
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
            DataFactory.literal('Alice')
          ),
        ]),
    })
    const res = await app.request('/somehandle', {
      headers: {
        Host: docOrigin,
        Accept: 'text/turtle',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/turtle')
    expect(await res.text()).toContain('rdfs:label')
  })
  test('request doc with subdomain', async () => {
    const res = await app.request('/anotherhandle', {
      headers: {
        Host: 'sub.${docOrigin}',
      },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('wrong doc origin')
  })
  test('request doc as cid', async () => {
    mockFetchTriples.mockResolvedValue({
      toArray: vi
        .fn()
        .mockResolvedValue([
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
            DataFactory.literal('Alice')
          ),
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('http://www.w3.org/ns/solid/terms#oidcIssuer'),
            DataFactory.namedNode(`https://${idOrigin}`)
          ),
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('http://www.w3.org/ns/solid/interop#hasAuthorizationAgent'),
            DataFactory.namedNode(
              `https://${idOrigin}/.sai/agents/aHR0cHM6Ly9kb2MubmV0L3NvbWVoYW5kbGU`
            )
          ),
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('https://www.w3.org/ns/did#service'),
            DataFactory.blankNode('sai-access-request')
          ),
          DataFactory.quad(
            DataFactory.blankNode('sai-access-request'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('https://www.w3.org/ns/lws#AccessRequestService')
          ),
          DataFactory.quad(
            DataFactory.blankNode('sai-access-request'),
            DataFactory.namedNode('https://www.w3.org/ns/did#serviceEndpoint'),
            DataFactory.namedNode('https://auth/.sai/access-requests/somehandle')
          ),
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('https://www.w3.org/ns/did#service'),
            DataFactory.blankNode('sai-access-grant')
          ),
          DataFactory.quad(
            DataFactory.blankNode('sai-access-grant'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('https://www.w3.org/ns/lws#AccessGrantService')
          ),
          DataFactory.quad(
            DataFactory.blankNode('sai-access-grant'),
            DataFactory.namedNode('https://www.w3.org/ns/did#serviceEndpoint'),
            DataFactory.namedNode('https://auth/.sai/grants/somehandle')
          ),
        ]),
    })
    const res = await app.request('/somehandle', {
      headers: {
        Host: docOrigin,
        Accept: 'application/cid',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/cid')
    const body = (await res.json()) as { service: Array<unknown> }
    expect(body).toEqual({
      '@context': 'https://www.w3.org/ns/cid/v1',
      id: `https://${docOrigin}/somehandle`,
      service: expect.arrayContaining([
        {
          type: 'https://www.w3.org/ns/lws#OpenIdProvider',
          serviceEndpoint: `https://${idOrigin}`,
        },
        {
          type: 'http://www.w3.org/ns/solid/interop#AuthorizationAgent',
          serviceEndpoint: `https://${idOrigin}/.sai/agents/aHR0cHM6Ly9kb2MubmV0L3NvbWVoYW5kbGU`,
        },
        {
          type: 'https://www.w3.org/ns/lws#AccessRequestService',
          serviceEndpoint: 'https://auth/.sai/access-requests/somehandle',
        },
        {
          type: 'https://www.w3.org/ns/lws#AccessGrantService',
          serviceEndpoint: 'https://auth/.sai/grants/somehandle',
        },
      ]),
    })
    expect(body.service).toHaveLength(4)
  })
  test('request doc as cid when profile subject differs from resource url', async () => {
    // mirrors the docker setup: resource https://id.docker/alice serves a
    // profile whose triples are anchored on https://alice.id.docker
    mockFetchTriples.mockResolvedValue({
      toArray: vi
        .fn()
        .mockResolvedValue([
          DataFactory.quad(
            DataFactory.namedNode(`http://alice.${docOrigin}`),
            DataFactory.namedNode('http://www.w3.org/ns/solid/terms#oidcIssuer'),
            DataFactory.namedNode(`https://${idOrigin}`)
          ),
        ]),
    })
    const res = await app.request('/somehandle', {
      headers: {
        Host: docOrigin,
        Accept: 'application/cid',
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      '@context': 'https://www.w3.org/ns/cid/v1',
      id: `http://alice.${docOrigin}`,
      service: [
        {
          type: 'https://www.w3.org/ns/lws#OpenIdProvider',
          serviceEndpoint: `https://${idOrigin}`,
        },
      ],
    })
  })
  test('request doc as jsonld', async () => {
    mockFetchTriples.mockResolvedValue({
      toArray: vi
        .fn()
        .mockResolvedValue([
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
            DataFactory.literal('Alice')
          ),
          DataFactory.quad(
            DataFactory.namedNode(`https://${docOrigin}/somehandle`),
            DataFactory.namedNode('http://www.w3.org/ns/solid/terms#oidcIssuer'),
            DataFactory.namedNode(`https://${idOrigin}`)
          ),
        ]),
    })
    const res = await app.request('/somehandle', {
      headers: {
        Host: docOrigin,
        Accept: 'application/ld+json',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/ld+json')
    expect(await res.json()).toEqual([
      {
        '@id': `https://${docOrigin}/somehandle`,
        'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': 'Alice' }],
        'http://www.w3.org/ns/solid/terms#oidcIssuer': [{ '@id': `https://${idOrigin}` }],
      },
    ])
  })
})
