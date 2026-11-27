import { CONTEXT, ODRL, ODRL_ID_JAG_CONTEXT } from '@janeirodigital/interop-utils'
import { describe, expect, test, vi } from 'vitest'

import type { VerifiedAccessClaim } from '../src/access-claim.js'
import {
  AdminImpersonationAuthority,
  AdminImpersonationDenied,
} from '../src/AdminImpersonationAuthority.js'
import type { AccessClaimValidator } from '../src/DelegatedAccessClaimValidator.js'
import type { PodEndpointStore } from '../src/PodEndpointStore.js'
import { agentId } from '../src/util/uriTemplates.js'
import { idJagClaim } from './access-claim-helpers.js'

const ORG = 'https://id/yoyo'
// identifier templates mint absolute IRIs from CSS_BASE_URL
process.env.CSS_BASE_URL = 'https://auth/'

const ORG_UAS = agentId(ORG)
const ADMIN = 'https://id/dan'
const ADMIN_UAS = 'https://auth/.sai/agents/ZGFu'
const PEER_STORAGE = 'https://data/bob/'
const ORG_STORAGE = 'https://data/yoyo-eu/'

class TestAuthority extends AdminImpersonationAuthority {
  public admin = true

  public constructor(
    endpointStore: PodEndpointStore,
    claimValidator: AccessClaimValidator,
    private readonly agent: string | undefined = ADMIN_UAS
  ) {
    super(endpointStore, claimValidator)
  }

  protected async discoverAgent(): Promise<string | undefined> {
    return this.agent
  }

  protected async hasDataRegistryAdmin(): Promise<boolean> {
    return this.admin
  }
}

function buildAuthority(
  options: {
    ownStorage?: boolean
    admin?: boolean
    claim?: VerifiedAccessClaim | undefined
    agent?: string | undefined
  } = {}
) {
  const podUrl = options.ownStorage ? PEER_STORAGE : ORG_STORAGE
  const endpointStore = {
    findSparqlByWebId: vi.fn(async () => [{ podUrl, endpoint: 'http://fuseki/org' }]),
  } as unknown as PodEndpointStore
  const defaultClaim = {
    access: idJagClaim({ storage: PEER_STORAGE, assignee: ORG, actions: [ODRL.read, ODRL.modify] }),
    context: ODRL_ID_JAG_CONTEXT,
    storage: PEER_STORAGE,
    assigners: [ORG],
    assignees: [ORG],
  } as VerifiedAccessClaim
  const claim = 'claim' in options ? options.claim : defaultClaim
  const claimValidator = {
    find: vi.fn(async () => claim),
    validate: vi.fn(),
  } as unknown as AccessClaimValidator
  const authority = new TestAuthority(
    endpointStore,
    claimValidator,
    'agent' in options ? options.agent : ADMIN_UAS
  )
  authority.admin = options.admin ?? true
  return { authority, endpointStore, claimValidator }
}

const input = { org: ORG, subject: ADMIN, client: ADMIN_UAS, storage: PEER_STORAGE }

describe('AdminImpersonationAuthority', () => {
  test('issues the organization claim narrowed to read', async () => {
    const { authority, claimValidator } = buildAuthority()
    const claim = await authority.authorize(input)

    expect(claim.storage).toBe(PEER_STORAGE)
    expect(claim.assignees).toEqual([ORG])
    const actions = claim.access.flatMap((policy) =>
      (policy as { permission: Array<{ action: Array<string> }> }).permission.flatMap(
        (permission) => permission.action
      )
    )
    expect(actions).toEqual([CONTEXT.read])
    // the organization is the claim subject, not the admin
    expect(claimValidator.find).toHaveBeenCalledWith({
      subject: ORG,
      client: ORG_UAS,
      storage: PEER_STORAGE,
      forStorage: true,
    })
  })

  test('rejects the organization’s own storage (the exchange would mint `owner`)', async () => {
    const { authority } = buildAuthority({ ownStorage: true })
    await expect(authority.authorize(input)).rejects.toBeInstanceOf(AdminImpersonationDenied)
  })

  test('rejects a subject that is not a DataRegistry admin of the org', async () => {
    const { authority } = buildAuthority({ admin: false })
    await expect(authority.authorize(input)).rejects.toBeInstanceOf(AdminImpersonationDenied)
  })

  test('rejects an admin using an app client instead of its own authorization agent', async () => {
    const { authority } = buildAuthority({ agent: 'https://app.example/client' })
    await expect(authority.authorize(input)).rejects.toBeInstanceOf(AdminImpersonationDenied)
  })

  test('rejects an organization with no grant for the storage', async () => {
    const { authority } = buildAuthority({ claim: undefined })
    await expect(authority.authorize(input)).rejects.toBeInstanceOf(AdminImpersonationDenied)
  })

  test('rejects a grant that does not allow reading', async () => {
    const { authority } = buildAuthority({
      claim: {
        access: idJagClaim({ storage: PEER_STORAGE, assignee: ORG, actions: [ODRL.modify] }),
        context: ODRL_ID_JAG_CONTEXT,
        storage: PEER_STORAGE,
        assigners: [ORG],
        assignees: [ORG],
      } as VerifiedAccessClaim,
    })
    await expect(authority.authorize(input)).rejects.toBeInstanceOf(AdminImpersonationDenied)
  })
})
