import type { DatasetCore, Quad } from '@rdfjs/types'
import { Store } from 'n3'

import { jsonld } from './jsonld-lib.ts'
import { lwsV1Context } from './lws-v1-context.ts'
import { odrlContext } from './odrl-context.ts'
import { ODRL_ID_JAG_CONTEXT, odrlIdJagContext } from './odrl-id-jag-context.ts'
import { saiContext } from './sai-context.ts'

// Local type for the document loader result compatible with jsonld's RemoteDocument
interface RemoteDocument {
  contextUrl?: string | null
  document: unknown
  documentUrl: string
}

/**
 * Wrapper around jsonld.toRDF to parse JSON-LD text into an N3 Store.
 * @param text Text to parse (JSON-LD)
 * @param source Base IRI
 */
export const parseJsonld = async (text: string, source = ''): Promise<DatasetCore> => {
  const doc = JSON.parse(text)
  const dataset = await jsonld.toRDF(doc, {
    base: source || undefined,
    documentLoader: localDocumentLoader as any,
  })
  const store = new Store()
  for (const quad of dataset as unknown as Iterable<Quad>) {
    store.add(quad)
  }
  return store
}

export async function localDocumentLoader(url: string): Promise<RemoteDocument> {
  if (url in localContexts) {
    return {
      contextUrl: null,
      document: localContexts[url],
      documentUrl: url,
    }
  }
  const response = await fetch(url)
  const document = await response.json()
  return {
    contextUrl: null,
    document,
    documentUrl: url,
  }
}

type LocalContext = Record<string, unknown> & { '@context'?: unknown }

