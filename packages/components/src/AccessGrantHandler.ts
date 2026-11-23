import {
  getRegistryGrants,
  localSparqlTransport,
} from '@janeirodigital/interop-authorization-agent'
import { grantGrantee, grantAssigner, toJsonLd } from '@janeirodigital/interop-data-model'
import type { FinalGrantData } from '@janeirodigital/interop-data-model'
import { discoverAuthorizationAgent } from '@janeirodigital/interop-utils'
import {
  APPLICATION_LWS_JSON,
  BadRequestHttpError,
  BasicRepresentation,
  InternalServerError,
  MethodNotAllowedHttpError,
  OkResponseDescription,
  OperationHttpHandler,
  ResponseDescription,
  UnauthorizedHttpError,
} from '@solid/community-server'
import type { CredentialsExtractor, OperationHttpHandlerInput } from '@solid/community-server'
import { getLoggerFor } from 'global-logger-factory'

import type { SessionManager } from './SessionManager.js'

const ENDPOINT_PREFIX = '/.sai/grants/'

type Credentials = Awaited<ReturnType<CredentialsExtractor['handleSafe']>>

/**
 * Read-only owner-scoped access grant view:
 * `/.sai/grants/<base64url(owner)>`.
 *
 * The owner is the assigner/data owner whose grant registry is read. Mirrored
 * peer grants are not included:
 *
 * - authorization-agent/UAS clients see every grant in that registry where the
 *   authenticated user is the assignee or assigner;
 * - any other client sees only grants whose assignee is that client and whose
 *   assigner is the authenticated user.
 *
 * Only grants issued by the registry owner's agent are exposed. Delegated
 * grants in this registry remain visible even though their `target.owner` is a
 * peer.
 *
 * No POST/PUT/DELETE: grant creation and deletion remain owner-workflow
 * operations. A role grant is already materialized per member, so this handler
 * never expands roles.
 */
export class AccessGrantHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)

  public constructor(
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly sessionManager: SessionManager
  ) {
    super()
  }

  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    if (operation.method !== 'GET' && operation.method !== 'HEAD') {
      throw new MethodNotAllowedHttpError(['GET', 'HEAD'])
    }
    const owner = parseOwner(operation.target.path)
    const credentials = await this.credentialsExtractor.handleSafe(request)
    if (!credentials.agent?.webId) {
      throw new UnauthorizedHttpError()
    }

    const sai = await this.sessionManager.getSession(owner)
    const registry = sai.registrySet.hasGrantRegistry
    if (!registry) {
      throw new InternalServerError('grant registry not found in registry set')
    }

    const grants = await getRegistryGrants(localSparqlTransport(sai.sparqlEndpoint), registry.id)
    const isUas = await this.isAuthorizationAgent(credentials)
    const visible = grants.filter((grant) => {
      // Only grants issued by the registry owner. Never expose a
      // peer-owned/mirrored grant through this view.
      if (grantAssigner(grant) !== owner) {
        return false
      }
      if (isUas) {
        return (
          grantGrantee(grant) === credentials.agent.webId ||
          grantAssigner(grant) === credentials.agent.webId
        )
      }
      return (
        grantGrantee(grant) === credentials.client?.clientId &&
        grantAssigner(grant) === credentials.agent.webId
      )
    })

    const documents = visible
      .filter((grant): grant is FinalGrantData => Boolean(grant.id))
      .map((grant) => toJsonLd(grant))
    const representation = new BasicRepresentation(
      JSON.stringify(documents),
      operation.target,
      APPLICATION_LWS_JSON
    )
    if (operation.method === 'HEAD') {
      return new ResponseDescription(200, representation.metadata)
    }
    return new OkResponseDescription(representation.metadata, representation.data)
  }

  private async isAuthorizationAgent(credentials: Credentials): Promise<boolean> {
    const client = credentials.client?.clientId
    if (!client) {
      return false
    }
    try {
      return (await discoverAuthorizationAgent(credentials.agent.webId, fetch)) === client
    } catch {
      return false
    }
  }
}

function parseOwner(path: string): string {
  let pathname: string
  try {
    pathname = /^[a-z][a-z\d+.-]*:/iu.test(path) ? new URL(path).pathname : path
  } catch {
    throw new BadRequestHttpError('invalid access grant endpoint')
  }
  if (!pathname.startsWith(ENDPOINT_PREFIX)) {
    throw new BadRequestHttpError('invalid access grant endpoint')
  }
  const [encodedOwner, ...tail] = pathname.slice(ENDPOINT_PREFIX.length).split('/')
  if (!encodedOwner || tail.some((segment) => segment.length > 0)) {
    throw new BadRequestHttpError('invalid access grant endpoint')
  }
  try {
    const owner = Buffer.from(decodeURIComponent(encodedOwner), 'base64url').toString('utf8')
    const url = new URL(owner)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported owner scheme')
    }
    return owner
  } catch {
    throw new BadRequestHttpError('invalid access grant owner')
  }
}
