import { PassThrough } from 'node:stream'

import {
  BasicRepresentation,
  IdentifierSetMultiMap,
  NOTIFY,
  NotificationSerializer,
  OkResponseDescription,
  OperationHttpHandler,
  createErrorMessage,
  guardStream,
  readableToString,
} from '@solid/community-server'
import type {
  Authorizer,
  Credentials,
  CredentialsExtractor,
  InteractionRoute,
  NotificationChannel,
  NotificationGenerator,
  OperationHttpHandlerInput,
  PermissionReader,
  ResponseDescription,
  StreamingHttpMap,
} from '@solid/community-server'
import { PERMISSIONS } from '@solidlab/policy-engine'
import { getLoggerFor } from 'global-logger-factory'

/** Media type of the NDJSON notification streams (one expanded JSON-LD object per line). */
export const NDJSON_MEDIA_TYPE = 'application/x-ndjson'

const AS = 'https://www.w3.org/ns/activitystreams#'
const NOTIFY_NS = 'http://www.w3.org/ns/solid/notifications#'
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime'

/**
 * The compacted `Notification` object CSS's generators emit
 * (`@context: [activitystreams, notification/v1]`).
 */
export interface CompactedNotification {
  id: string
  type: string
  object: string
  state?: string
  target?: string | string[]
  published: string
}

/**
 * Expand a CSS notification object into JSON-LD with **pinned IRIs**. The
 * `https://www.w3.org/ns/solid/notification/v1` context is not publicly
 * resolvable, so `jsonld.expand` is not viable; the IRIs come from CSS's
 * vendored `templates/contexts/{notification,activitystreams}.jsonld`:
 * `type` → `as:<Type>`, `object`/`target` → `as:{object,target}` node refs,
 * `published` → `as:published` `xsd:dateTime`, `state` → `notify:state`.
 */
export function expandNotification(notification: CompactedNotification): Record<string, unknown>[] {
  const node: Record<string, unknown> = {
    '@id': notification.id,
    '@type': [`${AS}${notification.type}`],
  }
  if (notification.object) {
    node[`${AS}object`] = [{ '@id': notification.object }]
  }
  if (notification.target) {
    const targets = Array.isArray(notification.target) ? notification.target : [notification.target]
    node[`${AS}target`] = targets.map((target) => ({ '@id': target }))
  }
  if (notification.published) {
    node[`${AS}published`] = [{ '@type': XSD_DATETIME, '@value': notification.published }]
  }
  if (notification.state) {
    node[`${NOTIFY_NS}state`] = [{ '@value': notification.state }]
  }
  return [node]
}

/**
 * Serializes a notification as a single NDJSON line of expanded JSON-LD.
 * Replaces CSS's `ConvertingNotificationSerializer` (its RepresentationConverter
 * has no NDJSON target) and ignores `channel.accept` — the format is always
 * NDJSON.
 */
export class NdjsonNotificationSerializer extends NotificationSerializer {
  public async handle({
    notification,
  }: {
    notification: CompactedNotification
  }): Promise<BasicRepresentation> {
    return new BasicRepresentation(
      `${JSON.stringify(expandNotification(notification))}\n`,
      NDJSON_MEDIA_TYPE
    )
  }
}

/**
 * Streaming HTTP request handler that advertises `application/x-ndjson`.
 * Reimplements CSS's `StreamingHttpRequestHandler` — its `generateChannel`
 * hardcodes `accept: 'text/turtle'` and is a plain function, not injectable —
 * keeping the same credentials/permission/authorizer flow.
 */
export class NdjsonStreamingHttpRequestHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this)

  public constructor(
    private readonly streamMap: StreamingHttpMap,
    private readonly route: InteractionRoute,
    private readonly generator: NotificationGenerator,
    private readonly serializer: NotificationSerializer,
    private readonly credentialsExtractor: CredentialsExtractor,
    private readonly permissionReader: PermissionReader,
    private readonly authorizer: Authorizer
  ) {
    super()
  }

  public async handle({
    operation,
    request,
  }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const encodedUrl = operation.target.path.replace(this.route.getPath(), '')
    const topic = decodeURIComponent(encodedUrl)

    // Verify if the client is allowed to connect
    const credentials = await this.credentialsExtractor.handleSafe(request)
    await this.authorize(credentials, topic)

    const stream = guardStream(new PassThrough())
    this.streamMap.add(topic, stream)
    stream.on('error', () => this.streamMap.deleteEntry(topic, stream))
    stream.on('close', () => this.streamMap.deleteEntry(topic, stream))

    const channel: NotificationChannel = {
      id: `${topic}.channel`,
      type: NOTIFY.StreamingHTTPChannel2023,
      topic,
      accept: NDJSON_MEDIA_TYPE,
    }

    // Send the initial notification
    try {
      const notification = await this.generator.handle({ channel, topic: { path: topic } })
      const representation = await this.serializer.handleSafe({ channel, notification })
      stream.write(await readableToString(representation.data))
    } catch (error) {
      this.logger.error(`Problem emitting initial notification: ${createErrorMessage(error)}`)
    }

    const representation = new BasicRepresentation(topic, operation.target, NDJSON_MEDIA_TYPE)
    return new OkResponseDescription(representation.metadata, stream)
  }

  private async authorize(credentials: Credentials, topic: string): Promise<void> {
    const requestedModes = new IdentifierSetMultiMap([[{ path: topic }, PERMISSIONS.Read]])
    const availablePermissions = await this.permissionReader.handleSafe({
      credentials,
      requestedModes,
    })
    await this.authorizer.handleSafe({ credentials, requestedModes, availablePermissions })
  }
}
