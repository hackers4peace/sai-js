/**
 * Unverified JWT decoding, used to cache grants until their `exp` and to expose
 * the claims for tracing. Never used for authorization decisions — the
 * authorization server is the one that validates the signature.
 */

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

export interface DecodedJwt {
  header: Record<string, unknown>
  claims: Record<string, unknown>
}

/** Decodes a JWS compact serialization without verifying it. */
export function decodeJwt(token: string): DecodedJwt {
  const [header, payload] = token.split('.')
  if (!header || !payload) throw new Error('not a JWS compact serialization')
  return { header: decodePart(header), claims: decodePart(payload) }
}

/**
 * The expiry of a JWT in milliseconds since the epoch, if it has a numeric
 * `exp`. Returns `undefined` for opaque or malformed tokens.
 */
export function jwtExpiresAt(token: string): number | undefined {
  try {
    const { claims } = decodeJwt(token)
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
