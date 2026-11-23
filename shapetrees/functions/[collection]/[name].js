const BASE = 'https://shapetrees.hackers4peace.net'

// Each collection maps to one or more file representations.
// `default` is used for bare requests lacking a format hint
// (no Accept header / a `*/*` wildcard / a `.ext` suffix).
//
// `formats[].match` lists the media types a given file will satisfy,
// as well as the "subtypes" range it's an acceptable substitute for,
// ordered from most-specific to more generic. Type/subtype wildcards
// (`*/*` and `text/*`) are also accepted.
const COLLECTIONS = {
  shapes: { default: { ext: 'shex', type: 'text/shex' } },
  trees: {
    default: { ext: 'jsonld', type: 'application/ld+json' },
    formats: [
      {
        ext: 'jsonld',
        type: 'application/ld+json',
        match: ['application/ld+json', 'application/json'],
      },
      {
        ext: 'ttl',
        type: 'text/turtle',
        match: ['text/turtle', 'application/turtle', 'application/n-triples', 'text/n3'],
      },
    ],
  },
}

function reflectCors(request) {
  const origin = request.headers.get('Origin')
  if (!origin) {
    return {}
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '',
    Vary: 'Origin',
  }
}

// Parse an Accept header into [{ media, q }, ...], dropping 0-quality
// (explicitly unacceptable) entries. Missing q defaults to 1.0.
function parseAccept(header) {
  if (!header) {
    return []
  }
  return header
    .split(',')
    .map((part) => {
      const [rawMedia, ...params] = part
        .trim()
        .split(';')
        .map((s) => s.trim())
      const media = rawMedia.toLowerCase()
      let q = 1.0
      for (const p of params) {
        if (p.startsWith('q=')) {
          const v = Number.parseFloat(p.slice(2))
          if (!Number.isNaN(v)) {
            q = v
          }
        }
      }
      return { media, q }
    })
    .filter((e) => e.q > 0)
}

// Match a single media range ("text/*", "*/*", "text/turtle") against an
// Accept entry. Returns true if the range matches.
function rangeMatches(range, media) {
  if (range === '*/*') {
    return true
  }
  const [type, subtype] = range.split('/')
  const [mType, mSubtype] = media.split('/')
  if (type !== mType) {
    return false
  }
  if (subtype === '*') {
    return true
  }
  return subtype === mSubtype
}

// Given available formats and a parsed Accept list, return the best format
// (highest client-preferred media for each format's type). Returns null if
// no Accept entry matches any format.
function bestByQ(formats, accept) {
  let best = null
  let bestScore = 0
  for (const fmt of formats) {
    let score = 0
    for (const ac of accept) {
      for (const media of fmt.match) {
        if (rangeMatches(media, ac.media) || rangeMatches(ac.media, media)) {
          // A more specific match beats a wildcard match; with q tie-break.
          const specificity = media.includes('*') || ac.media.includes('*') ? 1 : 2
          const candidate = ac.q * specificity
          if (candidate > score) {
            score = candidate
          }
        }
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = fmt
    }
  }
  return best ? { ext: best.ext, type: best.type, fromAccept: true } : null
}

// Returns the chosen representation, or null when the collection is unknown.
// Honors an explicit `.ext` suffix in the URL, then the Accept header,
// then falls back to the collection default.
export function negotiate(collection, name, request) {
  const info = COLLECTIONS[collection]
  if (!info) {
    return null
  }

  // Strip an explicit file suffix from `name` if present.
  const lastDot = name.lastIndexOf('.')
  let baseName = name
  let requestedExt
  if (lastDot > 0) {
    baseName = name.slice(0, lastDot)
    requestedExt = name.slice(lastDot + 1).toLowerCase()
  }

  // If a file suffix was given and we have a matching format, use it directly,
  // regardless of Accept. (Explicit wins.)
  if (requestedExt) {
    if (info.formats) {
      const byExt = info.formats.find((f) => f.ext === requestedExt)
      if (byExt) {
        return { ext: byExt.ext, type: byExt.type, baseName }
      }
    }
    if (requestedExt === info.default.ext) {
      return { ext: info.default.ext, type: info.default.type, baseName }
    }
  }

  // No explicit suffix: negotiate via Accept, fall back to the default.
  if (!info.formats) {
    return { ext: info.default.ext, type: info.default.type, baseName }
  }

  const accept = parseAccept(request.headers.get('Accept'))
  let chosen
  if (accept.length === 0) {
    chosen = info.default
  } else if (accept.some((a) => a.media === '*/*')) {
    // A bare `*/*` means "whatever you have" — honor the collection default.
    chosen = info.default
  } else {
    chosen = bestByQ(info.formats, accept) || info.default
  }
  return { ...chosen, baseName }
}

export async function onRequest({ params, request, env }) {
  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: reflectCors(request),
    })
  }

  const { collection, name } = params
  const chosen = negotiate(collection, name, request)
  if (!chosen) {
    return new Response('Not found', { status: 404 })
  }

  // Construct path relative to your deployed static assets
  const url = new URL(`/${collection}/${chosen.baseName}.${chosen.ext}`, BASE)

  const res = await env.ASSETS.fetch(url)
  if (!res.ok) {
    return new Response('Not found', { status: 404 })
  }

  const vary = chosen.fromAccept ? 'Origin, Accept' : 'Origin'
  return new Response(res.body, {
    headers: {
      ...reflectCors(request),
      'Content-Type': chosen.type,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Expose-Headers': 'ETag, Content-Type',
      Vary: vary,
    },
  })
}
