import { describe, expect, test } from 'vitest'

import {
  ID_DATASET,
  datasetForGraph,
  datasetForPod,
  fixturePodDatasets,
  splitFixtureByPod,
} from '../src/fuseki.js'

const podDatasets = fixturePodDatasets(
  [{ webId: 'https://id/acme', podBaseUrls: ['https://data/acme-rnd/'] }],
  'https://registry/'
)

describe('datasetForPod', () => {
  test('derives the dataset from a pod URL (path segment or subdomain)', () => {
    expect(datasetForPod('https://registry/acme/', 'registry')).toBe('reg-acme')
    expect(datasetForPod('https://data/alice-home/', 'data')).toBe('data-alice-home')
    // dev/demo subdomain form
    expect(datasetForPod('https://reg.docker/alice/', 'registry')).toBe('reg-alice')
    expect(datasetForPod('https://alice-home.data.docker/', 'data')).toBe('data-alice-home')
  })
})

describe('fixturePodDatasets', () => {
  test('maps registry + data pod URLs to dataset names', () => {
    expect(podDatasets.get('https://registry/acme/')).toBe('reg-acme')
    expect(podDatasets.get('https://data/acme-rnd/')).toBe('data-acme-rnd')
  })

  test('derives the registry pod from a subdomain WebID (dev/demo form)', () => {
    const datasets = fixturePodDatasets(
      [{ webId: 'https://acme.id.docker', podBaseUrls: ['https://acme-rnd.data.docker/'] }],
      'https://reg.docker/'
    )
    expect(datasets.get('https://reg.docker/acme/')).toBe('reg-acme')
    expect(datasets.get('https://acme-rnd.data.docker/')).toBe('data-acme-rnd')
  })
})

describe('datasetForGraph', () => {
  const opts = { podDatasets }

  test('routes registry set graphs to reg-<handle> (meta: ignored)', () => {
    expect(datasetForGraph('https://registry/acme/k9m4vp', opts)).toBe('reg-acme')
    expect(datasetForGraph('meta:https://registry/acme/grant/', opts)).toBe('reg-acme')
  })

  test('routes data pod graphs to data-<pod>', () => {
    expect(datasetForGraph('https://data/acme-rnd/reb39k', opts)).toBe('data-acme-rnd')
    expect(datasetForGraph('meta:https://data/acme-rnd/', opts)).toBe('data-acme-rnd')
  })

  test('routes id profiles to the id dataset', () => {
    expect(datasetForGraph('https://id/alice', opts)).toBe(ID_DATASET)
    expect(datasetForGraph('meta:https://id/alice', opts)).toBe(ID_DATASET)
  })

  test('throws for a graph that is not under a pod or the id origin', () => {
    expect(() => datasetForGraph('https://registry/', opts)).toThrow('no dataset for graph')
    expect(() => datasetForGraph('https://data/shapetrees/trees/Project', opts)).toThrow(
      'no dataset for graph'
    )
    expect(() => datasetForGraph('https://data/test-client/public/id', opts)).toThrow(
      'no dataset for graph'
    )
  })
})

describe('splitFixtureByPod', () => {
  const opts = {
    podDatasets: fixturePodDatasets(
      [
        {
          webId: 'https://id/acme',
          podBaseUrls: ['https://data/acme-rnd/', 'https://data/shapetrees/'],
        },
      ],
      'https://registry/'
    ),
  }
  const fixture = `@prefix ex: <http://ex/> .
GRAPH <https://registry/acme/a1> { ex:s ex:p ex:o . }
GRAPH <meta:https://registry/acme/a1> { ex:s a ex:Resource . }
GRAPH <https://data/acme-rnd/r1> { ex:s2 ex:p ex:o . }
GRAPH <https://data/shapetrees/trees/Project> { ex:t ex:p ex:o . }
GRAPH <https://id/alice> { ex:me ex:p ex:o . }
`

  test('groups every graph into exactly one dataset', async () => {
    const split = await splitFixtureByPod(fixture, opts)
    expect([...split.keys()].toSorted()).toEqual([
      'data-acme-rnd',
      'data-shapetrees',
      'id',
      'reg-acme',
    ])

    const reg = split.get('reg-acme')!
    expect(reg).toContain('https://registry/acme/a1')
    expect(reg).toContain('meta:https://registry/acme/a1')
    expect(reg).not.toContain('acme-rnd')

    const data = split.get('data-acme-rnd')!
    expect(data).toContain('https://data/acme-rnd/r1')
    expect(data).not.toContain('shapetrees')

    const shapetrees = split.get('data-shapetrees')!
    expect(shapetrees).toContain('https://data/shapetrees/trees/Project')
    expect(shapetrees).not.toContain('https://id/alice')

    const id = split.get('id')!
    expect(id).toContain('https://id/alice')
  })
})

describe('splitFixtureByPod — reciprocal mirror backfill', () => {
  const opts = {
    podDatasets: fixturePodDatasets(
      [
        { webId: 'https://id/acme', podBaseUrls: [] },
        { webId: 'https://id/alice', podBaseUrls: [] },
      ],
      'https://registry/'
    ),
  }
  const fixture = `@prefix interop: <http://www.w3.org/ns/solid/interop#> .
@prefix lws: <https://www.w3.org/ns/lws#> .
GRAPH <meta:https://registry/acme/reg-acme> {
  <https://registry/acme/reg-acme> a interop:SocialAgentRegistration ;
    interop:reciprocalRegistration <https://registry/alice/reg-alice> .
}
GRAPH <meta:https://registry/alice/reg-alice> {
  <https://registry/alice/reg-alice> a interop:SocialAgentRegistration ;
    interop:hasDataGrant <https://registry/alice/g1> .
}
GRAPH <https://registry/alice/g1> { <https://registry/alice/g1> a lws:AccessGrant . }
`

  test('copies the reciprocal target + its grants into the linking owner dataset', async () => {
    const split = await splitFixtureByPod(fixture, opts)
    const acme = split.get('reg-acme')!
    expect(acme).toContain('https://registry/acme/reg-acme')
    expect(acme).toContain('https://registry/alice/reg-alice')
    expect(acme).toContain('https://registry/alice/g1')
    expect(split.get('reg-alice')!).not.toContain('reg-acme')
  })
})
