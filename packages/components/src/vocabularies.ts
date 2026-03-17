import { createVocabulary } from 'rdf-vocabulary'

export const INTEROP = createVocabulary(
  'http://www.w3.org/ns/solid/interop#',
  'registeredAgent',
  'registeredShapeTree',
  'hasStorage',
  'dataOwner',
  'grantee',
  'grantedBy',
  'hasStorage',
  'hasDataRegistration',
  'hasDataInstance',
  'accessMode',
  'scopeOfGrant',
  'AllFromRegistry',
  'SelectedFromRegistry',
  'Inherited',
  'inheritsFromGrant'
)
export const ACL = createVocabulary(
  'http://www.w3.org/ns/auth/acl#',
  'Create',
  'Read',
  'Update',
  'Delete'
)
