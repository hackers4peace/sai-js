import { createVocabulary } from 'rdf-vocabulary'

export const INTEROP = createVocabulary(
  'http://www.w3.org/ns/solid/interop#',
  'accessMode',
  'AccessNeed',
  'AccessNeedDescription',
  'AccessNeedGroup',
  'AccessNeedGroupDescription',
  'AccessRequest',
  'AccessRequestArchived',
  'AccessRequestGranted',
  'AccessRequestRegistry',
  'AccessOptional',
  'AccessProfile',
  'AccessRequired',
  'accessNecessity',
  'Activity',
  'ActivityCompleted',
  'ActivityRegistry',
  'AdminAuthorization',
  'AdminAuthorizationGranted',
  'AdminAuthorizationRevoked',
  'AdminGrant',
  'AgentRegistrationAdded',
  'All',
  'AllFromAgent',
  'AllFromRegistry',
  'AllFromRole',
  'Application',
  'ApplicationRegistration',
  'ApplicationRegistry',
  'AuthorizationAgent',
  'AuthorizationDenied',
  'AuthorizationGranted',
  'AuthorizationRegistry',
  'AuthorizationRevoked',
  'AuthorizationStructure',
  'createdAt',
  'DataAuthorization',
  'dataOwner',
  'DataRegistration',
  'DataRegistry',
  'DelegatedGrantsUpdated',
  'delegationOfGrant',
  'grantedBy',
  'grantee',
  'grants',
  'GrantRegistry',
  'hasAccessAuthorization',
  'hasAccessDescriptionSet',
  'hasAccessNeed',
  'hasAccessNeedGroup',
  'hasAdminGrant',
  'hasApplicationRegistry',
  'hasAccessRequestRegistry',
  'hasAuthorizationAgent',
  'hasAuthorizationCallbackEndpoint',
  'hasAuthorizationRedirectEndpoint',
  'hasAuthorizationRegistry',
  'hasCapabilityUrl',
  'hasDataGrant',
  'hasDataInstance',
  'hasDataRegistration',
  'hasDataRegistry',
  'hasGrantRegistry',
  'hasInvitationRegistry',
  'hasMember',
  'hasRegistrySet',
  'hasRoleRegistry',
  'hasActivityRegistry',
  'hasStorage',
  'inAccessDescriptionSet',
  'hasSocialAgentRegistry',
  'Inherited',
  'inheritsFromAuthorization',
  'inheritsFromGrant',
  'inheritsFromNeed',
  'InvitationAccepted',
  'InvitationCreated',
  'InvitationRegistry',
  'NeedBasedAccessRequest',
  'NeedBasedAccessRequestReceived',
  'NeedBasedAccessRequestSent',
  'pushService',
  'reciprocalRegistration',
  'registeredAgent',
  'registeredAt',
  'registeredBy',
  'registeredShapeTree',
  'registeredWith',
  'requester',
  'RegistrySet',
  'Role',
  'RoleDeleted',
  'RoleMembershipChanged',
  'RoleCreated',
  'RoleRegistry',
  'satisfiesAccessNeed',
  'satisfiesAccessRequest',
  'scopeOfAdminGrant',
  'scopeOfAuthorization',
  'scopeOfGrant',
  'SelectedFromRegistry',
  'SocialAgent',
  'SocialAgentInvitation',
  'SocialAgentRegistration',
  'SocialAgentRegistry',
  'status',
  'target',
  'updatedAt',
  'usesLanguage'
)

export const NOTIFY = createVocabulary(
  'http://www.w3.org/ns/solid/notifications#',
  'vapidPublicKey',
  // notification channel terms (subscription + storage description)
  'topic',
  'sendTo',
  'channelType',
  'feature',
  'receiveFrom',
  'subscription',
  'accept',
  'endAt',
  'rate',
  'startAt',
  'state'
)

