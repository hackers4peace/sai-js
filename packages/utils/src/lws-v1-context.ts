/**
 * Bundled copy of the LWS v1 JSON-LD context (`https://www.w3.org/ns/lws/v1`).
 *
 * Source: `lws-test-suite/lws-v1.context.json` (generated from
 * `w3c/lws-protocol/lws10-vocab/vocabulary.yml`). The context is not published
 * upstream yet, so SAI must resolve it locally — never over the network.
 *
 * Local fixes pending an upstream PR:
 * - `odrl:assignee` is coerced to `@type: @id` (otherwise the agent is stored
 *   as an RDF literal, breaking SPARQL joins and IRI comparisons).
 * - `odrl:target` gets a scoped context defining `value` as `lws:value`
 *   (`@type: @id`, `@container: @set`); the upstream context drops the target
 *   value array entirely during JSON-LD expansion.
 * - `storage` is defined at the top level (the upstream context only scopes it
 *   inside `AccessRequest`/`AccessGrant`); permission targets need the
 *   top-level term.
 * - the top-level `@protected` is removed so the LWS, ODRL, and SAI contexts
 *   can be composed in one document; nested scoped contexts stay protected.
 * - `AccessGrant`/`AccessRequest` scoped contexts declare `@container: '@set'`
 *   on `type` and `access`: a type-scoped context wins over the composed
 *   top-level definitions, so without them a grant frames with a scalar
 *   `type` and an object `access` instead of arrays.
 */
