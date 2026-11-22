import {
  ApplicationRegistration,
  type ApplicationRegistrationData,
  type ApplicationRegistryData,
  type InvitationRegistryData,
  type SocialAgentInvitationData,
  SocialAgentRegistration,
  type SocialAgentRegistrationData,
  type SocialAgentRegistryData,
  dataModelContext,
} from '@janeirodigital/interop-data-model'
const loadSocialAgentRegistration = loader(SocialAgentRegistration.fromJsonLd)
const loadApplicationRegistration = loader(ApplicationRegistration.fromJsonLd)

import type { AgentAndClient } from '@janeirodigital/interop-data-model'
import {
  INTEROP,
  type WhatwgFetch,
  discoverAuthorizationAgent,
  createResource,
  mintResource,
  containedIrisJsonLd,
  loader,
  withContext,
} from '@janeirodigital/interop-utils'
import type { LanguageMap } from '@janeirodigital/interop-utils'

import { setAcr } from './agent-registration.ts'
import { createApplicationRegistration } from './application-registration.ts'
import { createSocialAgentRegistration } from './social-agent-registration.ts'
import { findSocialAgentInvitation as findInvitationFromSparql } from './sparql.ts'
import type { SparqlTransport } from './sparql.ts'
import type { DataModelDependencies } from './types.ts'

// ──────────────────────────
// Behavior functions (replacing class methods)
// ──────────────────────────

/**
 * Children of a dedicated registry container — its `ldp:contains` listing,
 * server-managed (the container's own graph, included in container GET
 * representations by `DataAccessorBasedStore`). The ownership predicates
 * (`interop:hasSocialAgentRegistration` / `hasApplicationRegistration` /
 * `hasSocialAgentInvitation`) are gone: containment is the single source of
 * membership for the three dedicated registries.
 */
async function containedIris(registry: { id: string }, fetch: WhatwgFetch): Promise<string[]> {
  return containedIrisJsonLd(registry.id, fetch)
}

export async function* applicationRegistrations(
  data: ApplicationRegistryData,
  fetch: WhatwgFetch
): AsyncIterable<ApplicationRegistrationData> {
  const iris = await containedIris(data, fetch)
  for (const iri of iris) {
    yield loadApplicationRegistration(iri, fetch)
  }
}

export async function* socialAgentRegistrations(
  data: SocialAgentRegistryData,
  fetch: WhatwgFetch
): AsyncIterable<SocialAgentRegistrationData> {
  const iris = await containedIris(data, fetch)
  for (const iri of iris) {
    yield loadSocialAgentRegistration(iri, fetch)
  }
}

export async function findApplicationRegistration(
  data: ApplicationRegistryData,
  fetch: WhatwgFetch,
  registeredAgent: string
): Promise<ApplicationRegistrationData | undefined> {
  for await (const registration of applicationRegistrations(data, fetch)) {
    if (registration.registeredAgent === registeredAgent) {
      return registration
    }
  }
}

export async function findSocialAgentRegistration(
  data: SocialAgentRegistryData,
  fetch: WhatwgFetch,
  registeredAgent: string
): Promise<SocialAgentRegistrationData | undefined> {
  for await (const registration of socialAgentRegistrations(data, fetch)) {
    if (registration.registeredAgent === registeredAgent) {
      return registration
    }
  }
}

export async function findRegistration(
  socialAgentRegistry: SocialAgentRegistryData,
  applicationRegistry: ApplicationRegistryData,
  fetch: WhatwgFetch,
  id: string
): Promise<ApplicationRegistrationData | SocialAgentRegistrationData | undefined> {
  return (
    (await findApplicationRegistration(applicationRegistry, fetch, id)) ||
    findSocialAgentRegistration(socialAgentRegistry, fetch, id)
  )
}

export async function addApplicationRegistration(
  data: ApplicationRegistryData,
  deps: DataModelDependencies,
  creator: AgentAndClient,
  registeredAgent: string
): Promise<ApplicationRegistrationData> {
  const existing = await findApplicationRegistration(data, deps.fetch, registeredAgent)
  if (existing) {
    throw new Error(`Application Registration for ${registeredAgent} already exists`)
  }
  const iri = await mintResource(data.id, deps)
  const registration: ApplicationRegistrationData = {
    id: iri,
    type: [INTEROP.ApplicationRegistration],
    registeredAgent,
    hasDataGrant: [],
    granted: false,
  }
  await createApplicationRegistration(data, registration, deps.fetch)
  // containment is server-managed — no container PATCH needed
  await setAcr(registration, deps.fetch, creator, {
    agent: creator.agent,
    client: registeredAgent,
  })
  return registration
}

export async function addSocialAgentRegistration(
  data: SocialAgentRegistryData,
  deps: DataModelDependencies,
  creator: AgentAndClient,
  registeredAgent: string,
  label: LanguageMap,
  note?: string
): Promise<SocialAgentRegistrationData> {
  const existing = await findSocialAgentRegistration(data, deps.fetch, registeredAgent)
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
