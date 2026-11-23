import type { WhatwgFetch } from '@janeirodigital/interop-utils'

export interface RecordedRequest {
  url: string
  method: string
  headers: Headers
  body?: string
}

export type RouteHandler = (url: URL, request: RecordedRequest) => Response | undefined

/**
 * Minimal `fetch` stand-in: records every call and answers through `route`.
 * Unmatched URLs are a 404, which is what the discovery fallbacks expect.
 */
export function createFakeFetch(route: RouteHandler): {
  fetch: WhatwgFetch
  requests: Array<RecordedRequest>
} {
  const requests: Array<RecordedRequest> = []
  const fetchImpl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const requestLike = input as { url?: string; headers?: HeadersInit; method?: string }
    const href = typeof input === 'string' ? input : (requestLike.url ?? String(input))
    const url = new URL(href)
    const headers = new Headers(init.headers ?? requestLike.headers)
    const method = (init.method ?? requestLike.method ?? 'GET').toUpperCase()
    const body = init.body === null || init.body === undefined ? undefined : String(init.body)
    const request: RecordedRequest = { url: url.href, method, headers, body }
    requests.push(request)
    return route(url, request) ?? new Response('not found', { status: 404 })
  }
  return { fetch: fetchImpl as unknown as WhatwgFetch, requests }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Builds an unsigned JWS shaped token; only `exp`/claims are ever read locally. */
export function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'ES256', typ: 'oauth-id-jag+jwt' })}.${encode(claims)}.signature`
}

export function formBody(request: RecordedRequest): URLSearchParams {
  return new URLSearchParams(request.body ?? '')
}
