import { ACL, ACP, RDF, jsonld, toNQuads } from '@janeirodigital/interop-utils'
import { describe, expect, test } from 'vitest'

import {
  acrContext,
  agentRegistrationAcrJsonLd,
  accessGrantAcrJsonLd,
  registrySetAcrJsonLd,
  rewriteFullAdminAccess,
} from '../src'

const owner = { agent: 'https://owner.example/#id', client: 'https://owner.example/app' }
const peer = { agent: 'https://peer.example/#id', client: 'https://peer.example/app' }
const admin = { agent: 'https://admin.example/#id', client: 'https://admin.example/app' }

/** N-Quads lines that type a node `acp:AccessControlResource`. */
function rootTypeLines(nquads: string): Array<string> {
  return nquads.split('\n').filter((line) => line.includes(`<${ACP.AccessControlResource}>`))
}

describe('agentRegistrationAcrJsonLd', () => {
  test('serializes owner full access and peer read access', async () => {
    const id = 'https://auth.alice.example/registration/'
    const acr = `${id}.acr`

    const nquads = await toNQuads(agentRegistrationAcrJsonLd({ id, owner, peer }))

    expect(nquads).toContain(`<${acr}#root> <${RDF.type}> <${ACP.AccessControlResource}>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.resource}> <${id}>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.accessControl}> <${acr}#fullOwnerAccess>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.accessControl}> <${acr}#peerReadAccess>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.memberAccessControl}> <${acr}#fullOwnerAccess>`)
    // owner policy: Read/Write/Control for owner.agent/owner.client
    expect(nquads).toContain(`<${acr}#fullOwnerAccess> <${ACP.apply}>`)
    expect(nquads).toContain(`<${ACP.agent}> <${owner.agent}>`)
    expect(nquads).toContain(`<${ACP.client}> <${owner.client}>`)
    // peer policy: read-only
    expect(nquads).toContain(`<${acr}#peerReadAccess> <${ACP.apply}>`)
    expect(nquads).toContain(`<${ACP.agent}> <${peer.agent}>`)
    expect(nquads).toContain(`<${ACP.client}> <${peer.client}>`)
  })

  test('owner policy allows Read, Write and Control', async () => {
    const id = 'https://auth.alice.example/registration/'
    const nquads = await toNQuads(agentRegistrationAcrJsonLd({ id, owner, peer }))

    // the fullOwnerAccess policy carries the three modes
    const ownerPolicy = nquads
      .split('\n')
      .filter((line) => line.includes(`${id}.acr#fullOwnerAccess`))
      .join('\n')
    expect(ownerPolicy).toContain(`<${ACP.apply}>`)
    expect(nquads).toContain(`<${ACP.allow}> <${ACL.Read}>`)
    expect(nquads).toContain(`<${ACP.allow}> <${ACL.Write}>`)
    expect(nquads).toContain(`<${ACP.allow}> <${ACL.Control}>`)
  })
})

describe('registrySetAcrJsonLd', () => {
  test('is the owner-only ACR rooted at <id>.acr#root', async () => {
    const id = 'https://auth.alice.example/c0ffee/'
    const acr = `${id}.acr`

    const nquads = await toNQuads(registrySetAcrJsonLd({ id, owner }))

    expect(nquads).toContain(`<${acr}#root> <${RDF.type}> <${ACP.AccessControlResource}>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.resource}> <${id}>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.accessControl}> <${acr}#fullOwnerAccess>`)
    expect(nquads).toContain(`<${acr}#root> <${ACP.memberAccessControl}> <${acr}#fullOwnerAccess>`)
    expect(nquads).toContain(`<${acr}#fullOwnerAccess> <${ACP.apply}>`)
    expect(nquads).toContain(`<${ACP.agent}> <${owner.agent}>`)
    expect(nquads).toContain(`<${ACP.client}> <${owner.client}>`)
    // one owner control only — the admin control is added by the rewrite
    expect(nquads.match(new RegExp(`<${ACP.AccessControl}>`, 'g'))?.length).toBe(1)
    expect(nquads).not.toContain('#peerReadAccess')
  })
})

describe('accessGrantAcrJsonLd', () => {
  test('adds grantor and peer/client matchers when present', async () => {
    const acr = 'https://auth.alice.example/grant.acr'
    const grantor = { agent: 'https://grantor.example/#id', client: 'https://grantor.example/app' }

    const nquads = await toNQuads(
      accessGrantAcrJsonLd({
        acr,
        resource: 'https://auth.alice.example/grant',
        owner,
        grantor,
        peer,
      })
    )

    expect(nquads).toContain(`<${acr}#root> <${ACP.resource}> <https://auth.alice.example/grant>`)
    expect(nquads).toContain(`<${acr}#fullOwnerAccess> <${ACP.apply}>`)
    expect(nquads).toContain(`<${acr}#peerReadAccess> <${ACP.apply}>`)
    expect(nquads).toContain(`<${ACP.agent}> <${grantor.agent}>`)
    expect(nquads).toContain(`<${ACP.agent}> <${peer.agent}>`)
    expect(nquads).toContain(`<${ACP.client}> <${peer.client}>`)
    // the ACR document IRI is used as is — no `${acr}.acr` doubling
    expect(nquads).not.toContain(`${acr}.acr`)
  })
})

