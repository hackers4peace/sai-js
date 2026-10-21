import {
  ACL,
  ACP,
  AS,
  INTEROP,
  type JsonLdContext,
  LDP,
  OIDC,
  SHAPETREES,
  SKOS,
  SOLID,
  createVocabulary,
} from '@janeirodigital/interop-utils'

const NFO = createVocabulary(
  'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#',
  'fileName'
)

/**
 * JSON-LD term definition with IRI coercion (`@type: '@id'`): values compact
 * to plain IRI strings in framed output. `set: true` adds
 * `@container: '@set'` (always-array). Terms are generated from the shared
 * namespaces instead of hand-written IRI strings (single source of truth).
 *
 * `@reverse` terms and literal terms (no coercion) stay explicit object
 * literals, e.g. `label: { '@id': SKOS.prefLabel }`.
 */
const iriTermDef = (
  ns: any,
  name: string,
  { set = false }: { set?: boolean } = {}
): Record<string, string> => ({
  '@id': ns[name],
  '@type': '@id',
  ...(set ? { '@container': '@set' } : {}),
})

/**
 * The single JSON-LD context shared by every data model in this package —
 * reads (framing via `frameDoc`/`buildFrame`) and writes (`withContext`) alike.
 * It is a superset of all per-model term needs: extra term definitions are
 * inert for `toRDF` (only present keys expand) and for frame matching
 * (`requireAll=false`, `@id` forces the match).
 *
 * `@version: 1.1` — the `type` term carries `@container: '@set'` so a single
 * `rdf:type` always frames/compacts to an array (JSON-LD 1.1 compaction:
 * "as array … if … container … includes @set"). No `@protected` —
 * per-model spread-overrides (data-instance `label`) must stay possible.
 */
