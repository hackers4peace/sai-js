import { ACL, ACP } from '@janeirodigital/interop-utils'

import { acrContext } from './context.ts'
import type { AgentAndClient } from './templates/types.ts'

// ──────────────────────────
// Access Control Resources (ACP) as JSON-LD
// ──────────────────────────

/** An `acp:Policy` with `acp:allow` modes and a single `acp:Matcher` (agent + client). */
function acrPolicy(
  allow: Array<string>,
  { agent, client }: AgentAndClient
): Record<string, unknown> {
  return {
    type: ['Policy'],
    allow,
    anyOf: [{ type: ['Matcher'], agent, client }],
  }
}

/**
 * Compacted JSON-LD document for an agent-registration ACR: the owner gets
 * full access, the peer read-only. The ACR document is at `<id>.acr` and its
 * root node at `<id>.acr#root` — the id `rewriteFullAdminAccess` expects. PUT
 * expanded via `putJsonLd`.
 */
export function agentRegistrationAcrJsonLd({
  id,
  owner,
  peer,
}: {
  id: string
  owner: AgentAndClient
  peer: AgentAndClient
}): Record<string, unknown> {
  const acr = `${id}.acr`
  return {
    '@context': acrContext,
    '@graph': [
      {
        id: `${acr}#root`,
        type: ['AccessControlResource'],
        resource: id,
        accessControl: [`${acr}#fullOwnerAccess`, `${acr}#peerReadAccess`],
        memberAccessControl: [`${acr}#fullOwnerAccess`, `${acr}#peerReadAccess`],
      },
      {
        id: `${acr}#fullOwnerAccess`,
        type: ['AccessControl'],
        apply: [acrPolicy([ACL.Read, ACL.Write, ACL.Control], owner)],
      },
      {
        id: `${acr}#peerReadAccess`,
        type: ['AccessControl'],
        apply: [acrPolicy([ACL.Read], peer)],
      },
    ],
  }
}

/**
 * Compacted JSON-LD document for the bootstrap registry-set ACR: the owner's
 * full access only — admins are added later by `rewriteFullAdminAccess`.
 * `templates/RegistrySet.ts` emits the same graph as TriG; the template test
 * asserts the two are isomorphic.
 */
export function registrySetAcrJsonLd({
  id,
  owner,
}: {
  id: string
  owner: AgentAndClient
}): Record<string, unknown> {
  const acr = `${id}.acr`
  return {
    '@context': acrContext,
    '@graph': [
      {
        id: `${acr}#root`,
        type: ['AccessControlResource'],
        resource: id,
        accessControl: [`${acr}#fullOwnerAccess`],
        memberAccessControl: [`${acr}#fullOwnerAccess`],
      },
      {
        id: `${acr}#fullOwnerAccess`,
        type: ['AccessControl'],
        apply: [acrPolicy([ACL.Read, ACL.Write, ACL.Control], owner)],
      },
    ],
  }
}

/**
 * Compacted JSON-LD document for an access-grant ACR. The owner always gets full
 * access; an optional delegating `grantor` and an optional `peer`/`client`
 * matcher get read-only access. `acr` is the ACR document IRI (the resource's
 * `acl` link), so the root and the controls live under `<acr>#…`.
 */
export function accessGrantAcrJsonLd({
  acr,
  resource,
  owner,
  grantor,
  peer,
  client,
}: {
  acr: string
  resource: string
  owner: AgentAndClient
  grantor?: AgentAndClient
  peer?: AgentAndClient
  client?: AgentAndClient
}): Record<string, unknown> {
  const peerMatchers: Array<Record<string, unknown>> = []
  if (peer) {
    peerMatchers.push({ type: ['Matcher'], agent: peer.agent, client: peer.client })
  }
  if (client) {
    peerMatchers.push({ type: ['Matcher'], agent: client.agent, client: client.client })
  }

  return {
    '@context': acrContext,
    '@graph': [
      {
        id: `${acr}#root`,
        type: ['AccessControlResource'],
        resource,
        accessControl: [`${acr}#fullOwnerAccess`, `${acr}#peerReadAccess`],
        memberAccessControl: [`${acr}#fullOwnerAccess`, `${acr}#peerReadAccess`],
      },
      {
        id: `${acr}#fullOwnerAccess`,
        type: ['AccessControl'],
        apply: [
          acrPolicy([ACL.Read, ACL.Write, ACL.Control], owner),
          ...(grantor ? [acrPolicy([ACL.Read], grantor)] : []),
        ],
      },
      {
        id: `${acr}#peerReadAccess`,
        type: ['AccessControl'],
        apply: [{ type: ['Policy'], allow: [ACL.Read], anyOf: peerMatchers }],
      },
    ],
  }
}