describe('rewriteFullAdminAccess', () => {
  const acrId = 'https://auth.alice.example/registry/.acr'
  const rootId = `${acrId}#root`
  const fullAdminAccess = `${acrId}#fullAdminAccess`
  const fullOwnerAccess = `${acrId}#fullOwnerAccess`

  const adminMatcher = (agent: string, client: string) => ({
    type: ['Matcher'],
    agent,
    client,
  })

  const expandedAcr = async () =>
    (await jsonld.expand({
      '@context': acrContext,
      '@graph': [
        {
          id: rootId,
          type: ['AccessControlResource'],
          resource: 'https://auth.alice.example/registry/',
          accessControl: [fullAdminAccess, fullOwnerAccess],
          memberAccessControl: [fullAdminAccess, fullOwnerAccess],
        },
        {
          id: fullAdminAccess,
          type: ['AccessControl'],
          apply: [
            {
              type: ['Policy'],
              allow: ['Read', 'Write', 'Control'],
              anyOf: [adminMatcher('https://old.example/#id', 'https://old.example/app')],
            },
          ],
        },
        {
          id: fullOwnerAccess,
          type: ['AccessControl'],
          apply: [
            {
              type: ['Policy'],
              allow: ['Read', 'Write', 'Control'],
              anyOf: [adminMatcher('https://owner.example/#id', 'https://owner.example/app')],
            },
          ],
        },
      ],
    })) as Array<unknown>

  test('replaces the fullAdminAccess matchers and preserves other controls', async () => {
    const rewritten = rewriteFullAdminAccess(await expandedAcr(), acrId, [
      { agent: 'https://new.example/#id', client: 'https://new.example/app' },
    ])
    const nquads = await toNQuads(rewritten)

    expect(nquads).not.toContain('https://old.example/#id')
    expect(nquads).toContain(`<${ACP.agent}> <https://new.example/#id>`)
    expect(nquads).toContain(`<${ACP.client}> <https://new.example/app>`)
    // untouched control survives
    expect(nquads).toContain(`<${ACP.agent}> <https://owner.example/#id>`)
    // #root wired to the fresh control
    expect(nquads).toContain(`<${rootId}> <${ACP.accessControl}> <${fullAdminAccess}>`)
    expect(nquads).toContain(`<${rootId}> <${ACP.memberAccessControl}> <${fullAdminAccess}>`)
    // exactly one #fullAdminAccess control
    expect(nquads.match(new RegExp(`<${ACP.AccessControl}>`, 'g'))?.length).toBe(2)
  })

  test('removes the control and its #root wiring when the admin list is empty', async () => {
    const rewritten = rewriteFullAdminAccess(await expandedAcr(), acrId, [])
    const nquads = await toNQuads(rewritten)

    expect(nquads).not.toContain(fullAdminAccess)
    expect(nquads).not.toContain('https://old.example/#id')
    // the owner control is untouched
    expect(nquads).toContain(`<${fullOwnerAccess}> <${ACP.apply}>`)
    expect(nquads).toContain(`<${ACP.agent}> <https://owner.example/#id>`)
  })

  test('does not mutate the input document', async () => {
    const input = await expandedAcr()
    const snapshot = JSON.stringify(input)
    rewriteFullAdminAccess(input, acrId, [])
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('rewriteFullAdminAccess on ACRs from the builders', () => {
  const registrationId = 'https://auth.alice.example/registration/'
  const registrySetId = 'https://auth.alice.example/c0ffee/'
  const grantId = 'https://auth.alice.example/grant'

  const builtAcrs = [
    {
      name: 'agentRegistrationAcrJsonLd',
      acr: `${registrationId}.acr`,
      doc: agentRegistrationAcrJsonLd({ id: registrationId, owner, peer }),
    },
    {
      name: 'registrySetAcrJsonLd',
      acr: `${registrySetId}.acr`,
      doc: registrySetAcrJsonLd({ id: registrySetId, owner }),
    },
    {
      name: 'accessGrantAcrJsonLd',
      acr: `${grantId}.acr`,
      doc: accessGrantAcrJsonLd({ acr: `${grantId}.acr`, resource: grantId, owner, peer }),
    },
  ]

  for (const { name, acr, doc } of builtAcrs) {
    test(`${name}: wires the existing root instead of adding a second one`, async () => {
      const nquads = await toNQuads(rewriteFullAdminAccess(await jsonld.expand(doc), acr, [admin]))

      const roots = rootTypeLines(nquads)
      expect(roots).toHaveLength(1)
      expect(roots[0]).toContain(`<${acr}#root>`)
      expect(nquads).toContain(`<${acr}#root> <${ACP.accessControl}> <${acr}#fullAdminAccess>`)
      expect(nquads).toContain(
        `<${acr}#root> <${ACP.memberAccessControl}> <${acr}#fullAdminAccess>`
      )
    })
  }

  test('locates a root with another node id by its acp:AccessControlResource class', async () => {
    const acr = `${registrySetId}.acr`
    const renamed = `${acr}#resource-access-control`
    const expanded = (await jsonld.expand(
      registrySetAcrJsonLd({ id: registrySetId, owner })
    )) as Array<Record<string, any>>
    const root = expanded.find((node) => (node['@type'] ?? []).includes(ACP.AccessControlResource))!
    root['@id'] = renamed

    const nquads = await toNQuads(rewriteFullAdminAccess(expanded, acr, [admin]))

    const roots = rootTypeLines(nquads)
    expect(roots).toHaveLength(1)
    expect(roots[0]).toContain(`<${renamed}>`)
    expect(nquads).toContain(`<${renamed}> <${ACP.memberAccessControl}> <${acr}#fullAdminAccess>`)
    // no fresh `${acr}#root` node was created next to the real root
    expect(nquads).not.toContain(`<${acr}#root>`)
  })
})
