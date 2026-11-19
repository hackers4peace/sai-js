/**
 * URL helpers shared by the `.sai` authentication path.
 *
 * Audience checks are deliberately URL-aware (origin + normalized path), never
 * raw string prefixes: `https://auth.evil/` must not match `https://auth/`.
 */

/** Comparable issuer identifier: no trailing slashes. */
export function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '')
}

/**
 * Whether `candidate` is under `baseUrl`: same origin, and the path is either
 * the base path itself or starts with it (with the trailing slash normalized).
 */
export function isWithinBaseUrl(candidate: string, baseUrl: string): boolean {
  let url: URL
  let base: URL
  try {
    url = new URL(candidate)
    base = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.origin !== base.origin) return false
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  return basePath === '/' || url.pathname === base.pathname || url.pathname.startsWith(basePath)
}

/** Whether the URL addresses any `.sai` route, on this or another UAS. */
export function isSaiUrl(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/.sai/')
  } catch {
    return false
  }
}

/**
 * The ID-JAG audience of a `.sai` request.
 *
 * Agent discovery (`/.sai/agents/*`) is addressed by the target UAS itself, so
 * its audience is that UAS's base URL. One-time interactions are bound to the
 * full request URL.
 */
export function saiAudience(requestUrl: string): string {
  const parsed = new URL(requestUrl)
  return parsed.pathname.startsWith('/.sai/agents/') ? `${parsed.origin}/` : parsed.href
}
