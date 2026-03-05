import type {
  AccessAuthorizationStructure,
  AuthorizationAgent,
  NestedDataAuthorizationData,
} from '@janeirodigital/interop-authorization-agent'
import {
  type CRUDSocialAgentRegistration,
  type DataAuthorizationData,
  InheritedDataGrant,
  type ReadableAccessNeed,
  type ReadableAccessNeedGroup,
} from '@janeirodigital/interop-data-model'
import { INTEROP } from '@janeirodigital/interop-utils'
import {
  type AccessAuthorization,
  AccessNeed,
  AgentType,
  type Authorization,
  type AuthorizationData,
  type GrantedAuthorization,
  IRI,
} from '@janeirodigital/sai-api-messages'
import type { Brand } from 'effect/Brand'
import type * as S from 'effect/Schema'
import { Temporal } from '../temporal/client.js'
import { createGrantsForAuthorization } from '../temporal/workflows/grants.js'

const formatAccessNeed = async (
  accessNeed: ReadableAccessNeed,
  descriptionsLang: string
): Promise<S.Schema.Type<typeof AccessNeed>> => {
  const description = await accessNeed.getDescription(descriptionsLang)
  const shapeTreeDescription = await accessNeed.shapeTree.getDescription(descriptionsLang)

  return AccessNeed.make({
    id: IRI.make(accessNeed.iri),
    label: description.label,
    description: description.definition,
    required: accessNeed.required,
    access: accessNeed.accessMode.map((mode) => IRI.make(mode)),
    shapeTree: {
      id: IRI.make(accessNeed.shapeTree.iri),
      label: shapeTreeDescription.label,
    },
    parent: accessNeed.inheritsFromNeed ? IRI.make(accessNeed.inheritsFromNeed) : undefined,
    children: accessNeed.children
      ? await Promise.all(
          accessNeed.children.map((child) => formatAccessNeed(child, descriptionsLang))
        )
      : undefined,
  })
}

async function findUserDataRegistrations(
  accessNeedGroup: ReadableAccessNeedGroup,
  saiSession: AuthorizationAgent
) {
  const dataRegistrations = []
  for (const dataRegistry of saiSession.registrySet.hasDataRegistry) {
    for (const accessNeed of accessNeedGroup.accessNeeds) {
      const dataRegistration = await saiSession.findDataRegistration(
        dataRegistry.iri,
        accessNeed.shapeTree.iri
      )
      if (dataRegistration)
        dataRegistrations.push({
          id: IRI.make(dataRegistration.iri),
          dataRegistry: IRI.make(dataRegistry.iri),
          label: `${dataRegistration.iri.split('/').slice(0, 4).join('/')}/`, // TODO get proper label,
          shapeTree: accessNeed.shapeTree.iri,
          count: dataRegistration.contains.length,
        })
    }
  }
  return dataRegistrations
}

async function findSocialAgentDataRegistrations(
  socialAgentRegistration: CRUDSocialAgentRegistration,
  accessNeedGroup: ReadableAccessNeedGroup,
  saiSession: AuthorizationAgent
) {
  const dataRegistrations = []
  if (!socialAgentRegistration.accessGrant) return []
  for (const dataGrant of socialAgentRegistration.accessGrant.hasDataGrant) {
    for (const accessNeed of accessNeedGroup.accessNeeds) {
      if (
        dataGrant.registeredShapeTree === accessNeed.shapeTree.iri &&
        !(dataGrant instanceof InheritedDataGrant) // TODO clarify case when this could happen
      ) {
        dataRegistrations.push({
          id: IRI.make(dataGrant.hasDataRegistration),
          label: `${dataGrant.hasDataRegistration.split('/').slice(0, 4).join('/')}/`, // TODO get proper label
          shapeTree: accessNeed.shapeTree.iri,
          // @ts-ignore
          count: dataGrant.hasDataInstance
            ? // @ts-ignore
              dataGrant.hasDataInstance.length
            : (await saiSession.factory.readable.dataRegistration(dataGrant.hasDataRegistration))
                .contains.length,
        })
      }
    }
  }
  return dataRegistrations
}

