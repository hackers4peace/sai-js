import type {
  AuthorizationAgent,
  ShareDataInstanceStructure,
} from '@janeirodigital/interop-authorization-agent'
import {
  IRI,
  Resource,
  type ShareAuthorization,
  type ShareAuthorizationConfirmation,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { Temporal } from '../temporal/client.js'
import { createGrantsForAuthorization } from '../temporal/workflows/grants.js'

export const getResource = async (saiSession: AuthorizationAgent, iri: string, lang: string) => {
  const resource = await saiSession.factory.readable.dataInstance(iri, lang)
  if (!resource) throw new Error(`Resource not found: ${iri}`)
  return Resource.make({
    id: IRI.make(resource.iri),
    label: resource.label,
    shapeTree: {
      id: IRI.make(resource.shapeTree.iri),
      label: resource.shapeTree.label,
    },
    accessGrantedTo: (await saiSession.findSocialAgentsWithAccess(resource.iri)).map(({ agent }) =>
      IRI.make(agent)
    ),
    children: resource.children.map((child) => ({
      shapeTree: {
        id: IRI.make(child.shapeTree.iri),
        label: child.shapeTree.label,
      },
      count: child.count,
    })),
  })
}

export const shareResource = async (
  saiSession: AuthorizationAgent,
  shareAuthorization: S.Schema.Type<typeof ShareAuthorization>
): Promise<S.Schema.Type<typeof ShareAuthorizationConfirmation>> => {
  // TODO: finde cleaner way of dealing with types
  const authorizationIris = await saiSession.shareDataInstance(
    shareAuthorization as unknown as ShareDataInstanceStructure
  )

  const clientIdDocument = await saiSession.factory.readable.clientIdDocument(
    shareAuthorization.applicationId
  )

  // TODO: consider a single workflow that will fire-and-forget all the child workflows
  const temporal = new Temporal()
  await temporal.init()
  await Promise.all(
    authorizationIris.map((authorizationIri) =>
      temporal.client.workflow.start(createGrantsForAuthorization, {
        taskQueue: 'create-grants',
        args: [
          {
            authorizationId: authorizationIri,
            webId: saiSession.webId,
          },
        ],
        workflowId: crypto.randomUUID(),
      })
    )
  )

  return {
    callbackEndpoint: clientIdDocument.callbackEndpoint!,
  }
}

export async function requestAccessUsingApplicationNeeds(
  saiSession: AuthorizationAgent,
  applicationIri: string,
  webId: string
): Promise<void> {
  const socialAgentRegistration = await saiSession.findSocialAgentRegistration(webId)
  const clientIdDocument = await saiSession.factory.readable.clientIdDocument(applicationIri)
  await socialAgentRegistration.setAccessNeedGroup(clientIdDocument.hasAccessNeedGroup)
}
