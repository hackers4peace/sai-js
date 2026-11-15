import { INTEROP, LWS, ODRL } from './namespaces.ts'

/**
 * Bundled SAI wire context (`https://www.w3.org/ns/solid/interop-context/v1`).
 *
 * It defines every `interop:` term used by the frozen access request/grant
 * payloads so compaction emits bare keys. LWS terms (`storage`, envelope
 * types) come from the LWS context; ODRL policy terms come from the local ODRL
 * context.
 */
export const saiContext = {
  '@context': {
    interop: 'http://www.w3.org/ns/solid/interop#',
    st: 'http://www.w3.org/ns/shapetrees#',

    owner: { '@id': INTEROP.dataOwner, '@type': '@id' },
    AccessProfile: INTEROP.AccessProfile,
    NeedBasedAccessRequest: INTEROP.NeedBasedAccessRequest,
    DelegationRequest: INTEROP.DelegationRequest,
    AccessRevocationRequest: INTEROP.AccessRevocationRequest,
    AccessNeed: INTEROP.AccessNeed,
    AccessRequired: INTEROP.AccessRequired,
    AccessOptional: INTEROP.AccessOptional,
    AdminGrant: INTEROP.AdminGrant,
    DataRegistration: INTEROP.DataRegistration,
    SocialAgent: INTEROP.SocialAgent,
    All: INTEROP.All,
    AllFromAgent: INTEROP.AllFromAgent,
    AllFromRegistry: INTEROP.AllFromRegistry,
    AllFromRole: INTEROP.AllFromRole,
    SelectedFromRegistry: INTEROP.SelectedFromRegistry,
    Inherited: INTEROP.Inherited,
    RegistrySet: INTEROP.RegistrySet,
    DataRegistry: INTEROP.DataRegistry,

    scopeOfGrant: { '@id': INTEROP.scopeOfGrant, '@type': '@id' },
    scopeOfAdminGrant: { '@id': INTEROP.scopeOfAdminGrant, '@type': '@id' },
    inheritsFromGrant: { '@id': INTEROP.inheritsFromGrant, '@type': '@id' },
    inheritsFromNeed: { '@id': INTEROP.inheritsFromNeed, '@type': '@id' },
    registeredShapeTree: { '@id': INTEROP.registeredShapeTree, '@type': '@id' },
    accessNeedGroup: { '@reverse': INTEROP.hasAccessNeed, '@type': '@id' },
    hasInheritingGrant: {
      '@reverse': INTEROP.inheritsFromGrant,
      '@type': '@id',
      '@container': '@set',
    },
    grants: { '@id': INTEROP.grants, '@type': '@id', '@container': '@set' },

    // ODRL classes/terms used in profile positions that are not in every
    // engine's ODRL context copy.
    Agreement: ODRL.Agreement,
    Request: ODRL.Request,
    Asset: ODRL.Asset,
    AssetCollection: ODRL.AssetCollection,
    Storage: LWS.Storage,
  },
}
