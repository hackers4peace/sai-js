/**
 * DPoP (RFC 9449) primitives: the client's key pair, the RFC 7638 thumbprint
 * (`cnf.jkt`) and proofs for token and resource requests.
 *
 * The key pair is generated **non-extractable** by default: the private key can
 * sign but can never be read out of WebCrypto. The public half is exportable
 * (the spec always makes it so), which is all `dpop_jkt` and the proof header
 * need.
 */

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)))
}

/**
 * RFC 7638 JWK thumbprint (SHA-256, base64url) of an EC public key — the
 * `cnf.jkt` value a DPoP-bound token is bound to.
 */
export async function dpopThumbprint(key: CryptoKey | JsonWebKey): Promise<string> {
  const jwk = key instanceof CryptoKey ? await crypto.subtle.exportKey('jwk', key) : key
  // RFC 7638: the required members in lexicographic order, nothing else.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
}

/**
 * Generates the client's DPoP key pair (ECDSA P-256, the RFC 9449 default).
 *
 * @param extractable - Only `true` when the key has to leave WebCrypto (tests,
 * persisted legacy sessions). Everything in this package works with the default
 * non-extractable pair: the public key stays exportable either way.
 */
export async function createDpopKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

export interface DpopProofOptions {
  /** HTTP method of the request (`htm`). */
  method: string
  /** Request URL; `htu` drops the query and fragment (RFC 9449 §4.2). */
  url: string
  /** Key pair the proof is signed with. */
  keyPair: CryptoKeyPair
  /** Access token the request presents; its SHA-256 becomes `ath`. */
  accessToken?: string
  /** Server-provided DPoP nonce, when the server asked for one. */
  nonce?: string
  /** Clock, injectable for tests. */
  now?: () => number
}

/** The `htu` claim: the request URL without query and fragment. */
export function dpopHtu(url: string): string {
  const parsed = new URL(url)
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

/**
 * Signs one DPoP proof. The header carries the public key, so the server can
 * derive the thumbprint itself — it never has to trust a query parameter.
 */
export async function createDpopProof(options: DpopProofOptions): Promise<string> {
  const publicJwk = await crypto.subtle.exportKey('jwk', options.keyPair.publicKey)
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    // RFC 9449 §4.2: only public parameters of the key.
    jwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
  }
  const claims: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: options.method.toUpperCase(),
    htu: dpopHtu(options.url),
    iat: Math.floor((options.now ?? (() => Date.now()))() / 1000),
  }
  if (options.accessToken) {
    claims.ath = base64url(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.accessToken))
    )
  }
  if (options.nonce) {
    claims.nonce = options.nonce
  }

  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    options.keyPair.privateKey,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64url(signature)}`
}
