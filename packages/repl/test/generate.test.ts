import { readFileSync } from 'node:fs'

import { splitFixtureByPod } from '@janeirodigital/interop-test-utils'
import { describe, expect, test } from 'vitest'

import type { EnvMap } from '../generate.ts'
import { podDatasetsFromKeyValue, rewriteFixture } from '../generate.ts'

/** The dev map, mirrored from `environments/dev/map.json` (the bits used here). */
const map: EnvMap = {
  agents: {
    'https://id/alice': 'https://alice.id.docker',
    'https://id/acme': 'https://acme.id.docker',
  },
  prefixes: {
    'https://auth/': 'https://auth.docker/',
    'https://registry/': 'https://reg.docker/',
    'meta:https://registry/': 'meta:https://reg.docker/',
    'https://id/': 'https://id.docker/',
    'https://test-client': 'https://vuejectron.docker',
    'https://data/test-client/public/id': 'https://vuejectron.docker/id',
    'https://data/test-client/': 'https://vuejectron.data.docker/',
    'meta:https://data/test-client/': 'meta:https://vuejectron.data.docker/',
  },
}

describe('rewriteFixture', () => {
  test('graph labels keep the doc IRI while entities become the agent WebID', () => {
    const trig = `<https://id/alice> {
<https://id/alice> <http://www.w3.org/2004/02/skos/core#prefLabel> "Alice".
}
`
    const out = rewriteFixture(trig, map)
    // stored at the doc IRI (`webIdTemplate` GRAPH <document>) …
    expect(out).toContain('<https://id.docker/alice> {')
    // … describing the subdomain WebID
    expect(out).toContain(
      '<https://alice.id.docker> <http://www.w3.org/2004/02/skos/core#prefLabel>'
    )
  })

  test('meta: graph labels win over non-meta mappings', () => {
    // the client-id document now lives on the app origin, while its data-server
    // metadata graph must stay in a pod dataset
    const trig = `<meta:https://data/test-client/public/id> {
<https://data/test-client/public/id> <http://www.w3.org/ns/ma-ont#format> "application/ld+json".
}
`
    const out = rewriteFixture(trig, map)
    expect(out).toContain('<meta:https://vuejectron.data.docker/public/id> {')
    expect(out).toContain('<https://vuejectron.docker/id> <http://www.w3.org/ns/ma-ont#format>')
  })

  test('handles the explicit GRAPH keyword too', () => {
    const out = rewriteFixture(
      'GRAPH <meta:https://registry/acme/x> { <https://registry/acme/x> <https://id/alice> "x" . }\n',
      map
    )
    expect(out).toContain('GRAPH <meta:https://reg.docker/acme/x> {')
    expect(out).toContain('<https://alice.id.docker> "x"')
  })
})

describe('seed fixture', () => {
  // the real fixture + env map: every graph must resolve to a Fuseki dataset,
  // i.e. be under a pod or at the id doc origin — this is what `seed-env` did
  // not guarantee before the bare TriG graph blocks were recognized
  test('splits the dev fixture by pod without an unmatched graph', async () => {
    const fixture = readFileSync(
      new URL('../../../environments/data/registry.trig', import.meta.url),
      'utf-8'
    )
    const envMap = JSON.parse(
      readFileSync(new URL('../../../environments/dev/map.json', import.meta.url), 'utf-8')
    ) as EnvMap
    const kv = rewriteFixture(
      readFileSync(new URL('../../../environments/data/kv.json', import.meta.url), 'utf-8'),
      envMap
    )

    const datasets = await splitFixtureByPod(rewriteFixture(fixture, envMap), {
      podDatasets: podDatasetsFromKeyValue(JSON.parse(kv)),
      idOrigin: envMap.prefixes['https://id/'],
    })

    expect(datasets.has('id')).toBe(true)
    expect(datasets.has('data-test-client')).toBe(true)
    expect(datasets.has('reg-alice')).toBe(true)
    expect(datasets.get('id')).toContain('<https://id.docker/alice> {')
  })
})