type ExpandedNode = Record<string, any>

/**
 * Rewrite the `#fullAdminAccess` access control of an ACR (fetched as expanded
 * JSON-LD) from the given admin matchers. Removes the existing control (its
 * `acp:apply` policies and their `acp:anyOf` matchers) and its root node's
 * `acp:accessControl`/`acp:memberAccessControl` wiring, then adds a fresh
 * control + wiring. An empty `matchers` list removes the control entirely.
 *
 * The root is located by `${acrId}#root` — the id our builders and the
 * bootstrap template emit — or, for an ACR written elsewhere, by the
 * `acp:AccessControlResource` class. Only when neither matches is a `#root`
 * node created.
 *
 * Pure — the input document is cloned, never mutated.
 */
export function rewriteFullAdminAccess(
  doc: unknown,
  acrId: string,
  matchers: Array<AgentAndClient>
): Record<string, unknown> {
  const source = Array.isArray(doc) ? doc : ((doc as any)?.['@graph'] ?? [doc])
  const nodes: Array<ExpandedNode> = source.map((node: ExpandedNode) => structuredClone(node))

  const fullAdminAccess = `${acrId}#fullAdminAccess`
  const rootId = `${acrId}#root`
  // our builders and the bootstrap template name the root node `${acrId}#root`;
  // an ACR written elsewhere may use any node id, so fall back to the
  // `acp:AccessControlResource` class (one per document). Without this the
  // wiring lands on a fresh `#root` node while the real root stays untouched.
  const isRoot = (node: ExpandedNode): boolean =>
    node['@id'] === rootId ||
    (Array.isArray(node['@type']) && node['@type'].includes(ACP.AccessControlResource))

  // transitive closure: #fullAdminAccess → acp:apply policies → acp:anyOf matchers
  const toRemove = new Set<string>([fullAdminAccess])
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (!toRemove.has(node['@id'])) {
        continue
      }
      for (const predicate of [ACP.apply, ACP.anyOf]) {
        for (const ref of node[predicate] ?? []) {
          const refId = ref?.['@id']
          if (typeof refId === 'string' && !toRemove.has(refId)) {
            toRemove.add(refId)
            changed = true
          }
        }
      }
    }
  }

  const kept = nodes.filter((node) => !toRemove.has(node['@id']))

  // drop the root wiring to #fullAdminAccess
  for (const node of kept) {
    if (!isRoot(node)) {
      continue
    }
    for (const predicate of [ACP.accessControl, ACP.memberAccessControl]) {
      const refs = node[predicate]
      if (!Array.isArray(refs)) {
        continue
      }
      node[predicate] = refs.filter((ref) => ref?.['@id'] !== fullAdminAccess)
      if (node[predicate].length === 0) {
        delete node[predicate]
      }
    }
  }

  if (matchers.length === 0) {
    return { '@graph': kept }
  }

  const control: ExpandedNode = {
    '@id': fullAdminAccess,
    '@type': [ACP.AccessControl],
    [ACP.apply]: matchers.map((matcher) => ({
      '@type': [ACP.Policy],
      [ACP.allow]: [{ '@id': ACL.Read }, { '@id': ACL.Write }, { '@id': ACL.Control }],
      [ACP.anyOf]: [
        {
          '@type': [ACP.Matcher],
          [ACP.agent]: [{ '@id': matcher.agent }],
          [ACP.client]: [{ '@id': matcher.client }],
        },
      ],
    })),
  }

  const root = kept.find(isRoot)
  if (root) {
    root[ACP.accessControl] = [...(root[ACP.accessControl] ?? []), { '@id': fullAdminAccess }]
    root[ACP.memberAccessControl] = [
      ...(root[ACP.memberAccessControl] ?? []),
      { '@id': fullAdminAccess },
    ]
  } else {
    kept.push({
      '@id': rootId,
      [ACP.accessControl]: [{ '@id': fullAdminAccess }],
      [ACP.memberAccessControl]: [{ '@id': fullAdminAccess }],
    })
  }
  kept.push(control)

  return { '@graph': kept }
}
