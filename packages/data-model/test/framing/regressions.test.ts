import { RDFS, SKOS, frameDoc } from '@janeirodigital/interop-utils'
import { describe, test } from 'vitest'

import { dataModelContext } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const GRANT_IRI = 'https://registry/acme/grant/p9m2vr'

/**
 * Framing regression guards for the shared-context refactor:
 * - `@omitDefault: true` on every frame property (no `null` noise for
 *   framed-but-absent properties)
 * - `label` (skos) and `label` (rdfs) compact to their own keys even when
 *   both IRIs appear in the same document (term-name collision guard)
 */
describe('framing regressions', () => {
  test('framed output omits absent properties instead of emitting null', async () => {
    const doc = await docFromGraphs([GRANT_IRI])
    const framed = (await frameDoc(doc, dataModelContext, GRANT_IRI)) as any
    // this grant has no inheritsFromGrant — with @omitDefault absent
    // properties must be omitted, not `null`
    expect(framed.inheritsFromGrant).toBeUndefined()
    expect(Object.values(framed).some((value) => value === null)).toBe(false)
  })

  test('the unified label term — skos:prefLabel compacts to `label`, stray rdfs:label drops', async () => {
    const doc = [
      {
        '@id': 'https://example.test/#node',
        '@type': ['http://www.w3.org/ns/solid/interop#AccessNeedDescription'],
        [SKOS.prefLabel]: [{ '@value': 'pref' }],
        [RDFS.label]: [{ '@value': 'label' }],
      },
    ]
    const framed = (await frameDoc(doc, dataModelContext, 'https://example.test/#node')) as any
    // skos:prefLabel frames to the single `label` key (context: label → SKOS.prefLabel,
    // a language map — the untagged value under `@none`)
    expect(framed.label).toEqual({ '@none': 'pref' })
    // rdfs:label has no term anymore — it must not be picked up by `label`
    expect(framed.prefLabel).toBeUndefined()
  })
})
