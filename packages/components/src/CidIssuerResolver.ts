import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import type { RepresentationConverter } from '@solid/community-server'
import {
  BadRequestHttpError,
  arrayifyStream,
  isJsonObject,
  responseToDataset,
  trimTrailingSlashes,
} from '@solid/community-server'
import type { JWTVerifyGetKey } from 'jose'
import { createRemoteJWKSet } from 'jose'
import type { Quad } from 'n3'

/** The CID 1.0 service terms used by controlled identifier documents. */
const CID_SERVICE = 'https://www.w3.org/ns/cid/v1#service'
const CID_SERVICE_ENDPOINT = 'https://www.w3.org/ns/cid/v1#serviceEndpoint'
/** The DID service terms used by the SAI id service's derived CID document. */
const DID_SERVICE = 'https://www.w3.org/ns/did#service'
const DID_SERVICE_ENDPOINT = 'https://www.w3.org/ns/did#serviceEndpoint'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const LWS_OPENID_PROVIDER = 'https://www.w3.org/ns/lws#OpenIdProvider'

const CID_ACCEPT = 'application/ld+json, application/json;q=0.9, text/turtle;q=0.8, application/cid'

function toArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [value]
}

function sameIssuer(first: string, second: string): boolean {
  return trimTrailingSlashes(first) === trimTrailingSlashes(second)
}

export interface CidIssuerResolverArgs {
  /** Parses RDF controlled identifier documents (Turtle, JSON-LD, …). */
  converter: RepresentationConverter
  /** Underlying fetch, injectable for tests. */
  fetch?: WhatwgFetch
}

/**
 * Resolves the trust chain of a federated ID-JAG issuer through the subject's
 * LWS Controlled Identifier document:
 *
 * 1. dereference `sub`;
 * 2. require the document `id` to equal `sub`;
 * 3. find a service with type `https://www.w3.org/ns/lws#OpenIdProvider`;
 * 4. require its endpoint to designate `iss`;
 * 5. find the issuer's JWKS (OIDC discovery, with the LWS metadata as fallback).
 *
 * There is deliberately no `solid:oidcIssuer` fallback: SAI does not add
 * WebID or Solid-OIDC support to the SAI path. Any missing or malformed
 * document/JWKS fails closed.
 */
export class CidIssuerResolver {
  private readonly converter: RepresentationConverter
  private readonly fetch: WhatwgFetch
  private readonly keySets = new Map<string, JWTVerifyGetKey>()

  public constructor(args: CidIssuerResolverArgs) {
    this.converter = args.converter
    this.fetch = args.fetch ?? (globalThis.fetch as WhatwgFetch)
  }

  public async verifySubjectDocument(subject: string, issuer: string): Promise<void> {
    let response: Response
    try {
      response = await this.fetch(subject, { headers: { accept: CID_ACCEPT } })
    } catch {
      throw new BadRequestHttpError(
        `Unable to retrieve the controlled identifier document of ${subject}.`
      )
    }
    if (response.status !== 200) {
      throw new BadRequestHttpError(
        `Unable to retrieve the controlled identifier document of ${subject}.`
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    const body = await response.text()
    // Compact CID documents are `application/cid` (or plain JSON); JSON-LD
    // profiles and Turtle go through RDF parsing. The id service prefers
    // `application/ld+json` when it is offered, so this distinction matters.
    const isCompactJson =
      contentType.includes('application/cid') ||
      (contentType.includes('json') && !contentType.includes('ld+json'))
    let valid = isCompactJson && this.hasJsonIssuer(body, subject, issuer)
    if (!valid && !isCompactJson) {
      valid = await this.hasRdfIssuer(response, body, subject, issuer)
    }
    if (!valid) {
      throw new BadRequestHttpError(
        `${subject} does not designate ${issuer} as its OpenID provider.`
      )
    }
  }

  private hasJsonIssuer(body: string, subject: string, issuer: string): boolean {
    let document: unknown
    try {
      document = JSON.parse(body)
    } catch {
      return false
    }
    if (!isJsonObject(document) || document.id !== subject || document.service === undefined) {
      return false
    }
    return toArray(document.service).some((service): boolean => {
      if (!isJsonObject(service)) {
        return false
      }
      const types = toArray(service.type)
      const endpoints = toArray(service.serviceEndpoint)
      return (
        types.includes(LWS_OPENID_PROVIDER) &&
        endpoints.some(
          (endpoint): boolean => typeof endpoint === 'string' && sameIssuer(endpoint, issuer)
        )
      )
    })
  }

  private async hasRdfIssuer(
    response: Response,
    body: string,
    subject: string,
    issuer: string
  ): Promise<boolean> {
    let quads: Array<Quad>
    try {
      const representation = await responseToDataset(response, this.converter, body)
      quads = await arrayifyStream<Quad>(representation.data)
    } catch {
      return false
    }

    const subjectQuads = quads.filter((quad): boolean => quad.subject.value === subject)
    const services = subjectQuads.filter((quad): boolean =>
      [CID_SERVICE, DID_SERVICE].includes(quad.predicate.value)
    )
    return services.some((serviceQuad): boolean => {
      const service = serviceQuad.object.value
      const hasType = quads.some(
        (quad): boolean =>
          quad.subject.value === service &&
          quad.predicate.value === RDF_TYPE &&
          quad.object.value === LWS_OPENID_PROVIDER
      )
      if (!hasType) {
        return false
      }
      return quads.some(
        (quad): boolean =>
          quad.subject.value === service &&
          [CID_SERVICE_ENDPOINT, DID_SERVICE_ENDPOINT].includes(quad.predicate.value) &&
          sameIssuer(quad.object.value, issuer)
      )
    })
  }

  /**
   * Finds the keys of the issuer. OpenID Connect Discovery is the LWS
   * OpenID Provider suite's key discovery mechanism; the LWS authorization
   * server metadata is a fallback for LWS-only issuers.
   */
  public async getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
    const cached = this.keySets.get(issuer)
    if (cached) {
      return cached
    }

    const jwksUri = await this.discoverJwksUri(issuer)
    const keySet = createRemoteJWKSet(new URL(jwksUri))
    this.keySets.set(issuer, keySet)
    return keySet
  }

  private async discoverJwksUri(issuer: string): Promise<string> {
    const base = trimTrailingSlashes(issuer)

    try {
      const response = await this.fetch(`${base}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
      })
      if (response.ok) {
        const configuration = (await response.json()) as unknown
        if (
          isJsonObject(configuration) &&
          typeof configuration.issuer === 'string' &&
          sameIssuer(configuration.issuer, issuer) &&
          typeof configuration.jwks_uri === 'string'
        ) {
          return configuration.jwks_uri
        }
      }
    } catch {
      // Fall through to the LWS metadata.
    }

    try {
      const response = await this.fetch(`${base}/.well-known/lws-configuration`, {
        headers: { accept: 'application/json' },
      })
      if (response.ok) {
        const metadata = (await response.json()) as unknown
        if (
          isJsonObject(metadata) &&
          typeof metadata.issuer === 'string' &&
          sameIssuer(metadata.issuer, issuer) &&
          typeof metadata.jwks_uri === 'string'
        ) {
          return metadata.jwks_uri
        }
      }
    } catch {
      // Fail closed below.
    }

    throw new BadRequestHttpError(`Unable to discover the keys of ${issuer}.`)
  }
}