/**
 * Get the descriptions for the requested language. If the descriptions for the language are not found
 * `null` will be returned.
 * @param applicationIri application's profile document IRI
 * @param preferredLang XSD language requested, e.g.: "en", "es", "i-navajo".
 * @param saiSession Authoirization Agent from `@janeirodigital/interop-authorization-agent`
 */
export const getDescriptions = async (
  saiSession: AuthorizationAgent,
  agentIri: string,
  agentType: AgentType,
  preferredLang: string
): Promise<S.Schema.Type<typeof AuthorizationData>> => {
  let accessNeedGroupIri: string
  if (agentType === AgentType.Application) {
    const clientIdDocument = await saiSession.factory.readable.clientIdDocument(agentIri)
    if (!clientIdDocument.hasAccessNeedGroup) return null
    accessNeedGroupIri = clientIdDocument.hasAccessNeedGroup
  } else if (agentType === AgentType.SocialAgent) {
    const socialAgentRegistration = await saiSession.findSocialAgentRegistration(agentIri)
    if (!socialAgentRegistration) throw new Error(`registration not found for ${agentIri}`)
    accessNeedGroupIri = socialAgentRegistration.reciprocalRegistration?.hasAccessNeedGroup
    if (!accessNeedGroupIri) return null
  } else throw new Error('wrong agent type')

  const accessNeedGroup = await saiSession.factory.readable.accessNeedGroup(
    accessNeedGroupIri,
    preferredLang
  )

  const dataOwners: {
    id: string & Brand<'IRI'>
    label: string
    dataRegistrations: {
      id: string & Brand<'IRI'>
      dataRegistry?: string & Brand<'IRI'>
      label: string
      shapeTree: string
      count: number
    }[]
  }[] = [
    {
      id: IRI.make(saiSession.webId),
      label: saiSession.webId, // TODO get from user's webid document
      dataRegistrations: await findUserDataRegistrations(accessNeedGroup, saiSession),
    },
  ]

  for await (const socialAgentRegistration of saiSession.socialAgentRegistrations) {
    if (socialAgentRegistration.reciprocalRegistration) {
      const dataRegistrations = await findSocialAgentDataRegistrations(
        socialAgentRegistration.reciprocalRegistration,
        accessNeedGroup,
        saiSession
      )
      if (dataRegistrations.length) {
        dataOwners.push({
          id: IRI.make(socialAgentRegistration.registeredAgent),
          label: socialAgentRegistration.label,
          dataRegistrations,
        })
      }
    }
  }
  const descriptionLanguages = [...accessNeedGroup.reliableDescriptionLanguages]
  const descriptionsLang = accessNeedGroup.reliableDescriptionLanguages.has(preferredLang)
    ? preferredLang
    : descriptionLanguages[0]
  const descriptions = await accessNeedGroup.getDescription(descriptionsLang)

  return {
    // TODO if the id is the unique id of something then it should not be its own id. It should refer by a different name,
    //      e.g.: applicationId and be documented as such
    id: IRI.make(agentIri), // TODO change to agentID
    agentType,
    accessNeedGroup: {
      id: IRI.make(accessNeedGroup.iri),
      label: descriptions.label,
      description: descriptions.definition,
      needs: await Promise.all(
        accessNeedGroup.accessNeeds.map((need) => formatAccessNeed(need, descriptionsLang))
      ),
      descriptionLanguages,
      lang: descriptionsLang,
    },
    dataOwners,
  }
}