export const lwsV1Context = {
  '@context': {
    id: '@id',
    type: '@type',
    StorageResource: 'https://www.w3.org/ns/lws#StorageResource',
    Container: {
      '@id': 'https://www.w3.org/ns/lws#Container',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        items: 'https://www.w3.org/ns/lws#items',
        totalItems: 'https://www.w3.org/ns/lws#totalItems',
      },
    },
    DataResource: {
      '@id': 'https://www.w3.org/ns/lws#DataResource',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        format: 'http://purl.org/dc/terms/format',
        modified: {
          '@id': 'http://purl.org/dc/terms/modified',
          '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
        size: {
          '@id': 'http://schema.org/size',
          '@type': 'http://www.w3.org/2001/XMLSchema#long',
        },
      },
    },
    Storage: {
      '@id': 'https://www.w3.org/ns/lws#Storage',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        capability: 'https://www.w3.org/ns/lws#capability',
      },
    },
    StorageRoot: 'https://www.w3.org/ns/lws#StorageRoot',
    OpenIdProvider: 'https://www.w3.org/ns/lws#OpenIdProvider',
    Notification: {
      '@id': 'https://www.w3.org/ns/lws#Notification',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        activity: {
          '@id': 'https://www.w3.org/ns/lws#activity',
          '@context': {
            '@protected': true,
            id: '@id',
            type: '@type',
            object: {
              '@id': 'https://www.w3.org/ns/activitystreams#object',
              '@type': '@id',
            },
            actor: {
              '@id': 'https://www.w3.org/ns/activitystreams#actor',
              '@type': '@id',
            },
            target: {
              '@id': 'https://www.w3.org/ns/activitystreams#target',
              '@type': '@id',
            },
            origin: {
              '@id': 'https://www.w3.org/ns/activitystreams#origin',
              '@type': '@id',
            },
            published: {
              '@id': 'https://www.w3.org/ns/activitystreams#published',
              '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
            },
          },
        },
        storage: {
          '@id': 'https://www.w3.org/ns/lws#storage',
          '@type': '@id',
        },
      },
    },
    NotificationService: {
      '@id': 'https://www.w3.org/ns/lws#NotificationService',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        subscriptionType: 'https://www.w3.org/ns/lws#subscriptionType',
      },
    },
    WebhookSubscription: {
      '@id': 'https://www.w3.org/ns/lws#WebhookSubscription',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        subscription: {
          '@id': 'https://www.w3.org/ns/lws#subscription',
          '@type': '@id',
        },
        expires: {
          '@id': 'http://schema.org/expires',
          '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
      },
    },
    AccessProfile: 'https://www.w3.org/ns/lws#AccessProfile',
    AccessPolicy: {
      '@id': 'https://www.w3.org/ns/lws#AccessPolicy',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        action: {
          '@id': 'http://www.w3.org/ns/odrl/2/action',
          '@type': '@vocab',
          '@context': {
            read: 'http://www.w3.org/ns/odrl/2/read',
            modify: 'http://www.w3.org/ns/odrl/2/modify',
            delete: 'http://www.w3.org/ns/odrl/2/delete',
            create: 'https://www.w3.org/ns/lws#create',
            '@vocab': 'lws:INVALID_VALUE:',
          },
        },
        assignee: {
          '@id': 'http://www.w3.org/ns/odrl/2/assignee',
          '@type': '@id',
        },
        target: {
          '@id': 'http://www.w3.org/ns/odrl/2/target',
          '@context': {
            '@protected': true,
            id: '@id',
            type: '@type',
            value: {
              '@id': 'https://www.w3.org/ns/lws#value',
              '@type': '@id',
              '@container': '@set',
            },
          },
        },
        constraint: 'http://www.w3.org/ns/odrl/2/constraint',
        leftOperand: {
          '@id': 'http://www.w3.org/ns/odrl/2/leftOperand',
          '@type': '@vocab',
          '@context': {
            purpose: 'http://www.w3.org/ns/odrl/2/purpose',
            dateTime: 'http://www.w3.org/ns/odrl/2/dateTime',
            client: 'https://www.w3.org/ns/lws#client',
            type: 'http://purl.org/dc/terms/type',
            format: 'http://purl.org/dc/terms/format',
            '@vocab': 'lws:INVALID_VALUE:',
          },
        },
        operator: {
          '@id': 'http://www.w3.org/ns/odrl/2/operator',
          '@type': '@vocab',
          '@context': {
            eq: 'http://www.w3.org/ns/odrl/2/eq',
            neq: 'http://www.w3.org/ns/odrl/2/neq',
            lt: 'http://www.w3.org/ns/odrl/2/lt',
            gt: 'http://www.w3.org/ns/odrl/2/gt',
            lteq: 'http://www.w3.org/ns/odrl/2/lteq',
            gteq: 'http://www.w3.org/ns/odrl/2/gteq',
            isAnyOf: 'http://www.w3.org/ns/odrl/2/isAnyOf',
            isAllOf: 'http://www.w3.org/ns/odrl/2/isAllOf',
            isNoneOf: 'http://www.w3.org/ns/odrl/2/isNoneOf',
            '@vocab': 'lws:INVALID_VALUE:',
          },
        },
        rightOperand: 'http://www.w3.org/ns/odrl/2/rightOperand',
      },
    },
    AccessGrant: {
      '@id': 'https://www.w3.org/ns/lws#AccessGrant',
      '@context': {
        '@protected': true,
        id: '@id',
        type: { '@id': '@type', '@container': '@set' },
        storage: {
          '@id': 'https://www.w3.org/ns/lws#storage',
          '@type': '@id',
        },
        inbox: {
          '@id': 'http://www.w3.org/ns/ldp#inbox',
          '@type': '@id',
        },
        access: {
          '@id': 'https://www.w3.org/ns/lws#access',
          '@container': '@set',
        },
      },
    },
    AccessGrantService: 'https://www.w3.org/ns/lws#AccessGrantService',
    AccessRequest: {
      '@id': 'https://www.w3.org/ns/lws#AccessRequest',
      '@context': {
        '@protected': true,
        id: '@id',
        type: { '@id': '@type', '@container': '@set' },
        storage: {
          '@id': 'https://www.w3.org/ns/lws#storage',
          '@type': '@id',
        },
        inbox: {
          '@id': 'http://www.w3.org/ns/ldp#inbox',
          '@type': '@id',
        },
        access: {
          '@id': 'https://www.w3.org/ns/lws#access',
          '@container': '@set',
        },
      },
    },
    AccessRequestService: 'https://www.w3.org/ns/lws#AccessRequestService',
    storage: {
      '@id': 'https://www.w3.org/ns/lws#storage',
      '@type': '@id',
    },
    Create: 'https://www.w3.org/ns/activitystreams#Create',
    Update: 'https://www.w3.org/ns/activitystreams#Update',
    Delete: 'https://www.w3.org/ns/activitystreams#Delete',
    PreferLinkRelations: 'https://www.w3.org/ns/lws#PreferLinkRelations',
    topic: {
      '@id': 'https://www.w3.org/ns/lws#topic',
      '@type': '@id',
    },
    conformsTo: 'http://purl.org/dc/terms/conformsTo',
    create: 'https://www.w3.org/ns/lws#create',
    client: 'https://www.w3.org/ns/lws#client',
    TypeIndexService: 'https://www.w3.org/ns/lws#TypeIndexService',
    TypeSearchService: 'https://www.w3.org/ns/lws#TypeSearchService',
  },
}
