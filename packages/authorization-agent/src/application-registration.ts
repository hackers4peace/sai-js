import { dataModelContext } from '@janeirodigital/interop-data-model'
import type {
  AgentAndClient,
  ApplicationRegistrationData,
  ApplicationRegistryData,
} from '@janeirodigital/interop-data-model'
import { INTEROP, createResource, mintResource, withContext } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'

import { setAcr } from './agent-registration.ts'
import { findApplicationRegistration as findApplicationRegistrationFromSparql } from './sparql.ts'
import type { SparqlTransport } from './sparql.ts'
import type { DataModelDependencies } from './types.ts'

// ──────────────────────────
// Write path: ApplicationRegistrationData → container (container.create)
// ──────────────────────────

/**
 * Ensure the grantee has an application registration in the registry
 * (find-first idempotent) — the activity-first granting workflow's app-leg
 * (only Application grantees are auto-registered at grant time;
 * authorization-granting.md Step 2). The grantee kind cannot ride the wire
 * (no `agentType` term), so the workflow infers it (`typeGrantee` failure).
 * The find runs on the registry plane — the same reader
 * `addApplicationRegistration` uses.
 */
export async function ensureApplicationRegistration(
  applicationRegistry: ApplicationRegistryData,
  deps: DataModelDependencies,
  transport: SparqlTransport,
  creator: AgentAndClient,
  registeredAgent: string
): Promise<void> {
  const existing = await findApplicationRegistrationFromSparql(
    transport,
    applicationRegistry.id,
    registeredAgent
  )
  if (existing) {
    return
  }
  await registerApplication(applicationRegistry, deps, creator, registeredAgent)
}

/**
 * Materialize a NEW application registration: mint the flat id through the
 * registry's identifier strategy, write the resource and set its ACR — the
 * shared tail of `addApplicationRegistration` and
 * `ensureApplicationRegistration` (their duplicate checks already ran).
 */
export async function registerApplication(
  applicationRegistry: ApplicationRegistryData,
  deps: DataModelDependencies,
  creator: AgentAndClient,
  registeredAgent: string
): Promise<ApplicationRegistrationData> {
  const iri = await mintResource(applicationRegistry.id, deps)
  const registration: ApplicationRegistrationData = {
    id: iri,
    type: [INTEROP.ApplicationRegistration],
    registeredAgent,
    hasDataGrant: [],
    granted: false,
  }
  await createApplicationRegistration(applicationRegistry, registration, deps.fetch)
  // containment is server-managed — no container PATCH needed
  await setAcr(registration, deps.fetch, creator, {
    agent: creator.agent,
    client: registeredAgent,
  })
  return registration
}

export async function createApplicationRegistration(
  registry: ApplicationRegistryData,
  data: ApplicationRegistrationData,
  fetch: WhatwgFetch
): Promise<void> {
  // The identifier strategy creates the flat container member (POST + Slug,
  // `lws:Container` link) and patches its description with the container body.
  await createResource(registry.id, data.id, { fetch }, true, withContext(dataModelContext, data))
}
