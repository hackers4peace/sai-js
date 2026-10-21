import {
  ActivityRegistry,
  findDelegableGrant,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import type {
  AccessRequestMessage,
  EmbeddedNeedBasedAccessRequest,
  FinalGrantData,
  IncomingGrantData,
  NeedBasedAccessRequestMessage,
  NeedBasedAccessRequestReceived,
} from '@janeirodigital/interop-data-model'
import { discoverAuthorizationAgent, iriForContained } from '@janeirodigital/interop-utils'
import { INTEROP } from '@janeirodigital/interop-utils'
import {
  APPLICATION_JSON,
  BadRequestHttpError,
  BasicRepresentation,
  ForbiddenHttpError,
  OkResponseDescription,
  OperationHttpHandler,
  ResponseDescription,
  UnauthorizedHttpError,
  UnsupportedMediaTypeHttpError,
  readableToString,
} from '@solid/community-server'
import type { CredentialsExtractor, OperationHttpHandlerInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import { GrantRevocationHandler } from './GrantRevocationHandler.js'
import {
  isAccessRequestMessage,
  isAccessRevocationMessage,
  isNeedBasedAccessRequestMessage,
} from './messages.js'
import type { PodEndpointStore } from './PodEndpointStore.js'
import type { SessionManager } from './SessionManager'
import { Temporal } from './temporal/client.js'
import { storeGrant } from './temporal/workflows/grants.js'

/** The JSON-LD media type the whole endpoint now requires (§6.2). */
const LD_JSON_MEDIA_TYPE = 'application/ld+json'

export class GrantIssuanceHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)
  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager,
    private readonly endpointStore: PodEndpointStore
  ) {
    super()
  }
  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const credentials = await this.credentialsExtractor.handleSafe(request)
    if (!credentials.agent?.webId || !credentials.client?.clientId) {
      // missing credentials is an AUTHENTICATION failure — 401, not 403
      // (authorization-granting.md §6.2, codes decided 2026-09)
      throw new UnauthorizedHttpError()
    }
    // TODO: check if WebID served by this authz agent

    // the whole endpoint requires JSON-LD (authorization-granting.md §6.2 —
    // the WHOLE-endpoint gate, decided 2026-09; the delegation tests send
    // the header now)
    if (operation.body.metadata.contentType !== LD_JSON_MEDIA_TYPE) {
      throw new UnsupportedMediaTypeHttpError(`expected content type ${LD_JSON_MEDIA_TYPE}`)
    }

    const uasId = await discoverAuthorizationAgent(credentials.agent.webId, fetch)
    if (credentials.client.clientId !== uasId) {
      throw new ForbiddenHttpError()
    }

    // the delegation endpoint dispatches on the message `type`
    const message = await this.parseMessage(operation)
    if (isAccessRevocationMessage(message)) {
      return new GrantRevocationHandler(this.endpointStore, this.sessionManager).revoke(
        message,
        credentials,
        operation
      )
    }
    if (isNeedBasedAccessRequestMessage(message)) {
      return this.acceptNeedBasedAccessRequest(message, credentials)
    }
    if (!isAccessRequestMessage(message)) {
      throw new BadRequestHttpError('invalid delegation message')
    }
    return this.issue(message, credentials, operation)
  }

  private async acceptNeedBasedAccessRequest(
    message: NeedBasedAccessRequestMessage,
    credentials: Awaited<ReturnType<CredentialsExtractor['handleSafe']>>
  ): Promise<ResponseDescription> {
    // the client-is-requester's-UAS check ran at the top of handle (403);
    // self-requests only — grantee === grantedBy === the authenticated agent
    if (message.grantedBy !== message.grantee || message.grantedBy !== credentials.agent.webId) {
      throw new BadRequestHttpError('invalid grantedBy/grantee')
    }
    // the requester must be registered with the data owner (403)
    const sai = await this.sessionManager.getSession(message.dataOwner)
    const registration = await sai.findSocialAgentRegistration(credentials.agent.webId)
    if (!registration) {
      throw new ForbiddenHttpError('agent is not registered with the data owner')
    }
    // the received half (authorization-granting.md §6.2): pre-mint the
    // request id in the OWNER's AccessRequestRegistry and write the
    // `NeedBasedAccessRequestReceived` activity (real-id embedded projection
    // at the minted id, `target` = the registry) — the owner-side workflow
    // PUTs the AccessRequest resource there (find-first idempotent). The 202
    // is sent IMMEDIATELY — it awaits nothing beyond the activity write.
    const requestRegistry = sai.registrySet.hasAccessRequestRegistry
    if (!requestRegistry) throw new Error('access-request registry not found in registry set')
    const requestId = iriForContained(requestRegistry, sai.randomUUID)
    const activityRegistry = sai.registrySet.hasActivityRegistry
    if (!activityRegistry) throw new Error('activity registry not found in registry set')
    const object: EmbeddedNeedBasedAccessRequest = {
      id: requestId,
      type: [INTEROP.NeedBasedAccessRequest],
      grantee: message.grantee,
      grantedBy: message.grantedBy,
      dataOwner: message.dataOwner,
      hasAccessNeedGroup: message.hasAccessNeedGroup,
    }
    const activity: Omit<NeedBasedAccessRequestReceived, 'id'> = {
      type: ['Activity', 'NeedBasedAccessRequestReceived'],
      actor: sai.webId,
      target: requestRegistry.id,
      object,
      createdAt: new Date().toISOString(),
    }
    await ActivityRegistry.createActivity(
      activityRegistry,
      { fetch: sai.fetch, randomUUID: sai.randomUUID },
      activity
    )
    return new ResponseDescription(202)
  }

  private async issue(
    message: AccessRequestMessage,
    credentials: Awaited<ReturnType<CredentialsExtractor['handleSafe']>>,
    operation: OperationHttpHandlerInput['operation']
  ): Promise<ResponseDescription> {
    const { grants } = message
    if (grants.length === 0) {
      throw new BadRequestHttpError('AccessRequest requires at least one grant')
    }
    // all-or-nothing: the whole request must share one data owner (the owner
    // of the endpoint's registry)
    const dataOwners = new Set(grants.map((grant) => grant.dataOwner))
    if (dataOwners.size !== 1) {
      throw new BadRequestHttpError('all grants must have the same dataOwner')
    }
    const dataOwner = [...dataOwners][0]
    const sai = await this.sessionManager.getSession(dataOwner)

    // TODO: support recursive inheritance
    // Incoming payload embeds child grant data (one level). Assign IRIs and
    // build FinalGrantData for each parent and its inheriting children.
    const finalGrants: FinalGrantData[] = []
    for (const topGrant of grants) {
      const grantId = iriForContained(sai.registrySet.hasGrantRegistry, sai.randomUUID)
      const inheritingGrants = (topGrant.hasInheritingGrant ?? []).map((childData) =>
        this.buildInheritingGrant(sai, childData, grantId)
      )
      finalGrants.push(
        {
          ...topGrant,
          type: topGrant.type ?? [INTEROP.DataGrant],
          id: grantId,
          hasInheritingGrant: inheritingGrants.map((grant) => grant.id!),
        },
        ...inheritingGrants
      )
    }

    // all-or-nothing: validate every grant in the request before any is stored
    for (const grant of finalGrants) {
      await this.validateDelegable(grant, credentials.agent.webId)
    }

    const temporal = new Temporal()
    await temporal.init()
    // TODO: we could use start but it could lead to race conditions
    await temporal.client.workflow.execute(storeGrant, {
      taskQueue: 'create-grants',
      args: [finalGrants],
      workflowId: crypto.randomUUID(),
    })
    // echo the finalised grants (not just their ids): the grantor stores them
    // as the issuer-side replica `checkEquivalence` reads
    // (docs/plans/check-equivalence.md §2.1)
    const doc = JSON.stringify(finalGrants)
    const representation = new BasicRepresentation(doc, operation.target, APPLICATION_JSON)
    return new OkResponseDescription(representation.metadata, representation.data)
  }

  /**
   * Parse the request body as JSON. The delegation endpoint dispatches on the
   * message `type` (AccessRequest → issuance, AccessRevocation → revocation).
   */
  private async parseMessage(operation: OperationHttpHandlerInput['operation']): Promise<unknown> {
    let message: unknown
    try {
      message = JSON.parse(await readableToString(operation.body.data))
    } catch (err) {
      throw new BadRequestHttpError(err.message)
    }
    return message
  }

  private buildInheritingGrant(
    sai: Awaited<ReturnType<SessionManager['getSession']>>,
    childData: IncomingGrantData,
    inheritsFromGrant: string
  ): FinalGrantData {
    return {
      type: childData.type ?? [INTEROP.DataGrant],
      grantee: childData.grantee,
      grantedBy: childData.grantedBy,
      dataOwner: childData.dataOwner,
      registeredShapeTree: childData.registeredShapeTree,
      hasDataRegistration: childData.hasDataRegistration,
      hasStorage: childData.hasStorage,
      scopeOfGrant: childData.scopeOfGrant,
      accessMode: childData.accessMode,
      creatorAccessMode: childData.creatorAccessMode,
      hasDataInstance: childData.hasDataInstance,
      id: iriForContained(sai.registrySet.hasGrantRegistry, sai.randomUUID),
      inheritsFromGrant,
    }
  }

  /**
   * Validate that one grant can be delegated: the requester is its
   * `grantedBy`, and an upstream grant covering it exists in the data owner's
   * registry (the query lives in the AA's `sparql.ts`).
   */
  private async validateDelegable(grant: FinalGrantData, requesterWebId: string): Promise<void> {
    if (requesterWebId !== grant.grantedBy) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('invalid grantedBy')
    }
    // the delegable grant lives in the data owner's registry pod — resolve it
    // from the grant IRI (fail closed when there is no record)
    const record = await this.endpointStore.findSparqlByIri(grant.id!)
    if (!record) throw new Error(`no SPARQL endpoint for grant ${grant.id}`)
    if (!(await findDelegableGrant(localSparqlTransport(record.endpoint), grant))) {
      // TODO: change to UnprocessableEntityHttpError
      throw new BadRequestHttpError('no grant available for delegation')
    }
  }
}
