---
type: architecture
title: Authorization revocation and grant projections
description: How SAI revokes access — authorizations as the mutable source of truth, grants as derived projections, the authorization-revoked carrier and workflow, the grant-chain closure, and the reconciliation sweep that repairs missed revocations.
tags: [revocation, authorization, grants, delegation, projections, reconciliation]
sources:
  - id: openwiki-source-39263cf4b989bfbe674c72c0
    resource: repo://packages/api-messages/src/effect.ts
  - id: openwiki-source-654e83ca378000da767000a7
    resource: repo://packages/authorization-agent/src/agent-registration.ts
  - id: openwiki-source-831634a2eec2dfc668cfae29
    resource: repo://packages/authorization-agent/src/authorization-agent.ts
  - id: openwiki-source-91b9eb868de58a18862849c3
    resource: repo://packages/authorization-agent/src/grant-chain.ts
  - id: openwiki-source-81f61b66ae2ead4432d4358a
    resource: repo://packages/authorization-agent/src/sparql.ts
  - id: openwiki-source-0e27aa8e897f26683c4de317
    resource: repo://packages/components/src/SaiAuthorizationManager.ts
  - id: openwiki-source-9f9c5f051cdee5032dfd735b
    resource: repo://packages/components/src/services/Authorization.ts
  - id: openwiki-source-a3ebe61b7dbf9a95d1051312
    resource: repo://packages/components/src/temporal/activities/grants.ts
  - id: openwiki-source-03c71d0f7eed5c1f113d08e3
    resource: repo://packages/components/src/temporal/workflows/grants.ts
  - id: openwiki-source-fabda8691f79a477b70b0c57
    resource: repo://packages/components/src/temporal/workflows/reciprocal.ts
  - id: openwiki-source-ab1ddd2d1ab0804acc7807d2
    resource: repo://packages/components/test/authorization-revocation-workflow.test.ts
  - id: openwiki-source-40eb9f7315a1082fe32671da
    resource: repo://packages/data-model/src/activities.ts
  - id: openwiki-source-1de1cb7b4e5904caddca9b5c
    resource: repo://ui/authorization/src/store/app.ts
