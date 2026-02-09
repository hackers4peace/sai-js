const BASE = 'https://shapetrees.hackers4peace.net'
const TYPES = {
  shapes: { ext: 'shex', type: 'text/shex' },
  trees: { ext: 'ttl', type: 'text/turtle' },
}

function reflectCors(request) {
  const origin = request.headers.get('Origin')
  if (!origin) return {}

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '',
    Vary: 'Origin',
  }
}

export async function onRequest({ params, request, env }) {
  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: reflectCors(request),
    })
  }

  const { collection, name } = params
  const typeInfo = TYPES[collection]
  if (!typeInfo) return new Response('Not found', { status: 404 })

  // Construct path relative to your deployed static assets
  const url = new URL(`/${collection}/${name}.${typeInfo.ext}`, BASE)

  const res = await env.ASSETS.fetch(url)
  if (!res.ok) return new Response('Not found', { status: 404 })
  return new Response(res.body, {
    headers: {
      ...reflectCors(request),
      'Content-Type': typeInfo.type,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Expose-Headers': 'ETag, Content-Type',
    },
  })
}