// currently the spec only anticipates one level of inheritance
// since we still don't have IRIs at this point, we need to use nesting to represent inheritance
// TODO validate all scopes
function buildDataAuthorizations(
  authorization: S.Schema.Type<typeof GrantedAuthorization>,
  accessNeedGroup: ReadableAccessNeedGroup
): NestedDataAuthorizationData[] {
  const structuredDataAuthorizations = authorization.dataAuthorizations.map((dataAuthorization) => {
    const accessNeed = accessNeedGroup.accessNeeds
      .flatMap((need) => [need, ...(need.children ?? [])])
      .find((need) => need.iri === dataAuthorization.accessNeed)
    if (!accessNeed) {
      throw new Error(`missing access need: ${dataAuthorization.accessNeed}`)
    }
    const saiReady: DataAuthorizationData = {
      satisfiesAccessNeed: accessNeed.iri,
      grantee: authorization.grantee,
      registeredShapeTree: accessNeed.shapeTree.iri,
      scopeOfAuthorization: INTEROP[dataAuthorization.scope].value,
      accessMode: accessNeed!.accessMode,
    }
    if (saiReady.scopeOfAuthorization === INTEROP.AllFromAgent.value) {
      saiReady.dataOwner = dataAuthorization.dataOwner
    } else if (saiReady.scopeOfAuthorization === INTEROP.AllFromRegistry.value) {
      saiReady.dataOwner = dataAuthorization.dataOwner
      saiReady.hasDataRegistration = dataAuthorization.dataRegistration
    } else if (saiReady.scopeOfAuthorization === INTEROP.SelectedFromRegistry.value) {
      saiReady.dataOwner = dataAuthorization.dataOwner
      saiReady.hasDataRegistration = dataAuthorization.dataRegistration
      saiReady.hasDataInstance = dataAuthorization.dataInstances as unknown as string[]
    }
    return saiReady
  })
  const parents: NestedDataAuthorizationData[] = []
  const children: DataAuthorizationData[] = []
  for (const structuredDataAuthorization of structuredDataAuthorizations) {
    if (structuredDataAuthorization.scopeOfAuthorization === INTEROP.Inherited.value) {
      children.push(structuredDataAuthorization)
    } else {
      parents.push(structuredDataAuthorization)
    }
  }
  return parents.map((parentDataAuthorization) => {
    // add children for each parent
    const inheritingDataAuthorizations = children.filter((childDataAuthorization) => {
      const accessNeed = accessNeedGroup.accessNeeds
        .flatMap((need) => [need, ...(need.children ?? [])])
        .find((need) => need.iri === childDataAuthorization.satisfiesAccessNeed)!

      return accessNeed.inheritsFromNeed === parentDataAuthorization.satisfiesAccessNeed
    })
    if (inheritingDataAuthorizations.length) {
      return { ...parentDataAuthorization, children: inheritingDataAuthorizations }
    }
    return parentDataAuthorization
  })
}

export const recordAuthorization = async (
  saiSession: AuthorizationAgent,
  authorization: S.Schema.Type<typeof Authorization>
): Promise<S.Schema.Type<typeof AccessAuthorization>> => {
  let structure: AccessAuthorizationStructure
  if (authorization.granted) {
    const accessNeedGroup = await saiSession.factory.readable.accessNeedGroup(
      authorization.accessNeedGroup
    )
    structure = {
      grantee: authorization.grantee,
      hasAccessNeedGroup: authorization.accessNeedGroup,
      dataAuthorizations: buildDataAuthorizations(authorization, accessNeedGroup),
      granted: true,
    }
  } else {
    structure = {
      grantee: IRI.make(authorization.grantee),
      hasAccessNeedGroup: authorization.accessNeedGroup,
      granted: false,
    }
  }

  const recorded = await saiSession.recordAccessAuthorization(structure)
  let response = { id: IRI.make(recorded.iri), ...authorization } as S.Schema.Type<
    typeof AccessAuthorization
  >
  if (authorization.agentType === AgentType.Application) {
    // we need to ensure that Application Registration exists before generating Access Grant!
    // TODO: extract
    if (!(await saiSession.findApplicationRegistration(authorization.grantee))) {
      await saiSession.registrySet.hasAgentRegistry.addApplicationRegistration(
        authorization.grantee
      )
    }
    const clientIdDocument = await saiSession.factory.readable.clientIdDocument(
      authorization.grantee
    )
    if (clientIdDocument.callbackEndpoint) {
      response = { ...response, callbackEndpoint: clientIdDocument.callbackEndpoint }
    }
  }
  const temporal = new Temporal()
  await temporal.init()
  await temporal.client.workflow.execute(createGrantsForAuthorization, {
    taskQueue: 'create-grants',
    args: [
      {
        authorizationId: recorded.iri,
        webId: saiSession.webId,
      },
    ],
    workflowId: crypto.randomUUID(),
  })
  return response
}
