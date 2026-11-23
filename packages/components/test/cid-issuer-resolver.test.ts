import { Readable } from 'node:stream'

import type { RepresentationConverter } from '@solid/community-server'
import {
  BadRequestHttpError,
  BasicRepresentation,
  INTERNAL_QUADS,
  readableToString,
} from '@solid/community-server'
import { Parser } from 'n3'
import { describe, expect, test, vi } from 'vitest'

import { CidIssuerResolver } from '../src/CidIssuerResolver.js'

const SUBJECT = 'https://id/alice'
const ISSUER = 'https://auth.alice.example/'

function cid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '@context': 'https://www.w3.org/ns/cid/v1',
    id: SUBJECT,
    service: [
      {
        type: 'https://www.w3.org/ns/lws#AccessRequestService',
        serviceEndpoint: 'https://auth/.sai/access-requests/alice',
      },
    ],
    ...overrides,
  }
}

function resolver(body: unknown, init: ResponseInit = {}) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), init))
  return {
    fetch,
    resolver: new CidIssuerResolver({
      converter: {} as RepresentationConverter,
      fetch: fetch as never,
    }),
  }
}

describe('CidIssuerResolver', () => {
  test('finds the OpenIdProvider service that designates the issuer', async () => {
    const { fetch, resolver: service } = resolver(
      cid({
        service: [
          ...(cid().service as Array<unknown>),
          {
            type: 'https://www.w3.org/ns/lws#OpenIdProvider',
            serviceEndpoint: ISSUER,
          },
        ],
      }),
      { headers: { 'content-type': 'application/cid' } }
    )

    await expect(service.verifySubjectDocument(SUBJECT, `${ISSUER}`)).resolves.toBeUndefined()
    // trailing slashes are normalized on both sides
    await expect(
      service.verifySubjectDocument(SUBJECT, 'https://auth.alice.example')
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(SUBJECT, {
      headers: {
        accept: 'application/ld+json, application/json;q=0.9, text/turtle;q=0.8, application/cid',
      },
    })
  })

  test('parses a Turtle CID document through the RDF converter', async () => {
    const body = `
      <${SUBJECT}> <https://www.w3.org/ns/cid/v1#service> _:provider .
      _:provider <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://www.w3.org/ns/lws#OpenIdProvider> .
      _:provider <https://www.w3.org/ns/cid/v1#serviceEndpoint> <${ISSUER}> .
    `
    const fetch = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'text/turtle' } })
    )
    const converter = {
      handleSafe: async ({ representation }: { representation: { data: unknown } }) => {
        const text = await readableToString(representation.data as never)
        return new BasicRepresentation(
          Readable.from(new Parser({ format: 'text/turtle' }).parse(text)),
          INTERNAL_QUADS
        )
      },
    } as unknown as RepresentationConverter
    const service = new CidIssuerResolver({ converter, fetch: fetch as never })

    await expect(service.verifySubjectDocument(SUBJECT, ISSUER)).resolves.toBeUndefined()
  })

  test('fails closed when the document id is not the subject', async () => {
    const { resolver: service } = resolver(
      cid({
        id: 'https://id/mallory',
        service: [{ type: 'https://www.w3.org/ns/lws#OpenIdProvider', serviceEndpoint: ISSUER }],
      }),
      { headers: { 'content-type': 'application/json' } }
    )
    await expect(service.verifySubjectDocument(SUBJECT, ISSUER)).rejects.toThrow(
      'does not designate'
    )
  })

  test('fails closed when the OpenIdProvider endpoint is another issuer', async () => {
    const { resolver: service } = resolver(
      cid({
        service: [
          {
            type: 'https://www.w3.org/ns/lws#OpenIdProvider',
            serviceEndpoint: 'https://other.example/',
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } }
    )
    await expect(service.verifySubjectDocument(SUBJECT, ISSUER)).rejects.toThrow(
      'does not designate'
    )
  })

  test('fails closed when the service is not an OpenIdProvider', async () => {
    const { resolver: service } = resolver(cid(), {
      headers: { 'content-type': 'application/json' },
    })
    await expect(service.verifySubjectDocument(SUBJECT, ISSUER)).rejects.toThrow(
      BadRequestHttpError
    )
  })

  test('fails closed when the document is unavailable', async () => {
    const fetch = vi.fn(async () => new Response('missing', { status: 404 }))
    const service = new CidIssuerResolver({
      converter: {} as RepresentationConverter,
      fetch: fetch as never,
    })
    await expect(service.verifySubjectDocument(SUBJECT, ISSUER)).rejects.toThrow(
      'Unable to retrieve'
    )
  })

  test('discovers the issuer JWKS through OIDC, then LWS metadata', async () => {
    const oidc = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}.oidc/jwks` }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('missing', { status: 404 })
    })
    const oidcResolver = new CidIssuerResolver({
      converter: {} as RepresentationConverter,
      fetch: oidc as never,
    })
    await expect(oidcResolver.getKeySet(ISSUER)).resolves.toEqual(expect.anything())
    expect(oidc).toHaveBeenCalledWith(`${ISSUER}.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    })

    const lws = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response('missing', { status: 404 })
      }
      if (url.endsWith('/.well-known/lws-configuration')) {
        return new Response(
          JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}.well-known/lws/jwks` }),
          { headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('missing', { status: 404 })
    })
    const lwsResolver = new CidIssuerResolver({
      converter: {} as RepresentationConverter,
      fetch: lws as never,
    })
    await expect(lwsResolver.getKeySet(ISSUER)).resolves.toEqual(expect.anything())
  })

  test('fails closed when no JWKS is advertised', async () => {
    const fetch = vi.fn(async () => new Response('missing', { status: 404 }))
    const service = new CidIssuerResolver({
      converter: {} as RepresentationConverter,
      fetch: fetch as never,
    })
    await expect(service.getKeySet(ISSUER)).rejects.toThrow('Unable to discover the keys')
  })
})
