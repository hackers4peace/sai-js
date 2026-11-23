import { describe, expect, test } from 'vitest'

import { findRolesWithMember } from '../src/sparql.js'
import type { SparqlTransport } from '../src/sparql.js'

const ROLE_REGISTRY = 'https://registry/alice/role/'
const ROLE = 'https://registry/alice/r1'
const MEMBER = 'https://id/kim'

/**
 * A fake transport encoding the graph-scoping convention (docs/sparql.md —
 * graph scoping): a membership claim is authoritative only in the role's OWN
 * graph (`FILTER(?g = ?role)`). WITHOUT the guard, a store-wide
 * `GRAPH ?g` match would bind the role from an ACTIVITY graph — the real-id
 * embedded role-to-be on `roleMembershipChanged` (activities are immutable)
 * keeps asserting the old membership forever — the phantom the deny path in
 * the updateRole workflow acted on (regenerated a removed member's grants).
 */
function phantomAwareTransport(): SparqlTransport {
  return {
    fetchBindings: async (query: string) =>
      query.includes('FILTER(?g = ?role)')
        ? // guarded: only the role's own graph counts — after the removal
          // PATCH the role graph has no member, so no match
          []
        : // unguarded: the store-wide match finds the phantom claim in the
          // activity graph
          [{ role: { value: ROLE } }],
    fetchTriples: async () => [],
  } as unknown as SparqlTransport
}

describe('findRolesWithMember', () => {
  test('carries the self-graph guard — a role embedded in an activity graph is not a membership', async () => {
    // the removal's deny path: the membership read must NOT see the add's
    // activity-graph claim (<ROLE> interop:hasMember <MEMBER>, immutable)
    const result = await findRolesWithMember(phantomAwareTransport(), ROLE_REGISTRY, MEMBER)
    expect(result).toEqual([])
  })

  test('still matches a member asserted in the role’s own graph', async () => {
    // the legit case — the role's own graph (post-PATCH) declares the member:
    // the guarded query must keep matching it (the container listing joins
    // with GRAPH <ROLE>, which passes ?g = ?role)
    const device = phantomAwareTransport()
    device.fetchBindings = async (query: string) =>
      query.includes('FILTER(?g = ?role)')
        ? [{ role: { value: ROLE } }]
        : [{ role: { value: ROLE } }]
    const result = await findRolesWithMember(device, ROLE_REGISTRY, MEMBER)
    expect(result).toEqual([ROLE])
  })
})
