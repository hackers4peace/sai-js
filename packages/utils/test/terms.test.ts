import { describe, expect, test } from 'vitest'

import {
  AccessMode,
  AccessNecessity,
  AccessProfile,
  CONTEXT,
  CONTEXT_IRI,
  GrantClass,
  ScopeOfGrant,
  accessModeIri,
  asAccessModeTerm,
  asScopeTerm,
  scopeIri,
} from '../src'

describe('context terms', () => {
  test('CONTEXT is generated from the combined context', () => {
    expect(CONTEXT.AllFromRegistry).toBe('AllFromRegistry')
    expect(CONTEXT.AccessGrant).toBe('AccessGrant')
    expect(CONTEXT.read).toBe('read')
    expect(CONTEXT_IRI[CONTEXT.AllFromRegistry]).toBe(
      'http://www.w3.org/ns/solid/interop#AllFromRegistry'
    )
    expect(CONTEXT_IRI[CONTEXT.read]).toBe('http://www.w3.org/ns/odrl/2/read')
    expect(CONTEXT_IRI[CONTEXT.AccessGrant]).toBe('https://www.w3.org/ns/lws#AccessGrant')
  })

  test('typed views select terms that exist in CONTEXT', () => {
    for (const token of Object.values({
      ...ScopeOfGrant,
      ...AccessMode,
      ...AccessNecessity,
      ...AccessProfile,
      ...GrantClass,
    })) {
      expect(CONTEXT[token]).toBe(token)
      expect(CONTEXT_IRI[token]).toBeDefined()
    }
  })

  test('scope tokens normalize from token and IRI', () => {
    for (const token of Object.values(ScopeOfGrant)) {
      expect(asScopeTerm(token)).toBe(token)
      expect(asScopeTerm(CONTEXT_IRI[token])).toBe(token)
      expect(scopeIri(token)).toBe(CONTEXT_IRI[token])
    }
    expect(asScopeTerm('https://unknown.example/scope')).toBeUndefined()
  })

  test('access-mode tokens normalize from token and IRI', () => {
    for (const token of Object.values(AccessMode)) {
      expect(asAccessModeTerm(token)).toBe(token)
      expect(asAccessModeTerm(CONTEXT_IRI[token])).toBe(token)
      expect(accessModeIri(token)).toBe(CONTEXT_IRI[token])
    }
    expect(asAccessModeTerm('https://unknown.example/action')).toBeUndefined()
  })
})