export const dataModelContext: JsonLdContext = {
  '@version': 1.1,
  id: '@id',

  // @type alias with a set container — `type` is ALWAYS a string[] in framed
  // output (single rdf:type values compact to a one-element array)
  type: { '@id': '@type', '@container': '@set' },

  // interop — single-value node references
  grantee: iriTermDef(INTEROP, 'grantee'),
  grantedBy: iriTermDef(INTEROP, 'grantedBy'),
  dataOwner: iriTermDef(INTEROP, 'dataOwner'),
  registeredShapeTree: iriTermDef(INTEROP, 'registeredShapeTree'),
  hasDataRegistration: iriTermDef(INTEROP, 'hasDataRegistration'),
  hasStorage: iriTermDef(INTEROP, 'hasStorage'),
  scopeOfGrant: iriTermDef(INTEROP, 'scopeOfGrant'),
  scopeOfAdminGrant: iriTermDef(INTEROP, 'scopeOfAdminGrant'),
  scopeOfAuthorization: iriTermDef(INTEROP, 'scopeOfAuthorization'),
  satisfiesAccessNeed: iriTermDef(INTEROP, 'satisfiesAccessNeed'),
  satisfiesAccessRequest: iriTermDef(INTEROP, 'satisfiesAccessRequest'),
  inheritsFromGrant: iriTermDef(INTEROP, 'inheritsFromGrant'),
  inheritsFromAuthorization: iriTermDef(INTEROP, 'inheritsFromAuthorization'),
  inheritsFromNeed: iriTermDef(INTEROP, 'inheritsFromNeed'),
  required: iriTermDef(INTEROP, 'accessNecessity'),
  hasAccessNeed: iriTermDef(INTEROP, 'hasAccessNeed', { set: true }),
  hasAccessNeedGroup: iriTermDef(INTEROP, 'hasAccessNeedGroup'),
  capabilityUrl: iriTermDef(INTEROP, 'hasCapabilityUrl'),
  registeredAgent: iriTermDef(INTEROP, 'registeredAgent'),
  hasDataGrant: iriTermDef(INTEROP, 'hasDataGrant', { set: true }),
  hasAdminGrant: iriTermDef(INTEROP, 'hasAdminGrant', { set: true }),
  hasSocialAgentRegistry: iriTermDef(INTEROP, 'hasSocialAgentRegistry'),
  hasApplicationRegistry: iriTermDef(INTEROP, 'hasApplicationRegistry'),
  hasInvitationRegistry: iriTermDef(INTEROP, 'hasInvitationRegistry'),
  members: iriTermDef(INTEROP, 'hasMember', { set: true }),
  reciprocalRegistration: iriTermDef(INTEROP, 'reciprocalRegistration'),
  hasAuthorizationRegistry: iriTermDef(INTEROP, 'hasAuthorizationRegistry'),
  hasGrantRegistry: iriTermDef(INTEROP, 'hasGrantRegistry'),
  hasRoleRegistry: iriTermDef(INTEROP, 'hasRoleRegistry'),
  hasDataRegistry: iriTermDef(INTEROP, 'hasDataRegistry', { set: true }),
  hasActivityRegistry: iriTermDef(INTEROP, 'hasActivityRegistry'),
  hasAccessRequestRegistry: iriTermDef(INTEROP, 'hasAccessRequestRegistry'),
  callbackEndpoint: iriTermDef(INTEROP, 'hasAuthorizationCallbackEndpoint'),

  // activity registry (outbox) — the wire contract in the OpenWiki
  // `services/activity-lifecycle.md`: typed
  // classes + as:target/as:object links, plain-IRI/literal fields. The
  // `as:` prefix resolves the ASV activity types in the `type` tuple
  // (`as:Accept`, `as:Create`, `as:Add`) to compact IRIs on read; the
  // retired `interop:activityType` / `interop:payload` terms are gone.
  as: 'https://www.w3.org/ns/activitystreams#',
  actor: iriTermDef(AS, 'actor'),
  target: iriTermDef(AS, 'target'),
  object: iriTermDef(AS, 'object'),
  createdAt: { '@id': INTEROP.createdAt },

  // activity classes — rdf:type values compact to these bare terms so the
  // typed ActivityData unions frame as `type: ['Activity', '<Class>', <as:*>]`.
  Activity: { '@id': INTEROP.Activity },
  AccessRequestArchived: { '@id': INTEROP.AccessRequestArchived },
  AccessRequestGranted: { '@id': INTEROP.AccessRequestGranted },
  InvitationAccepted: { '@id': INTEROP.InvitationAccepted },
  InvitationCreated: { '@id': INTEROP.InvitationCreated },
  AgentRegistrationAdded: { '@id': INTEROP.AgentRegistrationAdded },
  AdminAuthorizationGranted: { '@id': INTEROP.AdminAuthorizationGranted },
  AdminAuthorizationRevoked: { '@id': INTEROP.AdminAuthorizationRevoked },
  AuthorizationDenied: { '@id': INTEROP.AuthorizationDenied },
  AuthorizationGranted: { '@id': INTEROP.AuthorizationGranted },
  AuthorizationRevoked: { '@id': INTEROP.AuthorizationRevoked },
  NeedBasedAccessRequest: { '@id': INTEROP.NeedBasedAccessRequest },
  NeedBasedAccessRequestReceived: { '@id': INTEROP.NeedBasedAccessRequestReceived },
  NeedBasedAccessRequestSent: { '@id': INTEROP.NeedBasedAccessRequestSent },
  RoleMembershipChanged: { '@id': INTEROP.RoleMembershipChanged },
  RoleDeleted: { '@id': INTEROP.RoleDeleted },
  RoleCreated: { '@id': INTEROP.RoleCreated },
  DelegatedGrantsUpdated: { '@id': INTEROP.DelegatedGrantsUpdated },
  ActivityCompleted: { '@id': INTEROP.ActivityCompleted },

  // interop — multi-value node references
  accessMode: iriTermDef(INTEROP, 'accessMode', { set: true }),
  creatorAccessMode: iriTermDef(INTEROP, 'creatorAccessMode', { set: true }),
  hasDataInstance: iriTermDef(INTEROP, 'hasDataInstance', { set: true }),

  // interop — reverse relationships (resolved by the framing algorithm)
  hasInheritingGrant: {
    '@reverse': INTEROP.inheritsFromGrant,
    '@type': '@id',
    '@container': '@set',
  },
  hasInheritingAuthorization: {
    '@reverse': INTEROP.inheritsFromAuthorization,
    '@type': '@id',
    '@container': '@set',
  },
  hasInheritingNeed: {
    '@reverse': INTEROP.inheritsFromNeed,
    '@type': '@id',
    '@container': '@set',
  },

  // ldp
  contains: iriTermDef(LDP, 'contains', { set: true }),

  // shapetrees — node references
  shape: iriTermDef(SHAPETREES, 'shape'),
  describesInstance: iriTermDef(SHAPETREES, 'describesInstance'),
  expectsType: iriTermDef(SHAPETREES, 'expectsType'),
  hasShapeTree: iriTermDef(SHAPETREES, 'hasShapeTree'),
  viaPredicate: iriTermDef(SHAPETREES, 'viaPredicate'),
  // node objects (references) — no IRI coercion
  references: { '@id': SHAPETREES.references, '@container': '@set' },
  // literals (xsd:language) on the description sets
  descriptionLanguages: { '@id': SHAPETREES.usesLanguage, '@container': '@set' },

  // skos — literals (the unified `label` term: `skos:prefLabel` everywhere,
  // the `prefLabel` key no longer exists — one term, no compaction ambiguity).
  // `label`/`definition` are LANGUAGE MAPS (`@container: '@language'`, JSON-LD
  // 1.1 §4.6.2): tagged values index under their tag, untagged under `@none`.
  // `buildFrame` skips language-map terms, so framing emits the maps as-is.
  label: { '@id': SKOS.prefLabel, '@container': '@language' },
  definition: { '@id': SKOS.definition, '@container': '@language' },
  note: { '@id': SKOS.note },

  // solid / oidc
  oidcIssuer: iriTermDef(SOLID, 'oidcIssuer'),
  clientName: { '@id': OIDC.client_name },
  logoUri: iriTermDef(OIDC, 'logo_uri'),

  // nfo
  fileName: { '@id': NFO.fileName },
}