const localContexts: Record<string, LocalContext> = {
  'https://www.w3.org/ns/lws/v1': lwsV1Context,
  'http://www.w3.org/ns/odrl.jsonld': odrlContext,
  'https://www.w3.org/ns/solid/interop-context/v1': saiContext,
  [ODRL_ID_JAG_CONTEXT]: odrlIdJagContext,
  'https://www.w3.org/ns/solid/oidc-context.jsonld': {
    '@context': {
      '@version': 1.1,
      '@protected': true,
      oidc: 'http://www.w3.org/ns/solid/oidc#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      client_id: {
        '@id': '@id',
        '@type': '@id',
      },
      client_uri: {
        '@id': 'oidc:client_uri',
        '@type': '@id',
      },
      logo_uri: {
        '@id': 'oidc:logo_uri',
        '@type': '@id',
      },
      policy_uri: {
        '@id': 'oidc:policy_uri',
        '@type': '@id',
      },
      tos_uri: {
        '@id': 'oidc:tos_uri',
        '@type': '@id',
      },
      redirect_uris: {
        '@id': 'oidc:redirect_uris',
        '@type': '@id',
        '@container': ['@id', '@set'],
      },
      require_auth_time: {
        '@id': 'oidc:require_auth_time',
        '@type': 'xsd:boolean',
      },
      default_max_age: {
        '@id': 'oidc:default_max_age',
        '@type': 'xsd:integer',
      },
      application_type: {
        '@id': 'oidc:application_type',
      },
      client_name: {
        '@id': 'oidc:client_name',
      },
      contacts: {
        '@id': 'oidc:contacts',
      },
      grant_types: {
        '@id': 'oidc:grant_types',
      },
      response_types: {
        '@id': 'oidc:response_types',
      },
      scope: {
        '@id': 'oidc:scope',
      },
      token_endpoint_auth_method: {
        '@id': 'oidc:token_endpoint_auth_method',
      },
    },
  },
  'https://www.w3.org/ns/solid/notifications-context/v1': {
    '@context': {
      '@version': 1.1,
      '@protected': true,
      id: '@id',
      type: '@type',
      notify: 'http://www.w3.org/ns/solid/notifications#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      EventSourceChannel2023: 'notify:EventSourceChannel2023',
      LDNChannel2023: 'notify:LDNChannel2023',
      StreamingHTTPChannel2023: 'notify:StreamingHTTPChannel2023',
      WebhookChannel2023: 'notify:WebhookChannel2023',
      WebSocketChannel2023: 'notify:WebSocketChannel2023',
      accept: 'notify:accept',
      channel: {
        '@id': 'notify:channel',
        '@type': '@id',
      },
      channelType: {
        '@id': 'notify:channelType',
        '@type': '@vocab',
      },
      endAt: {
        '@id': 'notify:endAt',
        '@type': 'xsd:dateTime',
      },
      feature: {
        '@id': 'notify:feature',
        '@type': '@vocab',
      },
      rate: {
        '@id': 'notify:rate',
        '@type': 'xsd:duration',
      },
      receiveFrom: {
        '@id': 'notify:receiveFrom',
        '@type': '@id',
      },
      sender: {
        '@id': 'notify:sender',
        '@type': '@id',
      },
      sendTo: {
        '@id': 'notify:sendTo',
        '@type': '@id',
      },
      state: 'notify:state',
      startAt: {
        '@id': 'notify:startAt',
        '@type': 'xsd:dateTime',
      },
      subscription: {
        '@id': 'notify:subscription',
        '@type': '@id',
      },
      topic: {
        '@id': 'notify:topic',
        '@type': '@id',
      },
    },
  },
  'https://www.w3.org/ns/cid/v1': {
    '@context': {
      '@version': 1.1,
      '@protected': true,
      id: '@id',
      type: '@type',
      alsoKnownAs: {
        '@id': 'https://www.w3.org/ns/activitystreams#alsoKnownAs',
        '@type': '@id',
      },
      assertionMethod: {
        '@id': 'https://w3id.org/security#assertionMethod',
        '@type': '@id',
        '@container': '@set',
      },
      authentication: {
        '@id': 'https://w3id.org/security#authenticationMethod',
        '@type': '@id',
        '@container': '@set',
      },
      capabilityDelegation: {
        '@id': 'https://w3id.org/security#capabilityDelegationMethod',
        '@type': '@id',
        '@container': '@set',
      },
      capabilityInvocation: {
        '@id': 'https://w3id.org/security#capabilityInvocationMethod',
        '@type': '@id',
        '@container': '@set',
      },
      controller: {
        '@id': 'https://w3id.org/security#controller',
        '@type': '@id',
      },
      keyAgreement: {
        '@id': 'https://w3id.org/security#keyAgreementMethod',
        '@type': '@id',
        '@container': '@set',
      },
      service: {
        '@id': 'https://www.w3.org/ns/did#service',
        '@type': '@id',
        '@context': {
          '@protected': true,
          id: '@id',
          type: '@type',
          serviceEndpoint: {
            '@id': 'https://www.w3.org/ns/did#serviceEndpoint',
            '@type': '@id',
          },
        },
      },
      verificationMethod: {
        '@id': 'https://w3id.org/security#verificationMethod',
        '@type': '@id',
      },
      Multikey: {
        '@id': 'https://w3id.org/security#Multikey',
        '@context': {
          '@protected': true,
          id: '@id',
          type: '@type',
          controller: {
            '@id': 'https://w3id.org/security#controller',
            '@type': '@id',
          },
          revoked: {
            '@id': 'https://w3id.org/security#revoked',
            '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
          },
          expires: {
            '@id': 'https://w3id.org/security#expiration',
            '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
          },
          publicKeyMultibase: {
            '@id': 'https://w3id.org/security#publicKeyMultibase',
            '@type': 'https://w3id.org/security#multibase',
          },
          secretKeyMultibase: {
            '@id': 'https://w3id.org/security#secretKeyMultibase',
            '@type': 'https://w3id.org/security#multibase',
          },
        },
      },
      JsonWebKey: {
        '@id': 'https://w3id.org/security#JsonWebKey',
        '@context': {
          '@protected': true,
          id: '@id',
          type: '@type',
          controller: {
            '@id': 'https://w3id.org/security#controller',
            '@type': '@id',
          },
          revoked: {
            '@id': 'https://w3id.org/security#revoked',
            '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
          },
          expires: {
            '@id': 'https://w3id.org/security#expiration',
            '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
          },
          publicKeyJwk: {
            '@id': 'https://w3id.org/security#publicKeyJwk',
            '@type': '@json',
          },
          secretKeyJwk: {
            '@id': 'https://w3id.org/security#secretKeyJwk',
            '@type': '@json',
          },
        },
      },
    },
  },
}
