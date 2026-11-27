/**
 * The base every minted identifier is built on. Required: an unset base would
 * mint a relative IRI (`undefined.sai/...`), which the JSON-LD layer rejects.
 */
function baseUrl(): string {
  const base = process.env.CSS_BASE_URL
  if (!base) {
    throw new Error('CSS_BASE_URL is not set: cannot mint an absolute identifier')
  }
  return base
}

// TODO: make a class to use vars from config
export function agentId(webId: string): string {
  return `${baseUrl()}.sai/agents/${Buffer.from(webId).toString('base64url')}`
}

export function registryId(webId: string): string {
  let handle
  const idOrigin = process.env.CSS_ID_ORIGIN
  const url = new URL(webId)
  if (url.hostname === idOrigin) {
    handle = url.pathname.slice(1)
  } else {
    handle = url.hostname.replace(`.${idOrigin}`, '')
  }
  return `https://${process.env.CSS_REG_ORIGIN}/${handle}/`
}

export function accessGrantsUrl(webId: string): string {
  return `${baseUrl()}.sai/grants/${Buffer.from(webId).toString('base64url')}`
}

export function accessRequestsUrl(webId: string): string {
  return `${baseUrl()}.sai/access-requests/${Buffer.from(webId).toString('base64url')}`
}

export function invitationUrl(webId: string): string {
  return `${baseUrl()}.sai/invitations/${Buffer.from(webId).toString('base64url')}.${crypto.randomUUID()}`
}