/**
 * JSON-LD context for Access Control Resources (ACP). ACRs are JSON-LD now
 * (previously Turtle templates): built compacted, PUT expanded, read framed.
 * `allow` values are the `acl:` access modes (compact terms `Read`/`Write`/
 * `Control`); `apply`/`anyOf` carry blank-node `Policy`/`Matcher` objects.
 */
export const acrContext: JsonLdContext = {
  '@version': 1.1,
  id: '@id',
  type: { '@id': '@type', '@container': '@set' },

  // acl — access modes referenced by acp:allow
  Read: { '@id': ACL.Read },
  Write: { '@id': ACL.Write },
  Control: { '@id': ACL.Control },

  // acp — node references
  resource: iriTermDef(ACP, 'resource'),
  accessControl: iriTermDef(ACP, 'accessControl', { set: true }),
  memberAccessControl: iriTermDef(ACP, 'memberAccessControl', { set: true }),
  agent: iriTermDef(ACP, 'agent'),
  client: iriTermDef(ACP, 'client'),
  allow: iriTermDef(ACP, 'allow', { set: true }),

  // acp — node objects (blank nodes)
  apply: { '@id': ACP.apply, '@container': '@set' },
  anyOf: { '@id': ACP.anyOf, '@container': '@set' },

  // acp — classes
  AccessControlResource: { '@id': ACP.AccessControlResource },
  AccessControl: { '@id': ACP.AccessControl },
  Policy: { '@id': ACP.Policy },
  Matcher: { '@id': ACP.Matcher },
}