export const RDF = createVocabulary('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'type')

export const RDFS = createVocabulary('http://www.w3.org/2000/01/rdf-schema#', 'label')

export const LDP = createVocabulary(
  'http://www.w3.org/ns/ldp#',
  'contains',
  'Container',
  'BasicContainer',
  'Resource'
)

/**
 * Linked Web Storage vocabulary. Flat storage keeps containment in metadata:
 * `lws:contains` on the container and `lws:partOf` on the child, independent
 * of the URI path (https://www.w3.org/ns/lws#).
 */
export const LWS = createVocabulary(
  'https://www.w3.org/ns/lws#',
  'access',
  'AccessGrant',
  'AccessGrantService',
  'AccessPolicy',
  'AccessProfile',
  'AccessRequest',
  'AccessRequestService',
  'contains',
  'create',
  'partOf',
  'storage',
  'value',
  'Container',
  'DataResource',
  'Storage',
  'StorageResource'
)

/**
 * ODRL 2 terms used by LWS access policies (action vocabulary + policy shape).
 * The canonical SAI access actions reuse these IRIs — see `ACCESS_ACTIONS`.
 */
export const ODRL = createVocabulary(
  'http://www.w3.org/ns/odrl/2/',
  'action',
  'Agreement',
  'Asset',
  'AssetCollection',
  'assignee',
  'assigner',
  'constraint',
  'dateTime',
  'delete',
  'eq',
  'gt',
  'gteq',
  'isAllOf',
  'isAnyOf',
  'isNoneOf',
  'leftOperand',
  'lt',
  'lteq',
  'modify',
  'neq',
  'operator',
  'partOf',
  'permission',
  'profile',
  'purpose',
  'read',
  'Request',
  'rightOperand',
  'source',
  'target',
  'uid'
)

/**
 * The canonical SAI access actions (LWS Access Profile vocabulary):
 * `odrl:read`, `odrl:modify`, `lws:create`, `odrl:delete`.
 *
 * These are the only values allowed in `interop:accessMode` — ACL terms are
 * kept for ACR/ACP metadata only.
 */
export const ACCESS_ACTIONS = {
  read: ODRL.read,
  modify: ODRL.modify,
  create: LWS.create,
  delete: ODRL.delete,
} as const

export const ACL = createVocabulary(
  'http://www.w3.org/ns/auth/acl#',
  'Create',
  'Delete',
  'Read',
  'Update',
  'Write',
  'Control'
)

export const SHAPETREES = createVocabulary(
  'http://www.w3.org/ns/shapetrees#',
  'describes',
  'describesInstance',
  'Description',
  'expectsType',
  'hasShapeTree',
  'inDescriptionSet',
  'NonRDFResource',
  'references',
  'Resource',
  'shape',
  'ShapeTree',
  'usesLanguage',
  'viaPredicate'
)

export const XSD = createVocabulary(
  'http://www.w3.org/2001/XMLSchema#',
  'dateTime',
  'language',
  'string'
)

export const SKOS = createVocabulary(
  'http://www.w3.org/2004/02/skos/core#',
  'definition',
  'note',
  'prefLabel'
)

export const ACP = createVocabulary(
  'http://www.w3.org/ns/solid/acp#',
  'PublicAgent',
  'PublicClient',
  'AccessControlResource',
  'AccessControl',
  'Policy',
  'Matcher',
  'apply',
  'allow',
  'anyOf',
  'agent',
  'client',
  'resource',
  'accessControl',
  'memberAccessControl'
)

export const SOLID = createVocabulary(
  'http://www.w3.org/ns/solid/terms#',
  'oidcIssuer',
  'storageDescription',
  'updatesViaStreamingHttp2023'
)

export const OIDC = createVocabulary('http://www.w3.org/ns/solid/oidc#', 'client_name', 'logo_uri')

export const SPACE = createVocabulary('http://www.w3.org/ns/pim/space#', 'Storage')

export const AS = createVocabulary(
  'https://www.w3.org/ns/activitystreams#',
  // activities are typed RDF classes (see the OpenWiki `services/activity-lifecycle.md`) — `actor`
  // (the registry owner, plain IRI on the wire), the as:target/as:object
  // wire fields, and the ASV activity types carried beside the interop class
  // in the `type` tuple (`['Activity', '<Class>', 'as:Accept']` — spelled as
  // compact IRIs via the `as:` prefix in dataModelContext).
  'actor',
  'object',
  'target',
  'Accept',
  'Create',
  'Add',
  'Update'
)
