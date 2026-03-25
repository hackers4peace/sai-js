// TODO: make a class to use vars from config
export function agentId(webId: string): string {
  return `${process.env.CSS_BASE_URL}.sai/agents/${Buffer.from(webId).toString('base64url')}`
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

export function issuanceUrl(webId: string): string {
  return `${process.env.CSS_BASE_URL}.sai/grants/${Buffer.from(webId).toString('base64url')}`
}

export function invitationUrl(webId: string): string {
  return `${process.env.CSS_BASE_URL}.sai/invitations/${Buffer.from(webId).toString('base64url')}.${crypto.randomUUID()}`
}
