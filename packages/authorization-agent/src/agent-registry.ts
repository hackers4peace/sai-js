import {
  type ApplicationRegistrationData,
  type ApplicationRegistryData,
  type InvitationRegistryData,
  type SocialAgentInvitationData,
  type SocialAgentRegistrationData,
  type SocialAgentRegistryData,
  dataModelContext,
} from '@janeirodigital/interop-data-model'
import type { AgentAndClient } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  discoverAuthorizationAgent,
  createResource,
  mintResource,
  withContext,
} from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import { setAcr } from './agent-registration.ts'
import { registerApplication } from './application-registration.ts'
import { createSocialAgentRegistration } from './social-agent-registration.ts'
import {
  findApplicationRegistration as findApplicationRegistrationFromSparql,
  findSocialAgentInvitation as findInvitationFromSparql,
  findSocialAgentRegistration as findSocialAgentRegistrationFromSparql,
} from './sparql.ts'
import type { SparqlTransport } from './sparql.ts'
import type { DataModelDependencies } from './types.ts'

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────
//
// Every membership read runs on the registry plane (`./sparql.ts`): the flat
// `lws:contains` listing + one graph read per candidate. The former HTTP
// list-and-scan twins (`containedIrisJsonLd` + one GET per candidate) are
// gone — the accept path and these write-path duplicate checks share the same
// reader, so containment semantics and flat storage cannot drift.

export async function addApplicationRegistration(
  data: ApplicationRegistryData,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  creator: AgentAndClient,
  registeredAgent: string
): Promise<ApplicationRegistrationData> {
  const existing = await findApplicationRegistrationFromSparql(transport, data.id, registeredAgent)
  if (existing) {
    throw new Error(`Application Registration for ${registeredAgent} already exists`)
  }
  return registerApplication(data, deps, creator, registeredAgent)
}

export async function addSocialAgentRegistration(
  data: SocialAgentRegistryData,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  creator: AgentAndClient,
  registeredAgent: string,
  label: LanguageMap,
  note?: string
): Promise<SocialAgentRegistrationData> {
  const existing = await findSocialAgentRegistrationFromSparql(transport, data.id, registeredAgent)
  if (existing) {
    throw new Error(`Social Agent Registration for ${registeredAgent} already exists`)
  }
  const iri = await mintResource(data.id, deps)
  const registration: SocialAgentRegistrationData = {
    id: iri,
    type: [INTEROP.SocialAgentRegistration],
    registeredAgent,
    label,
    note,
    hasDataGrant: [],
    hasAdminGrant: [],
  }
  await createSocialAgentRegistration(data, registration, deps.fetch)
  // containment is server-managed — no container PATCH needed
  const peerUas = await discoverAuthorizationAgent(registeredAgent, deps.fetch)
  if (!peerUas) throw new Error(`cannot discover authorization agent for ${registeredAgent}`)
  await setAcr(registration, deps.fetch, creator, {
    agent: registeredAgent,
    client: peerUas,
  })
  return registration
}

export async function addSocialAgentInvitation(
  data: InvitationRegistryData,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  capabilityUrl: string,
  label: string,
  note?: string
): Promise<SocialAgentInvitationData> {
  // the duplicate check runs on the registry plane — the same reader the
  // accept path uses (`InvitationHandler` → `sai.findSocialAgentInvitation`),
  // so containment semantics and flat storage cannot drift between the two
  const existing = await findInvitationFromSparql(transport, data.id, capabilityUrl)
  if (existing) {
    throw new Error(`Social Agent Invitation with ${capabilityUrl} already exists`)
  }
  const iri = await mintResource(data.id, deps)
  const invitation: SocialAgentInvitationData = {
    id: iri,
    type: [INTEROP.SocialAgentInvitation],
    capabilityUrl,
    // the label lands untagged until the flow tags it with a language
    label: { '@none': label },
    note,
  }
  await createResource(data.id, iri, deps, false, withContext(dataModelContext, invitation))
  // containment is server-managed — no container PATCH needed
  return invitation
}
