# Grant replication — follow-ups

> **Status:** ⬜ follow-up backlog (all items open). The design of the landed
> replicate-before-regenerate work is documented in the OpenWiki —
> [`architecture/federation.md`](../openwiki/architecture/federation.md#the-reciprocal-mirror-in-detail)
> (mirror contents, invariant, failure behaviour),
> [`services/activity-lifecycle.md`](../openwiki/services/activity-lifecycle.md)
> (`done` ⇒ mirror current), [`temporal/workflows.md`](../openwiki/temporal/workflows.md)
> (the two consumers), and [`testing/integration-tests.md`](../openwiki/testing/integration-tests.md)
> (the replication test surfaces). This plan tracks only what remains.

## Context

The reciprocal mirror is now: seeded at invitation time on both legs, refreshed
only by the per-peer `processDelegatedGrantsUpdated` consumer (which replicates
via a `reciprocal-registration` child workflow *before* regenerating), and read
exclusively by delegated-grant generation (one mirrored-peer index per
regeneration, `MirrorIncompleteError` on a gap). The mirror oracle is
presence-not-content (immutability ⇒ a linked grant body is either current or
absent) and covers `meta:` twins on read and drop.

What is left is: test-surface cleanup, one failure-policy gap, and the
query-cost work on the grantee-side reads.

## 1. Failure policy for terminal peer errors (not implemented)

The landed behaviour retries everything and, after
`syncReciprocalMirror`'s five-attempt cap, leaves the `DelegatedGrantsUpdated`
activity `pending`. The intended split — record it in code and cover it with a
test — is:

| Peer-side outcome during a sync | Intended behaviour |
| --- | --- |
| reciprocal link gone, or peer doc `404`/`410` | **terminal** — drop the mirror (`deleteReciprocalMirror`), regenerate, complete; a peer that unregistered us must not block `done` forever |
| `401`/`403` (ACR/credentials), `5xx`, network | **hard failure** — retry; never regenerate from a stale mirror, never complete |
| one grant unreadable inside an otherwise good sync | currently fails the whole sync (all-or-nothing). Decide whether a link that is permanently unreadable should be skipped with a recorded warning, or keep blocking |

The retry-cap consequence (permanent 403 ⇒ pending activity, because
`reconcileActivities` still has no schedule) is recorded in
[`update-deployment.md`](update-deployment.md) under workstream B — revisit the
cap there once the sweep is scheduled.

## 2. Test reorganisation (was S8)

- Move the direct mirror assertions out of `test/roles.test.ts` and
  `test/share.test.ts`; those suites should assert the grantee-facing result
  through a public RPC after the `done` barrier (`awaitGrantCompletion` →
  `waitForQuiescence`).
- Keep **one** dedicated federation test file as the only place that reads
  mirror graphs directly (never writes them).
- Do not call `syncReciprocalMirror` or write mirror graphs manually in tests;
  the runtime path under test must produce them. The invitation suite already
  proves runtime initial replication for a pair with no seeded relationship.
- `applyReciprocalMirrors` in `packages/test-utils/src/fuseki.ts` stays: the
  fixture models a federation that already exists and has been backfilled. Its
  documentation must keep saying that, and that it cannot exercise child
  delegation (no parent-side `hasInheritingGrant`).

## 3. Grantee-side read optimisations (was S9)

Every site below reads the peer's reciprocal registration/grants **in the role
of grantee**, already on the local plane — so these are correctness-neutral
query-cost items, not mirror work.

| # | Site | Today |
| --- | --- | --- |
| T1 | `packages/components/src/services/Authorization.ts` (`getDescriptions` data owners) | 1 + P(1+G) graph reads per RPC; rewrite as one JOIN over the mirror |
| T2 | `packages/components/src/services/DataRegistry.ts` (`dataGrantIndexForAgent`, `getReciprocalGrantsSparql`, incl. the fallback scan) | same shape, repeated per call; the fallback scan can go once coverage is guaranteed |
| T3 | `packages/components/src/services/DataRegistry.ts` (`listDataInstances` peer branch) | duplicates T2; reuse one index |
| T4 | `packages/components/src/services/SocialAgentRegistry.ts` (`adminOf`, data-owner rows) | 1 + P(1+G) per list render; `adminOf` needs only `hasAdminGrant` |
| T5 | `packages/components/src/services/Context.ts` (`isAdminOf`) | single graph read; needs the personal mirror, now seeded by the acceptor leg |
| T6 | `packages/components/src/ReciprocalWebhookHandler.ts` (`object` field) | informational read, currently unconsumed; kept with a comment — drop or document |
| T7 | `packages/components/src/temporal/activities/grants.ts` (`requestDelegation`) | per-grant endpoint discovery + POST; batch per `dataOwner`, resolve the issuance endpoint once (the code TODO) |
| T8 | `packages/components/src/temporal/activities/grants.ts` (`getExistingGrants`), consumed only by the dummy `checkEquivalence` | HTTP-GETs every grant IRI on our registration of the grantee, including onward delegated grants that live on the **data owner's** registry. While equivalence is a dummy, return IRIs only. The issuer-side replica that real equivalence needs is specified in [`check-equivalence.md`](check-equivalence.md) §2.1 |

## 4. Out of scope

- Mirror drift scan/backfill and the unregister deletion caller —
  [`pod-isolation-followup.md`](pod-isolation-followup.md) A1/A2.
- `reconcileActivities` scheduling — `revoke-delegation-chain-follow-ups.md`
  item 9.
- A separate UI completion marker: the `DelegatedGrantsUpdated` `done` activity
  is the barrier.
- Real `checkEquivalence` — [`check-equivalence.md`](check-equivalence.md).

## References

- OpenWiki: `architecture/federation.md`, `services/activity-lifecycle.md`,
  `temporal/workflows.md`, `temporal/sequence-views.md`,
  `testing/integration-tests.md`.
- Related plans: [`pod-isolation-followup.md`](pod-isolation-followup.md),
  [`check-equivalence.md`](check-equivalence.md),
  [`update-deployment.md`](update-deployment.md).
