import { AuthorizationRevocationFailure, IRI } from '@janeirodigital/sai-api-messages'
import * as S from 'effect/Schema'
import { describe, expect, test } from 'vitest'

import { revocationFailureDescription } from '../src/GrantRevocationHandler.js'

const grant = 'https://registry/acme/grant/p9m2vr'

/**
 * C4 / D11 — the revocation refusals are machine-readable: the authorization
 * leg's RPC failure schema round-trips, and the grant boundary maps every code
 * to a status + JSON body. No message matching.
 */
describe('AuthorizationRevocationFailure (RPC)', () => {
  const decode = S.decodeUnknownSync(AuthorizationRevocationFailure)

  test('decodes the producer refusals', () => {
    expect(decode({ code: 'empty-selection' })).toEqual({ code: 'empty-selection' })
    expect(decode({ code: 'not-a-data-authorization', authorization: IRI.make(grant) })).toEqual({
      code: 'not-a-data-authorization',
      authorization: grant,
    })
    expect(decode({ code: 'mixed-grantee', authorizations: [IRI.make(grant)] })).toEqual({
      code: 'mixed-grantee',
      authorizations: [grant],
    })
    expect(decode({ code: 'unauthorized', authorizations: [] })).toEqual({
      code: 'unauthorized',
      authorizations: [],
    })
  })
})

describe('HTTP error shapes', () => {
  // the handler only needs operation.target for the representation metadata
  const operation = { target: { path: '/delegation-endpoint' } } as never

  const cases = [
    ['unknown', 400],
    ['wrong-data-owner', 400],
    ['mixed-owner', 400],
    ['unauthorized', 403],
    ['not-delegable', 409],
  ] as const

  test.each(cases)('%s maps to %i with a JSON { code, grants } body', async (code, status) => {
    const description = revocationFailureDescription(
      { code, grants: [grant], message: 'refused' },
      operation
    )
    expect(description.statusCode).toBe(status)
    const chunks: string[] = []
    for await (const chunk of description.data as AsyncIterable<string | Uint8Array>) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    }
    const body = JSON.parse(chunks.join(''))
    expect(body).toEqual({ code, grants: [grant], message: 'refused' })
  })
})
