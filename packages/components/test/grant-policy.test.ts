import { grantAccess, toJsonLd } from '@janeirodigital/interop-data-model'
import { INTEROP, ODRL, ODRL_ID_JAG_CONTEXT, toNQuads } from '@janeirodigital/interop-utils'
import { Parser } from 'n3'
import { describe, expect, test, vi } from 'vitest'

import { setAccessClaimAssignee } from '../src/access-claim.js'
import type { AccessClaimValidator } from '../src/DelegatedAccessClaimValidator.js'
import { type FinalGrantData, grantFromPolicy } from '../src/grant-policy.js'
import { grantCoversClaim } from '../src/grant-policy.js'
import { OwnerAccessClaimValidator } from '../src/OwnerAccessClaimValidator.js'

const OWNER = 'https://id/acme'
const ALICE = 'https://id/alice'
const STORAGE = 'https://data/acme/'
const REGISTRATION = 'https://data/acme/registration/projects/'
const SHAPE_TREE = 'https://data/shape/trees/Project'
const INSTANCE = 'https://data/acme/project-x'

function grant(overrides: Record<string, unknown> = {}): FinalGrantData {
  const [policy] = grantAccess({
    scopeOfGrant: INTEROP.AllFromRegistry,
    owner: OWNER,
    storage: STORAGE,
    hasDataRegistration: REGISTRATION,
    registeredShapeTree: SHAPE_TREE,
    assigner: OWNER,
    assignee: ALICE,
    actions: [ODRL.read, ODRL.create],
    ...overrides,
  })
  return grantFromPolicy(policy, 'https://registry/acme/g1', policy.scopeOfGrant!)
}

function claim(overrides: Record<string, unknown> = {}) {
  const [policy] = grantAccess({
    scopeOfGrant: INTEROP.AllFromRegistry,
    owner: OWNER,
    storage: STORAGE,
    hasDataRegistration: REGISTRATION,
    registeredShapeTree: SHAPE_TREE,
    assigner: OWNER,
    assignee: ALICE,
    actions: [ODRL.read],
    ...overrides,
  })
  return setAccessClaimAssignee([policy], ALICE)
}

async function quadsFor(source: FinalGrantData) {
  return new Parser({ format: 'N-Quads' }).parse(await toNQuads(toJsonLd(source), source.id))
}

function validatorFor(source: FinalGrantData): AccessClaimValidator {
  const manager = {
    getAuthorizationData: vi.fn(async () => quadsFor(source)),
  }
  return new OwnerAccessClaimValidator(manager as never)
}

const input = (access: unknown[]) => ({
  subject: ALICE,
  client: 'https://data/test-client/public/id',
  access,
  context: ODRL_ID_JAG_CONTEXT,
  storage: STORAGE,
})

describe('claim coverage', () => {
  test('narrower actions are covered by the owner grant', () => {
    const source = grant()
    expect(grantCoversClaim(source, claim()[0] as never)).toBe(true)
  })

  test('broader actions are not covered', async () => {
    const source = grant()
    const broader = claim({ actions: [ODRL.read, ODRL.create, ODRL.delete] })
    expect(grantCoversClaim(source, broader[0] as never)).toBe(false)
    await expect(validatorFor(source).validate(input(broader))).rejects.toThrow(
      'no owner grant covers'
    )
  })

  test('a selected claim is covered by an all-from-registry grant', () => {
    const source = grant()
    const selected = claim({
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: [INSTANCE],
    })
    expect(grantCoversClaim(source, selected[0] as never)).toBe(true)
  })

  test('a different selected instance is not covered', () => {
    const source = grant({
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: [INSTANCE],
    })
    const other = claim({
      scopeOfGrant: INTEROP.SelectedFromRegistry,
      hasDataInstance: ['https://data/acme/project-y'],
    })
    expect(grantCoversClaim(source, other[0] as never)).toBe(false)
  })

  test('an app-specific grant to the client covers a claim bound to the subject', async () => {
    const source = grant({ assignee: 'https://data/test-client/public/id' })
    const appClaim = claim()
    expect(
      grantCoversClaim(source, appClaim[0] as never, {
        assignees: [ALICE, 'https://data/test-client/public/id'],
      })
    ).toBe(true)
    await expect(validatorFor(source).validate(input(appClaim))).resolves.toBe(OWNER)
  })

  test('the owner validator accepts a covered claim and rejects a missing grant', async () => {
    const source = grant()
    await expect(validatorFor(source).validate(input(claim()))).resolves.toBe(OWNER)

    const manager = {
      getAuthorizationData: vi.fn(async () => quadsFor(grant({ actions: [ODRL.delete] }))),
    }
    const validator = new OwnerAccessClaimValidator(manager as never)
    await expect(validator.validate(input(claim()))).rejects.toThrow('no owner grant covers')
  })
})
