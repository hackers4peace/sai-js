import { buildSessionManager } from '@elfpavlik/sai-components'
import { type FinalGrantData, type OdrlPolicy, toJsonLd } from '@janeirodigital/interop-data-model'
import { LWS } from '@janeirodigital/interop-utils'

export interface DelegatedGrantFixture {
  /** The delegator / ODRL assigner whose registry stores the grant. */
  assigner: string
  assignee: string
  dataOwner: string
  claim: OdrlPolicy[]
  scopeOfGrant: string
  storage: string
  registeredShapeTree: string
  hasDataRegistration: string
  hasDataInstance?: string[]
}

/**
 * Store a delegated grant in the **assigner's** own grant registry — the C2
 * layout the intermediate UAS validates against. Returns the stored body.
 */
export async function storeDelegatedGrant(fixture: DelegatedGrantFixture): Promise<FinalGrantData> {
  const session = await buildSessionManager().getSession(fixture.assigner)
  const id = await session.mintIdentifier(session.registrySet.hasGrantRegistry.id)
  const grant: FinalGrantData = {
    id,
    type: [LWS.AccessGrant],
    access: fixture.claim,
    scopeOfGrant: fixture.scopeOfGrant,
    storage: fixture.storage,
    grantedBy: fixture.assigner,
    dataOwner: fixture.dataOwner,
    registeredShapeTree: fixture.registeredShapeTree,
    hasDataRegistration: fixture.hasDataRegistration,
    ...(fixture.hasDataInstance ? { hasDataInstance: fixture.hasDataInstance } : {}),
  }
  await session.createIdentifierResource(
    session.registrySet.hasGrantRegistry.id,
    id,
    false,
    toJsonLd(grant)
  )
  return grant
}
