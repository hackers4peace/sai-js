import {
  findInheritingAuthorizations,
  storeDataAuthorizations,
} from '@janeirodigital/interop-authorization-agent'
import {
  ACCESS_ACTIONS,
  INTEROP,
  type SparqlBindingTerm,
  type SparqlTransport,
  fetchJsonLd,
  toStore,
} from '@janeirodigital/interop-utils'
import { DataFactory } from 'n3'
import { describe, expect, test } from 'vitest'

import { expect as saiExpect } from './expect'
import { createStatefulFetch } from './mock-fetch.ts'

// ──────────────────────────
// Parent→child inheritance across the activity-first write path
// (authorization-granting.md): the FRAMED activity drops the parent's
// `@reverse` `hasInheritingAuthorization` (embedded nodes cannot resolve
// reverse terms — activity-registry.test.ts documents the loss), so the
// workflow receives parents WITHOUT the child list. The child's forward
// `inheritsFromAuthorization` always survives — the store re-links from it,
// and the readers query the forward direction as the reliable source.
// ──────────────────────────

const PARENT = 'https://auth.alice.example/00000000-0000-4000-8000-000000000001'
const CHILD = 'https://auth.alice.example/00000000-0000-4000-8000-000000000002'
const GRANTEE = 'https://id/alice'
const GRANTED_BY = 'https://id/bob'

/** The activity-first input shape: parent missing `hasInheritingAuthorization`
 *  (framing dropped it), child carrying the forward link. */
const dataAuthorizations = [
  {
    id: PARENT,
    type: [INTEROP.DataAuthorization],
    grantee: GRANTEE,
    grantedBy: GRANTED_BY,
    registeredShapeTree: 'https://shapetrees.hackers4peace.net/trees/Project',
    scopeOfAuthorization: INTEROP.AllFromAgent,
    dataOwner: GRANTED_BY,
    accessMode: [ACCESS_ACTIONS.read],
    hasInheritingAuthorization: [],
  },
  {
    id: CHILD,
    type: [INTEROP.DataAuthorization],
    grantee: GRANTEE,
    grantedBy: GRANTED_BY,
    registeredShapeTree: 'https://shapetrees.hackers4peace.net/trees/Task',
    scopeOfAuthorization: INTEROP.Inherited,
    dataOwner: GRANTED_BY,
    accessMode: [ACCESS_ACTIONS.read],
    inheritsFromAuthorization: PARENT,
  },
]

const AUTHORIZATION_REGISTRY = 'https://auth.alice.example/authorization-registry/'

describe('storeDataAuthorizations — re-links the parent from the child forward link', () => {
  test('stored parent carries the reverse quad even when the input dropped it', async () => {
    const fetch = createStatefulFetch()
    await storeDataAuthorizations(
      dataAuthorizations as never,
      { id: AUTHORIZATION_REGISTRY },
      {
        fetch,
        randomUUID: () => '00000000-0000-0000-0000-000000000000',
      }
    )
    // the parent's stored graph must contain the child→parent quad
    // (`@reverse` serializes the inverse triple into the parent's PUT body)
    const store = await toStore(await fetchJsonLd(PARENT, fetch), PARENT)
    saiExpect(store).toBeRdfDatasetContaining(
      DataFactory.quad(
        DataFactory.namedNode(CHILD),
        INTEROP.terms.inheritsFromAuthorization,
        DataFactory.namedNode(PARENT)
      )
    )
  })
})

describe('findInheritingAuthorizations — forward-direction child lookup', () => {
  const term = (value: string): SparqlBindingTerm => ({ termType: 'NamedNode', value })
  function capturingTransport(
    bindings: Array<Record<string, SparqlBindingTerm>>,
    queries: Array<string>
  ): SparqlTransport {
    return {
      fetchBindings: async (query: string) => {
        queries.push(query)
        return bindings
      },
      fetchTriples: async () => [],
    } as unknown as SparqlTransport
  }

  test('returns children via `inheritsFromAuthorization`', async () => {
    const queries: Array<string> = []
    const transport = capturingTransport([{ child: term(CHILD) }], queries)
    const result = await findInheritingAuthorizations(transport, PARENT)
    expect(result).toEqual([CHILD])
    expect(queries[0]).toContain('inheritsFromAuthorization')
    expect(queries[0]).toContain(PARENT)
  })
})
