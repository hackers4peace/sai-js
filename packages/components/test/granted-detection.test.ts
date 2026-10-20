import type { OpenSentAccessRequest } from '@janeirodigital/interop-authorization-agent'
import { describe, expect, test } from 'vitest'

import { matchGrantedRequests } from '../src/temporal/activities/access-request.js'

// ──────────────────────────
// Fixtures (see the OpenWiki `services/activity-lifecycle.md`)
// ──────────────────────────

const sentRequest = (
  id: string,
  dataOwner: string,
  shapeTrees: string[]
): OpenSentAccessRequest => ({
  sent: `https://registry/bob/activity/sent-${id}`,
  request: `urn:uuid:${id}`,
  grantee: 'https://id/bob',
  grantedBy: 'https://id/bob', // the requester — `=== grantee` on self-requests
  dataOwner,
  shapeTrees,
})

const grant = (grantedBy: string, shapeTree: string) => ({
  grant: `https://registry/${grantedBy === 'https://id/alice' ? 'alice' : 'x'}/grant/g`,
  grantedBy,
  shapeTree,
})

describe('matchGrantedRequests — best-effort intersection of §3.1 × §3.2', () => {
  test('grants a request when the owner granted a matching shape tree', () => {
    const requests = [
      sentRequest('r1', 'https://id/alice', ['https://data/shapetrees/trees/Project']),
    ]
    const grants = [grant('https://id/alice', 'https://data/shapetrees/trees/Project')]
    expect([...matchGrantedRequests(requests, grants)]).toEqual(['urn:uuid:r1'])
  })

  test('does NOT grant when the grant comes from a different owner', () => {
    const requests = [
      sentRequest('r1', 'https://id/alice', ['https://data/shapetrees/trees/Project']),
    ]
    // the grant's grantedBy is Karin, not the request's dataOwner Alice
    const grants = [grant('https://id/karin', 'https://data/shapetrees/trees/Project')]
    expect([...matchGrantedRequests(requests, grants)]).toEqual([])
  })

  test('does NOT grant when the shape tree is not part of the request', () => {
    const requests = [
      sentRequest('r1', 'https://id/alice', ['https://data/shapetrees/trees/Project']),
    ]
    const grants = [grant('https://id/alice', 'https://data/shapetrees/trees/Image')]
    expect([...matchGrantedRequests(requests, grants)]).toEqual([])
  })

  test('grants via partial coverage — an Inherited child grant matches a child need', () => {
    // request needs = Project + inherited Task; the grant covers Task only
    // (the child DA carries the child tree) — best-effort: still granted
    const requests = [
      sentRequest('r1', 'https://id/alice', [
        'https://data/shapetrees/trees/Project',
        'https://data/shapetrees/trees/Task',
      ]),
    ]
    const grants = [grant('https://id/alice', 'https://data/shapetrees/trees/Task')]
    expect([...matchGrantedRequests(requests, grants)]).toEqual(['urn:uuid:r1'])
  })

  test('none granted on empty grants; multiple requests resolve independently', () => {
    const requests = [
      sentRequest('r1', 'https://id/alice', ['https://data/shapetrees/trees/Project']),
      sentRequest('r2', 'https://id/alice', ['https://data/shapetrees/trees/Project']),
    ]
    expect([...matchGrantedRequests(requests, [])]).toEqual([])
    expect([
      ...matchGrantedRequests(requests, [
        grant('https://id/alice', 'https://data/shapetrees/trees/Project'),
      ]),
    ]).toEqual(['urn:uuid:r1', 'urn:uuid:r2'])
  })
})
