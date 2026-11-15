import { grantAccess } from '@janeirodigital/interop-data-model'
import { INTEROP, ODRL } from '@janeirodigital/interop-utils'

export const CLAIM_SUBJECT = 'https://id/alice/'
export const CLAIM_CLIENT = 'https://data/test-client/public/id'
export const CLAIM_STORAGE = 'https://data/acme.example/'
export const CLAIM_REGISTRATION = 'https://data/acme.example/registration/'
export const CLAIM_OTHER_STORAGE = 'https://registry/acme.example/'
export const CLAIM_SHAPE_TREE = 'https://data/shape/trees/Project'

/** One AllFromRegistry read permission for the test subject/client. */
export function accessClaim(
  options: {
    storage?: string
    assigner?: string
    assignee?: string
    actions?: string[]
  } = {}
) {
  return grantAccess({
    scopeOfGrant: INTEROP.AllFromRegistry,
    owner: 'https://id/acme',
    storage: options.storage ?? CLAIM_STORAGE,
    hasDataRegistration: CLAIM_REGISTRATION,
    registeredShapeTree: CLAIM_SHAPE_TREE,
    assigner: options.assigner ?? CLAIM_SUBJECT,
    assignee: options.assignee ?? CLAIM_CLIENT,
    actions: options.actions ?? [ODRL.read],
  })
}
