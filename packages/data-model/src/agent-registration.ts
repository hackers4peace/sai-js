export type AgentRegistrationId = {
  id: string
  type: Array<string>
}

export type AgentRegistrationData = AgentRegistrationId & {
  registeredAgent: string
  /** `interop:hasDataGrant` — the registration's link predicate to `lws:AccessGrant` resources (the wire term is kept for Interop compatibility). */
  hasDataGrant?: Array<string>
}

/** IRIs of the linked access grants (`hasDataGrant` link set). */
export function getAccessGrantIris(data: AgentRegistrationData): Array<string> {
  return data.hasDataGrant ?? []
}