generated: { by: "pi", at: "2026-11-19T00:32:33.147Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-21T19:19:35.660Z
---

# Authorization revocation and grant projections

Revocation is one capability built from two kinds of state: **authorizations**
(the mutable source of truth, written only by the authorization UI/RPC) and
**grants** (derived projections that the access-control engine reads). A user
action deletes `DataAuthorization` resources; grants disappear because the
projection pipeline re-derives them from the remaining authorization state.

All ordinary grants — source and delegated — live in the **issuing agent's own
grant registry**. There is no peer-owned grant deletion and no issuer-side
replica path: a grant at another agent is that agent's projection of its own
authorizations, not a copy this agent can mutate.

## 1. Source of truth and enforcement

- Authorizations live in the authorization agent's authorization registry. The
  service reads the **context's** registry set, never a client-supplied
  resource list ([`services/Authorization.ts`](../../packages/components/src/services/Authorization.ts)).
- Enforcement resolves the storage owner's **registry pod** from the pod
  endpoint record, then collects every grant graph whose policy target points at
  the requested storage, so a grant that still exists confers access even if no
  registration links it ([`SaiAuthorizationManager.ts`](../../packages/components/src/SaiAuthorizationManager.ts)).
- Registration `hasDataGrant` links are **projections**. They are eventually
  consistent (webhook cascade plus sweep); enforcement is fixed immediately by
  the grant resource's deletion.
- Grants are immutable: a replacement is a fresh IRI, which is why a
  registration's link set can serve as an existence oracle later.
- Deny is not revocation. `recordAuthorization` writes an `AuthorizationDenied`
  activity as a pure, forward-only decline — no `DataAuthorization` is created
  and no grant is cleared.

## 2. Reading the authorizations

`findAuthorizationsForGrantee(transport, registrySet, grantee)` lists the
context's authorization registry, finds the roles the grantee is a member of,
loads every contained resource, and keeps the `interop:DataAuthorization`
resources granted directly to the grantee or to one of its roles
([`sparql.ts`](../../packages/authorization-agent/src/sparql.ts)). The class
method `AuthorizationAgent.findAuthorizationsForAgent` delegates to it with the
session's own registry.

`listAuthorizations` binds that reader to `sparqlTransportFor(ctx)` plus
`ctx.registrySet`, resolves each unique shape tree's label in the requested
language, falls back to the shape-tree IRI when no description is available,
omits absent optional fields, and sorts by data owner / shape tree / id
([`services/Authorization.ts`](../../packages/components/src/services/Authorization.ts)).
Because the transport and registry set come from the resolved context, an org
admin lists the org's authorizations through `/sparql-admin`, not their personal
ones.

The RPC is `ListAuthorizations` (`payload: { grantee, lang, context }`,
`failure: S.Never`, `success: AuthorizationList`). `RecordedDataAuthorization`
carries the authorization fields plus the resolved `shapeTreeLabel`
([`api-messages/src/effect.ts`](../../packages/api-messages/src/effect.ts)). The
UI's `Authorizations.vue` view groups the list by data owner and builds the
inheritance tree from `inheritsFromAuthorization`.

## 3. Producer: `RevokeAuthorizations`

The RPC takes `{ authorizations: IRI[], context }` and declares
`failure: AuthorizationRevocationFailure` — a union of `unauthorized`,
`empty-selection`, `not-a-data-authorization`, and `mixed-grantee` — returning
`{ activityId?: IRI, authorizations: IRI[] }` where `activityId` is absent when
nothing was left to revoke ([`api-messages/src/effect.ts`](../../packages/api-messages/src/effect.ts)).

`revokeAuthorizations` in the service performs the validation and the write
([`services/Authorization.ts`](../../packages/components/src/services/Authorization.ts)):

1. Reject an empty selection (`empty-selection`).
2. Read the context's authorization registry container. An IRI that is no
   longer contained is treated as already removed (idempotent re-revoke); an IRI
   from another registry is silently ignored, so nothing is mutated.
3. Load each selected authorization and require the `DataAuthorization` type
   (`not-a-data-authorization`), then require a single grantee across the
   selection (`mixed-grantee`).
4. Expand the inheritance closure **at write time** by following the forward
   `inheritsFromAuthorization` link of each selected resource. After the
   workflow deletes the resources the tree is gone, so the closure cannot be
   recomputed later.
5. If every selected authorization was already gone, return a no-op success.
6. Otherwise write **one** `AuthorizationRevoked` activity per grantee into the
   activity registry and return its id plus the expanded closure.

The UI never targets grants: `revokeAuthorizations` in the Pinia store calls the
RPC, claims the returned activity id, and lets the `AuthorizationRevoked`
done-row refresh the list
([`ui/authorization/src/store/app.ts`](../../ui/authorization/src/store/app.ts)).

## 4. Carrier: `AuthorizationRevoked`

The activity carries an array of `{ id, type }` references and a plain-IRI
`grantee`; `target` is dropped and `actor` is the registry owner
([`data-model/src/activities.ts`](../../packages/data-model/src/activities.ts)):

```ts
export type DataAuthorizationRef = { id: string; type: string[] }

export type AuthorizationRevoked = Omit<ActivityBase, 'target'> & {
  type: ['Activity', 'AuthorizationRevoked']
  actor: string
  object: DataAuthorizationRef[]
  grantee: string
}
```

`grantee` is the routing key that survives deletion of the referenced
resources: if the workflow crashes after the deletes, a retry (or the sweep) can
still resolve the affected grantee after `object` has no dereferenceable bodies
left.

## 5. Workflow: delete the sources, then reconcile projections

`processAuthorizationRevoked(webId, authorizations, grantee, activity)` runs on
the `create-grants` task queue
([`temporal/workflows/grants.ts`](../../packages/components/src/temporal/workflows/grants.ts)):

1. `deleteAuthorizations` — DELETE each carried ref with the owner session,
   tolerating 404. This is the source-of-truth mutation.
2. `resolveGranteeKind` — classify the carried grantee (social agent,
   application, or role).
3. `getGrantees` — expand a role grantee to its member agents.
4. One `reconcileGrantsForGrantee` child per affected grantee. The chain
   closure for downstream delegated grants is applied inside that
   reconciliation, in the same registry.
5. `markActivitiesDone` last, so a `done` event means the authorizations are
   gone and the projections were reconciled.

The webhook handler starts this workflow once per `AuthorizationRevoked`
activity with a random workflow id; the sweep starts the same workflow for
activities that never completed. The old per-grantee consumer
(`processGranteeActivities`) is not part of the path anymore
([`ActivityWebhookHandler.ts`](../../packages/components/src/ActivityWebhookHandler.ts)).

## 6. Projection reconciliation and garbage collection

`reconcileGrantsForGrantee(webId, grantee)` is the single regeneration path
(`createGrantsForAgent` just delegates to it), so authorization approval, role
changes, delegated updates, deny, and revocation all run the same projection
model ([`temporal/workflows/grants.ts`](../../packages/components/src/temporal/workflows/grants.ts)):

1. **Desired** — `getAuthorizations` reads all authorizations for the grantee
   (including via roles) from the authorization registry, then `generateGrants`
   produces source and delegated trees. An empty authorization set is simply an
   empty desired set; the deny case is not special-cased.
2. **Existing** — the union of the registration projection (`hasDataGrant`
   IRIs) and an **own-registry orphan scan** of grants whose `grantee` matches
   but that are no longer linked. The orphan scan is what makes GC recover after
   a crash between the delete and the registration PATCH.
3. **Equivalence** — `checkEquivalence` loads grant bodies from the **local**
   plane only, so it never dereferences a peer. It pairs generated and existing
   trees as whole subtrees. Reused trees keep their IRIs; an identical
   replacement causes no churn.
4. **GC** — `existing − reused` is removed **before** anything new is created.
   Every normal grant, source or delegated, is in this context's own grant
   registry, so removal is the owner-session `revokeGrantClosure`: it computes
   the dependent closure and deletes grants and ACRs together
   ([`temporal/activities/grants.ts`](../../packages/components/src/temporal/activities/grants.ts)).
   There is no `requestRevocations`, `dropGrantReplicas`, or replica-body
   grouping anymore.
5. **Create** — unmatched source trees are stored with their ACRs; unmatched
   delegated trees are stored in the **assigner's own** grant registry.
6. **PATCH last** — `replaceAccessGrantsOnRegistration` writes
   `[...newGrantIds, ...reusedExisting]` to the registration. A crash before
   this leaves a stale projection, but enforcement is already correct and the
   next reconciliation or sweep heals it.

Delete-before-create is deliberate: enforcement collects every grant for the
storage, so create-first would leave a fail-open window in which the old,
possibly broader grant still confers access. Delete-first leaves a short
fail-closed window that Temporal retries.

## 7. Chain validity and the revocation closure

`grant-chain.ts` answers two questions from the grant registry alone: is a grant
valid, and which grants become invalid when some grants are removed
([`grant-chain.ts`](../../packages/authorization-agent/src/grant-chain.ts)).

A grant is valid if it is a **source** grant (`grantedBy == dataOwner`, not an
inheriting child) or if it has an upstream grant satisfying a match-based
coverage predicate: same data owner, upstream `grantee == downstream grantedBy`,
same shape tree, registration and storage, scope coverage
(`All ⊃ AllFromAgent/AllFromRole ⊃ AllFromRegistry ⊃ SelectedFromRegistry`,
with `Inherited` covered by a same-registration `AllFromRegistry` or broader),
access-mode coverage, non-expanding creator modes, and instance coverage for
`SelectedFromRegistry`. A grant with `inheritsFromGrant` is a same-request
child: it needs a valid structural parent, and a delegated child additionally
needs its own valid upstream for its own shape tree.

Validity is computed as a **monotonic fixed point** (false → true) seeded with
the source grants, so a chain that never reaches a source grant stays invalid
and mutual delegations cannot bootstrap a valid cycle.

`invalidGrantsAfterRemoval(grants, removed)` is the closure used by revocation:

- the removed grants themselves;
- every grant that was valid **before** the operation and is invalid **after**
  it;
- all `inheritsFromGrant` descendants of that set.

Grants that were already invalid before the operation are **not** swept (they
are unrelated to this revocation and belong to the sweep), and a grant with an
alternative valid upstream stays valid — this is what re-anchors downstream
grants after a covering replacement.

The authorization agent's `revokeGrants` session method binds this predicate to
the **owner's** grant registry, applies the requested-set checks, verifies
grantor/owner authority per grant, and returns the closure
([`authorization-agent.ts`](../../packages/authorization-agent/src/authorization-agent.ts)).
The workflow-side `revokeGrantClosure` activity uses the same
`invalidGrantsAfterRemoval` predicate over the registry it is about to mutate.

The grant ACRs give the grantor only `acl:Read`; the old peer-facing
`GrantRevocationHandler`/`requestRevocations` boundary has been removed. A peer
cannot delete this agent's grants, and there is no owner-mediated HTTP
revocation endpoint to preserve.

## 8. Sweep backstop

Webhooks are at-least-once but can be missed, so `reconcileActivities` in the
workflow layer repairs state on a schedule (the production cadence is a
deployment concern)
([`temporal/workflows/grants.ts`](../../packages/components/src/temporal/workflows/grants.ts)):

- **Pending drain.** Every activity with no completion is re-routed by class;
  an `AuthorizationRevoked` activity re-runs `processAuthorizationRevoked`
  (self-completing, with the outer completion as an accepted duplicate). The
  carrier's refs and `grantee` are what make a stranded revocation recoverable
  after its authorization resources are gone.
- **Mirror completeness.** `findIncompleteReciprocalMirrors` lists reciprocal
  pairs whose local mirror graph is missing or whose linked grant bodies (and
  `meta:` twins) are absent, then forces a mirror sync for each. This is the
  local, no-peer-fetch signal for a mirror that was never written or lost a
  graph.
- **Projection drift.** `listGranteeRegistrations` enumerates the registered
  social agents and applications, and the sweep re-runs
  `reconcileGrantsForGrantee` for each. There is no separate desired-vs-existing
  comparison: the reconciliation *is* the comparison.
- **Peer freshness.** `reconcilePeerMirrors` re-fetches each reciprocal-linked
  peer's registration and grants through the per-peer consumer, which is the
  only way to see an upstream grant replaced or revoked when its webhook was
  missed. The consumer's deterministic workflow id serializes it with
  webhook-driven syncs; each drain replicates the mirror, regenerates the
  delegated grants, and only then completes the drained activities.

The sweep is deliberately writeless when nothing changed: `checkEquivalence`
reuses every unchanged tree and `replaceDataGrants` returns without a PATCH when
the link set is identical
([`agent-registration.ts`](../../packages/authorization-agent/src/agent-registration.ts)),
so a no-op sweep emits no reciprocal webhook. Failures are retried, never
treated as revocations: an unreachable owner or a `401`/`403`/`5xx` response
fails the activity (which Temporal retries), while `404`/`410` on a peer
registration is terminal because there is no source left to mirror.

## 9. Invariants worth preserving

| Invariant | Consequence |
|---|---|
| Authorizations are the only user-authored state | The UI never receives or sends grant IRIs; grant changes come from reconciliation |
| All ordinary grants live in the issuing agent's registry | Source and delegated grants share one local closure; no peer grant deletion |
| Revocation is idempotent | Re-revoking removed authorizations or grants succeeds and echoes the request |
| Delete-before-create | A revocation never transiently widens access |
| Closure expanded at write time | Retries and sweeps never need the deleted inheritance tree |
| Registration PATCH last | Enforcement is correct first; projections heal from the sweep |
| Grant resources are immutable | Reuse/equivalence and mirror freshness are link-set comparisons |
| Chain validity is match-based and rooted | A revoked upstream removes downstream grants; covering replacements re-anchor them |
| Typed RPC errors only | Refusals are machine-readable codes; no status/substring guessing |

## 10. Tests

- `packages/components/test/authorization-revocation-workflow.test.ts` — the
  workflow order (delete authorizations → reconcile each expanded grantee →
  complete) and role-member fan-out.
- `packages/components/test/grants-workflow.test.ts` — projection + GC (reuse,
  replace, deny as empty desired set, own-registry orphan scan, missing bodies)
  and delete-before-projection ordering.
- `packages/components/test/grants.test.ts`,
  `packages/components/test/grant-policy.test.ts`, and
  `packages/components/test/delegated-grants.test.ts` — projection behavior and
  delegated-grant generation.
- `packages/authorization-agent/test/grant-chain.test.ts` — scope/mode/instance
  coverage, multi-hop chains, cycles, replacement re-anchoring, and the closure.
- `/test/authorization-revocation.test.ts` and `/test/authorizations.test.ts` —
  end-to-end revoke/list flows; `/test/reconciliation.test.ts` — the sweep arms;
  `/test/roles.test.ts` and `/test/org-context.test.ts` — role and org-context
  revocation paths.
