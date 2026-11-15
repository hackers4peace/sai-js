import { DataFactory } from 'n3'
import { expect, test } from 'vitest'

import { ODRL_ID_JAG_CONTEXT, parseJsonld } from '../src'

const snippet = `
{
  "@context": {
    "ical": "http://www.w3.org/2002/12/cal/ical#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "ical:dtstart": {
      "@type": "xsd:dateTime"
    }
  },
  "ical:summary": "Lady Gaga Concert",
  "ical:location": "New Orleans Arena, New Orleans, Louisiana, USA",
  "ical:dtstart": "2011-04-09T20:00:00Z"
}
`

test('should parse json-ld', async () => {
  const source = 'https://some.example/'
  const dataset = await parseJsonld(snippet, source)
  expect(dataset.size).toBe(3)
})

test('uses DefaultGraph is none is provided', async () => {
  const dataset = await parseJsonld(snippet)
  expect(dataset.size).toBeGreaterThan(1)
  for (const quad of dataset) {
    expect(quad.graph.termType).toEqual('DefaultGraph')
  }
})

test('parses a CID document with the embedded cid context', async () => {
  const cid = JSON.stringify({
    '@context': ['https://www.w3.org/ns/cid/v1'],
    id: 'https://id.example/alice',
    service: [
      {
        type: 'https://www.w3.org/ns/lws#OpenIdProvider',
        serviceEndpoint: 'https://auth.example/',
      },
    ],
  })
  const dataset = await parseJsonld(cid)
  const { namedNode, quad } = DataFactory
  const serviceTriples = [...dataset].filter(
    (q) => q.predicate.value === 'https://www.w3.org/ns/did#service'
  )
  expect(serviceTriples).toHaveLength(1)
  const serviceNode = serviceTriples[0].object
  expect([...dataset]).toContainEqual(
    quad(
      serviceNode,
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode('https://www.w3.org/ns/lws#OpenIdProvider')
    )
  )
  expect([...dataset]).toContainEqual(
    quad(
      serviceNode,
      namedNode('https://www.w3.org/ns/did#serviceEndpoint'),
      namedNode('https://auth.example/')
    )
  )
})

test('expands the ODRL access claim through the bundled ID-JAG context', async () => {
  const doc = JSON.stringify({
    '@context': ODRL_ID_JAG_CONTEXT,
    '@graph': [
      {
        id: 'urn:policy',
        type: ['Agreement'],
        profile: 'https://www.w3.org/ns/solid/interop#AccessProfile',
        scopeOfGrant: 'https://www.w3.org/ns/solid/interop#AllFromRegistry',
        permission: [
          {
            id: 'urn:permission',
            assigner: 'https://id/yoyo',
            assignee: 'https://app.example/id',
            action: ['read'],
            target: {
              id: 'urn:target',
              owner: 'https://id/acme',
              storage: 'https://data/acme.example/',
              type: ['AssetCollection', 'DataRegistration'],
              source: ['https://data/acme.example/registration/'],
            },
          },
        ],
      },
    ],
  })
  const dataset = await parseJsonld(doc)
  const { namedNode, quad } = DataFactory
  const ODRL = 'http://www.w3.org/ns/odrl/2/'
  const INTEROP = 'http://www.w3.org/ns/solid/interop#'
  const LWS = 'https://www.w3.org/ns/lws#'
  const quads = [...dataset]

  expect(quads).toContainEqual(
    quad(namedNode('urn:permission'), namedNode(`${ODRL}assigner`), namedNode('https://id/yoyo'))
  )
  expect(quads).toContainEqual(
    quad(namedNode('urn:target'), namedNode(`${INTEROP}dataOwner`), namedNode('https://id/acme'))
  )
  expect(quads).toContainEqual(
    quad(
      namedNode('urn:target'),
      namedNode(`${LWS}storage`),
      namedNode('https://data/acme.example/')
    )
  )
  expect(quads).toContainEqual(
    quad(namedNode('urn:permission'), namedNode(`${ODRL}action`), namedNode(`${ODRL}read`))
  )
})

test('parses an LWS access document through the bundled LWS context', async () => {
  const doc = JSON.stringify({
    '@context': ['https://www.w3.org/ns/lws/v1'],
    id: 'https://registry.example/grant-1',
    type: ['AccessGrant'],
    storage: 'https://data.example/',
    access: [
      {
        type: ['AccessPolicy'],
        assignee: 'https://id.example/bob',
        action: ['read', 'create'],
        target: { type: 'Container', value: ['https://data.example/registration'] },
      },
    ],
  })
  const dataset = await parseJsonld(doc)
  const { namedNode, quad } = DataFactory
  const quads = [...dataset]
  const grant = namedNode('https://registry.example/grant-1')
  const LWS = 'https://www.w3.org/ns/lws#'
  const ODRL = 'http://www.w3.org/ns/odrl/2/'

  expect(quads).toContainEqual(
    quad(
      grant,
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode(`${LWS}AccessGrant`)
    )
  )

  const access = quads.find((q) => q.predicate.value === `${LWS}access`)!
  const policy = access.object
  // assignee is an IRI (the upstream context stores it as a literal)
  expect(quads).toContainEqual(
    quad(policy, namedNode(`${ODRL}assignee`), namedNode('https://id.example/bob'))
  )
  expect(
    quads
      .filter((q) => q.subject.equals(policy) && q.predicate.value === `${ODRL}action`)
      .map((q) => q.object.value)
      .toSorted()
  ).toEqual([`${LWS}create`, `${ODRL}read`].toSorted())

  const target = quads.find(
    (q) => q.subject.equals(policy) && q.predicate.value === `${ODRL}target`
  )!.object
  expect(quads).toContainEqual(
    quad(
      target,
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode(`${LWS}Container`)
    )
  )
  // target.value survives expansion as lws:value
  expect(quads).toContainEqual(
    quad(target, namedNode(`${LWS}value`), namedNode('https://data.example/registration'))
  )
})
