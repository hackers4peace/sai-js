import type { WhatwgFetch } from '@janeirodigital/interop-utils'

import { fixtureDocs } from './fixtures.ts'

const STORAGE_DESCRIPTION_IRI = 'https://fake.example/storage-desription'

const storageDescriptionJsonLd = JSON.stringify([
  {
    '@id': STORAGE_DESCRIPTION_IRI,
    '@type': ['http://www.w3.org/ns/pim/space#Storage'],
  },
])

/** The flat test store's storage root: the container without its last segment. */
function storageRootFor(containerIri: string): string {
  const container = containerIri.replace(/\/$/u, '')
  const cut = container.lastIndexOf('/')
  if (cut < 0) {
    throw new Error(`cannot derive a storage root from ${containerIri}`)
  }
  return `${container.slice(0, cut + 1)}`
}

async function common(
  url: string,
  options?: RequestInit,
  state?: { [key: string]: string }
): Promise<Response> {
  const strippedUrl = url.replace(/#.*$/, '')
  const accept = (options?.headers as Record<string, string> | undefined)?.Accept

  // LWS storage description: the requested storage root is the StorageRoot.
  if (accept === 'application/lws+cid') {
    return {
      ok: true,
      headers: { get: () => 'application/lws+cid' },
      json: async () => ({
        id: strippedUrl,
        type: 'Storage',
        service: [{ type: 'StorageRoot', serviceEndpoint: strippedUrl }],
      }),
    } as unknown as Response
  }

  if (url === STORAGE_DESCRIPTION_IRI) {
    return {
      ok: true,
      clone: () => ({}) as unknown as Response,
      headers: { get: () => 'application/ld+json' },
      text: async () => storageDescriptionJsonLd,
      json: async () => JSON.parse(storageDescriptionJsonLd),
    } as unknown as Response
  }

  const acceptsTurtle = accept === 'text/turtle'

  async function getData(): Promise<string> {
    const value = state?.[strippedUrl] ?? fixtureDocs[strippedUrl]
    if (!value) {
      throw new Error(`missing snippet: ${strippedUrl}`)
    }
    return value
  }

  const headers: Record<string, string> = {
    'Content-Type': acceptsTurtle ? 'text/turtle' : 'application/ld+json',
    Link: `<${strippedUrl}.acr>; rel="acl", <http://just.en.example/description-resource>; rel="describedby", <${STORAGE_DESCRIPTION_IRI}>; rel="http://www.w3.org/ns/solid/terms#storageDescription", <${storageRootFor(strippedUrl)}>; rel="https://www.w3.org/ns/lws#storage"`,
  }

  const response = {
    ok: true,
    headers: {
      get(name: string) {
        if (name in headers) {
          return headers[name]
        }
        throw Error(`${name} not supported`)
      },
    } as Headers,
    text: async () => getData(),
    json: acceptsTurtle
      ? undefined
      : async () => {
          const raw = await getData()
          return JSON.parse(raw)
        },
  } as unknown as Response
  response.clone = () => Object.assign({}, response)
  return response
}

function slugLocation(containerIri: string, headers?: HeadersInit): string {
  const record = (headers ?? {}) as Record<string, string>
  const slug = record.slug ?? record.Slug
  if (!slug) {
    throw new Error('POST without a slug header')
  }
  return `${storageRootFor(containerIri)}${slug}`
}

function postResponse(location: string): Response {
  const response = {
    ok: true,
    status: 201,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : undefined) },
  } as unknown as Response
  response.clone = () => Object.assign({}, response)
  return response
}

function addState(state: { [key: string]: string }): WhatwgFetch {
  return async function statefulFetch(url: string, options?: RequestInit): Promise<Response> {
    if (options?.method === 'PUT') {
      state[url] = options.body as string
      const response = { ok: true } as Response
      response.clone = () => Object.assign({}, response)
      return response
    }

    if (options?.method === 'POST') {
      const location = slugLocation(url, options.headers)
      if (typeof options.body === 'string' && options.body.length > 2) {
        state[location] = options.body
      }
      return postResponse(location)
    }

    if (options?.method === 'DELETE') {
      delete state[url]
      const response = { ok: true } as Response
      response.clone = () => Object.assign({}, response)
      return response
    }

    return common(url, options, state)
  } as WhatwgFetch
}

export function createStatefulFetch(): WhatwgFetch {
  return addState({})
}

export const statelessFetch = async function statelessFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  if (options?.method === 'PUT' || options?.method === 'PATCH') {
    const response = { ok: true } as Response
    response.clone = () => Object.assign({}, response)
    return response
  }
  if (options?.method === 'POST') {
    return postResponse(slugLocation(url, options.headers))
  }
  return common(url, options)
} as WhatwgFetch

export const fetch = statelessFetch
