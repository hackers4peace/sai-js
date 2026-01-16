// TODO: make path prefix a variable in configs
export function agentId(webId: string): string {
  return `${process.env.CSS_BASE_URL}.sai/agents/${Buffer.from(webId).toString('base64url')}`
}

export function invitationUrl(webId: string): string {
  return `${process.env.CSS_BASE_URL}.sai/invitations/${Buffer.from(webId).toString('base64url')}.${crypto.randomUUID()}`
}
