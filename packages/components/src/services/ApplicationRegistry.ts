import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { ClientIdDocument } from '@janeirodigital/interop-data-model'
import type { ApplicationRegistrationData } from '@janeirodigital/interop-data-model'
import { loader } from '@janeirodigital/interop-utils'
const loadClientIdDocument = loader(ClientIdDocument.fromJsonLd)
import { Application, IRI, UnregisteredApplication } from '@janeirodigital/sai-api-messages'

import type { ResolvedContext } from './Context.js'
import {
  getApplicationRegistration as getApplicationRegistrationFromSparql,
  listContained,
  sparqlTransportFor,
} from './queries/org.js'

const buildApplicationProfile = async (
  ctx: ResolvedContext,
  registration: ApplicationRegistrationData
) => {
  // Design B: the registration resource is single-node — name/logo/accessNeedGroup/
  // callbackEndpoint come from the client ID document (the canonical source)
  const clientIdDocument = await loadClientIdDocument(
    registration.registeredAgent,
    ctx.session.fetch
  )
  // TODO (angel) data validation and how to handle when the applications profile is missing some components?
  return Application.make({
    id: IRI.make(registration.registeredAgent),
    name: clientIdDocument.clientName,
    logo: clientIdDocument.logoUri,
    //authorizationDate: registration.registeredAt!.toISOString(),
    //lastUpdateDate: registration.updatedAt?.toISOString(),
    accessNeedGroup: clientIdDocument.hasAccessNeedGroup,
    callbackEndpoint: clientIdDocument.callbackEndpoint,
  })
}
/**
 * Returns all the registered applications for the context's application
 * registry — via SPARQL over its server-managed `ldp:contains` listing
 * (docs/sparql.md step 3): personal context reads the session's internal
 * endpoint, org context the org's `/sparql-admin` (`sparqlTransportFor`).
 * The per-app profile still dereferences the client-id document over HTTP
 * (webid/client-id profiles stay data-plane).
 */
export const getApplications = async (ctx: ResolvedContext) => {
  const transport = sparqlTransportFor(ctx)
  const iris = await listContained(transport, ctx.registrySet.hasApplicationRegistry.id)
  const registrations = await Promise.all(
    iris.map((iri) => getApplicationRegistrationFromSparql(transport, iri))
  )
  const profiles = []
  for (const registration of registrations) {
    profiles.push(await buildApplicationProfile(ctx, registration))
  }
  return profiles
}

/**
 * Returns the application profile of an application that is _not_ registered for the given agent
 */
export const getUnregisteredApplication = async (agent: AuthorizationAgent, id: IRI) => {
  const { name, logo, accessNeedGroup } = await loadClientIdDocument(id, agent.fetch).then(
    (doc) => ({
      name: doc.clientName,
      logo: doc.logoUri,
      accessNeedGroup: doc.hasAccessNeedGroup,
    })
  )

  return UnregisteredApplication.make({ id: IRI.make(id), name, logo, accessNeedGroup })
}
