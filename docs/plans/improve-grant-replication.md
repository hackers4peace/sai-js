# Improve delegated grant replication

> **Status:** 🔶 partial — S1–S7 landed (green-to-green, `npm test` + dagger
> green at each step). Remaining: S8 (test reorganisation), S9 (follow-up
> optimisations).
>
> **Landed:** invitation-time mirror on both legs (S1); per-peer
> `processDelegatedGrantsUpdated` consumer — replicate → regenerate → complete
> (S2); webhook handler start-or-signal wiring replacing the two parallel
> starts (S3); the same consumer from `reconcileActivities` (S4); mirror-only
> generation with `MirrorIncompleteError` and one peer index per regeneration
> (S5).

## 1. Problem (historical — the parallel start described here is gone; kept for
context, see `git log` for the diff)

`ActivityWebhookHandler` starts two workflows in parallel for a
`DelegatedGrantsUpdated` activity
(`packages/components/src/ActivityWebhookHandler.ts:443-471`):

- `updateDelegatedGrants` on `create-grants` (`temporal/workflows/grants.ts:248`);
- `syncReciprocalMirror` on `reciprocal-registration`, serialized by the
  deterministic workflow id `mirror:${webId}:${peerId}`
  (`temporal/workflows/reciprocal.ts:111`).

`updateDelegatedGrants` regenerates the org's grants. For an authorization whose
`dataOwner` is a peer, `generateDelegatedDataGrants`
(`packages/authorization-agent/src/grant-generation.ts:166-265`) reads the local
mirror:

- it follows the org's registration of the peer to `reciprocalRegistration`
  (`:199`);
- loads the mirrored reciprocal registration (`:200-203`);
- reads its `hasDataGrant` links (`:205`);
- loads those mirrored grant documents (`:207-209`, children at `:136-138`);
- uses a matching grant as `sourceGrant` and sets `delegationOfGrant:
  sourceGrant.id` (`:246`).

If `updateDelegatedGrants` runs before the mirror sync writes the new grants, it
generates delegated grants from stale data, or generates none because the old
mirror has no matching grant.

The reciprocal webhook carries the peer, the target and the reciprocal
registration IRI; it does not carry grant documents. The mirror sync is the only
code that fetches them.

**Correction to the original framing (important, verified):** the generation
code already reads **only** the registry plane — `generateDataGrants` passes
`localSparqlTransport(this.sparqlEndpoint)`
(`packages/authorization-agent/src/authorization-agent.ts:528-548`), and
`requestDelegation` returns grant IRIs, never grant bodies
(`temporal/activities/grants.ts:440-474`). So "generation must not fetch from
peers" is already structurally true; **no code change is needed for it**. What
is *not* guaranteed today is that the local graphs (a) exist and (b) are
current. That is what this plan fixes, and what must become an explicit,
testable invariant.

## 2. Invariant — the mirror is complete and current

For every registration in the context's SocialAgentRegistry that carries a
`reciprocalRegistration` link, the local mirror
(`packages/components/src/services/ReciprocalMirror.ts`) holds:

1. the peer's reciprocal registration body, in a graph named after its IRI;
2. every grant linked from it via `interop:hasDataGrant`, same graph-per-IRI
   shape — **parents and inheriting children alike**;
3. nothing else (no peer data-plane content).

Verified: the grantor links parent **and** child grants in `hasDataGrant`, so
one level of `hasDataGrant` gives the generator everything it dereferences:

- source grants: `generateSourceDataGrants` returns
  `result.push(grant, ...childGrantData)`
  (`grant-generation.ts:381-383`) and `createGrantsForAgent` stores **and
  links** every entry (`temporal/workflows/grants.ts:622-634`);
- delegated grants: the issuance endpoint answers with
  `finalGrants.map((grant) => grant.id)` where `finalGrants` already contains
  the parents and their `inheritingGrants`
  (`packages/components/src/GrantIssuanceHandler.ts:166-190`), returned as IRIs
  by `requestDelegation`;
- seed fixture evidence: `acme/social-agent/m4k9wp` (Bob) links `p9m2vr` +
  `hdaymz` and `x4j8lm` + `q2v9pt`
  (`environments/data/registry.trig:255-258`), where `hdaymz`/`q2v9pt` are the
  `inheritsFromGrant` children (`:332`, `:369`).

Two caveats to keep as a regression test rather than an assumption:

- `generateChildDelegatedGrantData` reads the **parent's** `hasInheritingGrant`
  (`grant-generation.ts:136`), written only by the runtime
  (`:258`, `:383`). The seed fixture has no `hasInheritingGrant` on parents
  (only child→parent `inheritsFromGrant`), so the fixture **cannot** exercise
  child delegation — that case must be created through the runtime path.
- A missing mirror graph currently surfaces as a generic `Node <iri> not found
  in framed output` (`packages/utils/src/jsonld.ts:141-143`). S5 replaces it
  with an explicit mirror-incomplete error naming the registration/grant, so the
  invariant is assertable and debuggable. The only silent path that stays is
  "registration has no `reciprocalRegistration`" — there is nothing to mirror
  for such a peer.
- **Immutability assumption (load-bearing, verified):** grants are never
  mutated in place — a change mints a fresh IRI, the replaced grant is unlinked
  and the revoked one deleted, and the registration is re-linked
  (`workflows/grants.ts:622-660`). A mirrored grant body is therefore either
  **current** or **absent**; mirror maintenance never compares grant content,
  only the link-set delta and graph existence. This is what makes S7 a presence
  check rather than a re-fetch.
- **The mirror is grantee-side only.** It holds the grants where *we* are the
  grantee (P's registration of us links them). Grants where we are `grantedBy`
  are never mirrored by *this* plan: source grants live in our own registry, and
  onward delegated grants are written by the data owner's issuance endpoint into
  **the data owner's** registry (`GrantIssuanceHandler.issue` runs
  `getSession(dataOwner)`), where the data server resolves the
  `delegationOfGrant` chain locally. Our side keeps only their **IRIs**, linked
  on our registration of the grantee so that (a) the grantee's mirror copies
  them — which is what lets the grantee delegate further — and (b) our UI lists
  and cleanup can reach them. The only grantor-side grant dereference left is
  `getExistingGrants` (`temporal/activities/grants.ts:261-289`), whose sole
  consumer is the dummy `checkEquivalence`; making reuse real requires an
  **issuer-side** replica of those bodies — tracked in
  [`check-equivalence.md`](check-equivalence.md) §2.1 and T8 below.

## 3. Target flow

### 3.1 Initial replication — invitation time, both legs

The mirror is created once per pair, on **both** sides of the invitation, and
afterwards only refreshed by the reciprocal webhook:

- inviter side — already done: `establishReciprocal` calls
  `syncMirrorActivity` before `markActivitiesDone`
  (`temporal/workflows/reciprocal.ts:58-76`); works for personal and org
  contexts;
- acceptor side — **new**: `acceptInvitation` runs the same sync after
  `reciprocalWebhook`, before `markActivitiesDone`
  (`temporal/workflows/reciprocal.ts:90-103`).

There is no other registration-creation path (verified: `InvitationHandler`
writes `AgentRegistrationAdded`, `AgentRegistry.addSocialAgentRegistration` is
only called from `temporal/activities/reciprocal.ts:71`), so invitation time is
the single place a mirror has to be seeded. Ordering is already handled by the
existing retry policy: `reciprocalRegistration` only succeeds once the peer's
registration is discoverable (`temporal/workflows/reciprocal.ts:11-20`:
5s × 2 × 10 attempts), and a transient 403 in the peer's ACR-write window is
absorbed by the mirror sync's own retry.

### 3.2 Updates — webhook only

`ReciprocalWebhookHandler` keeps writing the `DelegatedGrantsUpdated` activity
(`packages/components/src/ReciprocalWebhookHandler.ts:53-84`). The outbox write
stays on auth and performs no remote fetch. Activity delivery drives **one**
orchestration per `(webId, peerId)`:

1. **Replicate** — child workflow `syncReciprocalMirror` with an explicit
   `taskQueue: 'reciprocal-registration'` (the `create-grants` worker does not
   register reciprocal activities, `workers/main.ts:71-90`; the reciprocal
   worker registers reciprocal **and** grants activities, `:51-58`).
2. **Regenerate** — `updateDelegatedGrants({webId, peerId})` called inline (it
   is a workflow function in the same module); it must be called **without**
   `activityId`, because it self-completes when one is present
   (`workflows/grants.ts:264-269`) and the orchestration owns completion.
   `findAffectedGrantees` / `createGrantsForAuthorization` children stay
   unchanged; `generateDelegatedDataGrants` reads only local mirror data.
3. **Complete** — `markActivitiesDone` for every activity drained in this pass.

`reconcileActivities` uses the same orchestration for pending
`DelegatedGrantsUpdated` activities (`workflows/grants.ts:463-474` today calls
`updateDelegatedGrants` only and misses the mirror).

### 3.3 Serialization — per-peer consumer

The consumer is the same shape as the existing per-grantee consumer
(`processGranteeActivities`, `workflows/grants.ts:120-166`): deterministic
workflow id `delegated-grants:${webId}:${peerId}`, a
`delegatedGrantsUpdatedSignal`, a drain loop, and a 3s idle exit.

Why the consumer and not "per-activity orchestration + deterministic id":
joining a still-running orchestration is not enough — it may have started
before the newer peer update. The consumer re-drains after every signal, so
each delivery ends with a mirror sync that starts **after** the delivery, which
is the only option here that does not depend on the reconcile sweep for lost
updates.

A new activity `getPendingDelegatedGrantsUpdates({webId, peerId})` filters
`getPendingActivities` (`temporal/activities/grants.ts:747-767`) by class and by
`target === peerId`. `waitForQuiescence` in `/test` polls pending activities
(`test/util.ts:216-245`), so it keeps working and — because completion now
follows the sync — gains the meaning "mirror is current" for free.

## 4. Failure semantics

| Peer-side outcome during mirror sync | Behaviour |
| --- | --- |
| registration/grants fetched, mirror written | proceed to regeneration |
| reciprocal link gone, or peer doc `404`/`410` | terminal — drop the mirror (`deleteReciprocalMirror`), regenerate, complete. A peer that unregistered us must not block `done` forever |
| `401`/`403` (ACR/credentials), `5xx`, network | hard failure — retry; do **not** regenerate from a stale mirror and do **not** complete |
| one grant unreadable inside an otherwise good sync | whole sync fails (all-or-nothing, current behaviour) — see the retry note below |

- Regenerating from a stale mirror is worse than waiting: an activity stays
  pending rather than completing with stale delegated grants.
- Source-only authorizations (no peer `dataOwner`) still wait: `done` must mean
  "mirror current".
- **Retry cap — decision (a):** the mirror child keeps today's 5-attempt cap
  (`temporal/workflows/reciprocal.ts:27-34`). Consequence: a permanent 403
  leaves the activity pending until the sweep runs. `reconcileActivities` has no
  scheduler yet (`docs/plans/revoke-delegation-chain.md:182`), so we accept a
  visible pending activity as the temporary failure mode. Reconsidering the cap
  (unbounded retries with terminal 404/410) is recorded in
  [`update-deployment.md`](update-deployment.md) (workstream B, webhook
  retries), to be revisited once the sweep is scheduled.
- Missed webhooks are not repaired here: the drift
  scan/backfill [`pod-isolation-followup.md`](pod-isolation-followup.md) A1 is
  the owner. After §3.1 lands, webhook delivery is the *only* refresh path, so
  A1 becomes load-bearing rather than cosmetic.

## 5. Implementation steps (green-to-green)

Gate for every step: `npm test` (vitest projects under `packages/*`) and
`dagger call test` green before moving on.

**S1 — invitation-time mirror on both legs. ✅ landed.** Added the
`syncMirrorActivity` call to `acceptInvitation`. No orchestration change. Test:
the invitation suite asserts both legs' mirrors after `done`, for a pair with
**no** fixture involvement (personal↔personal, org→personal, personal→org).

**S2 — per-peer consumer (unwired). ✅ landed.** Workflow
`processDelegatedGrantsUpdated` (+ `delegatedGrantsUpdatedSignal`) and activity
`getPendingDelegatedGrantsUpdates`; exported through the `create-grants.ts`
barrel (activities already registered on that queue). Package test
`packages/components/test/delegated-grants.test.ts` with a mocked
`@temporalio/workflow`: exact order replicate → regenerate → complete, burst
coalescing, mid-flight signal re-drain, idle no-op.

**S3 — webhook handler wires the consumer. ✅ landed.** Both starts replaced by
start-or-signal on `delegated-grants:${webId}:${peerId}` (the loop extracted to
`startOrSignal`, now shared with the `AuthorizationRevoked` branch). `object`
kept on the activity with a comment that it is unconsumed; the producer read is
untouched.

**S4 — reconcile arm. ✅ landed.** `reconcileActivities` starts the same
per-peer consumer (`executeChild` with the deterministic id, `AlreadyStarted`
swallowed — the in-workflow start-or-join contract the grantee consumer
already uses) instead of `executeChild(updateDelegatedGrants)` + its own
`markActivitiesDone`. The consumer completes the drained activities, so the
sweep never writes a completion that could predate the mirror.

**S5 — generation reads the mirror, explicitly. ✅ landed.** One
`MirroredPeerIndex` per `generateGrantsForAuthorization` (registry listing once,
per-peer mirrored side cached and presence-checked), so peer-side reads drop
from A × (1 + 2P + PG) to (1 + 2P + PG) per regeneration. A missing reciprocal
registration or linked grant raises `MirrorIncompleteError(<iri>, kind)`
(`presentGraphs` in `sparql.ts` is the probe — it reads `GRAPH <iri>` **UNION**
`GRAPH <meta:iri>`, the same union `graphDoc` frames; a probe that checked only
the resource graph produced a false `MirrorIncompleteError` on the seeded
meta-only registrations). Public `generateDataGrants` kept as a wrapper over an
internal `generateDataGrantsWithPeers`. Package test
`packages/authorization-agent/test/grant-generation.test.ts`: mirror-only
transport with `deps.fetch` throwing, one read per batch, field carry-over,
shape-tree matching, both `MirrorIncompleteError` kinds.

**S6 — docs and registration. ✅ landed (except the generated OpenWiki pages).**
Source comments that described the old flow are corrected: `ReciprocalMirror.ts`
header (wiring, single-writer, refresh paths, `MirrorIncompleteError`),
`ReciprocalWebhookHandler.ts` (who syncs), `workflows/reciprocal.ts` (retry-cap
recovery), `workflows/grants.ts` (consumer + reconcile).
[`pod-isolation-followup.md`](pod-isolation-followup.md) A1 now says what the
sweep already covers (a recorded-but-unprocessed delivery re-drives the consumer
that syncs) and what is left for the drift scan (deliveries that never arrived,
pairs never mirrored). The OpenWiki pages (`architecture/federation.md` 1a,
`temporal/workflows.md`, `services/activity-lifecycle.md`) are **generated** —
per `AGENTS.md` they are not hand-edited; the scheduled workflow refreshes them
from the code and these plans.

**S7 — mirror oracle: presence, not content. ✅ landed.** Today the oracle is the
mirror's own `hasDataGrant` list (`ReciprocalMirror.ts:120-146`): a grant listed
there is *assumed* current. Split that assumption in two:

- **content** — correct for free, because grants are immutable (§2): a
  linked-and-mirrored grant can never go stale, so there is nothing to compare
  or re-fetch;
- **existence** — only true if the body landed in the same atomic UPDATE. The
  sync's fetches all happen before that single UPDATE, so this code cannot
  produce a partial write; the exposure is writers *outside* it — the
  seed/backfill splitter tooling (A1 copies graphs one at a time, so an
  interrupted run leaves a registration naming grants whose graphs never
  landed), an ops restore of a single graph, or a backend/proxy where one
  multi-operation UPDATE is not one transaction.

Absence is currently **permanent**: the link-based oracle never re-fetches a
listed grant, and the reciprocal graph is re-inserted with the same list, so a
sync can never heal it — S5's `MirrorIncompleteError` would retry forever and
the only remedy is manual mirror deletion + resync. Fix: probe the bodies of the
still-linked grants (`presentGraphs`, the same union `graphDoc` reads) and treat
absent-but-linked grants as not-yet-mirrored, so the next sync fetches them.
**No content comparison** — unnecessary by immutability.

Two things the implementation surfaced:

- **`meta:` twins must be dropped too.** `mirroredGrants` now reads the link list
  from `GRAPH <R>` UNION `GRAPH <meta:R>` (a resource-only read reported
  "nothing mirrored" for meta-only mirrors, re-fetching every grant and never
  dropping stale ones), and every DROP covers both names — otherwise a
  seeded/restored `meta:` copy shadows the fresh resource graph through
  `graphDoc`'s union and resurrects stale `hasDataGrant` links.
- **`hasInheritingGrant` is a reverse term.** The data-model context defines it
  as `@reverse` of `interop:inheritsFromGrant` (there is no such predicate), so
  a parent grant document carries `<child> inheritsFromGrant <parent>` and
  framing surfaces `hasInheritingGrant`. The regression test now models exactly
  that (the seed, which keeps the edge only in the child's graph, cannot produce
  parent-side children — consistent with §2's caveat).

**S8 — test reorganisation.** Move mirror assertions out of
`test/roles.test.ts:42-64` and `test/share.test.ts:70-100` into one dedicated
federation test file; those suites assert the grantee-facing result through a
public RPC after the `done` barrier (`awaitGrantCompletion` →
`waitForQuiescence`). The dedicated file is the only place that reads mirror
graphs directly (never writes them).

**S9 — optional follow-ups** (§7) as separate tasks.

## 6. Tests

`/packages` — unit tests, mocking/spying allowed:

- consumer ordering and completion (S2);
- generation with a `fetch` stub that rejects any non-local IRI (S5);
- `MirrorIncompleteError` for a reciprocal-linked registration with no mirror
  graph (S5);
- parent links children in `hasDataGrant` (S7, the §2 invariant).

`/test` — black box only, no spying/mocking:

- peer updates its grants → the grantee sees the new delegated grant after one
  `done`, no polling between mirror and generation;
- an old mirror + a delivered `DelegatedGrantsUpdated` → mirrored first, then
  regenerated from the new grants;
- two updates for the same peer in quick succession → no lost update, one final
  state;
- pending `DelegatedGrantsUpdated` processed by the reconcile sweep mirrors
  before regenerating;
- invitation flow: both sides have a mirror right after their completion
  activity, for a pair with no seeded relationship (personal and org);
- child delegation created through the runtime path (the fixture cannot cover
  it — §2).

### Role of `applyReciprocalMirrors`

`packages/test-utils/src/fuseki.ts:95-134` stays. It is **seed-time fixture
setup**, not a runtime replication path: the fixture describes a federation
that already exists (alice↔bob, bob↔acme, yoyo↔bob), and no invitation flow is
ever executed for those pairs, so nothing at runtime would create their
mirrors. Removing it would make every org-context/personal reciprocal read fail
in tests for reasons unrelated to the code under test.

What it must not do is stand in for the runtime path. That is covered by the
invitation-flow cases above, which build a pair through the RPC and have no
seeded relationship. A comment on the function should say exactly this, and note
that it copies only `hasDataGrant` targets (which include children) and no
`hasInheritingGrant` siblings.

## 7. Follow-up optimisations (separate tasks, not in S1–S8)

All of these read the peer's reciprocal registration/grants **in the role of
grantee** and are already on the local plane — so they are correctness-neutral
once §3.1 lands, and are pure query-cost/latency items:

| # | Site | Today |
| --- | --- | --- |
| T1 | `services/Authorization.ts:249-266` (`getDescriptions` data owners) | 1 + P(1+G) graph reads per RPC; rewrite as one JOIN over the mirror |
| T2 | `services/DataRegistry.ts:123-168` (`dataGrantIndexForAgent`, `getReciprocalGrantsSparql`, incl. the fallback scan) | same shape, repeated per call; the fallback scan can go once coverage is guaranteed |
| T3 | `services/DataRegistry.ts:213-227` (`listDataInstances` peer branch) | duplicates T2; reuse one index |
| T4 | `services/SocialAgentRegistry.ts:34-41`, `:110-123`, `:195-210` (`adminOf`, data-owner rows) | 1 + P(1+G) per list render; `adminOf` needs only `hasAdminGrant` |
| T5 | `services/Context.ts:41-52` (`isAdminOf`) | single graph read; needs the personal mirror, delivered by S1 |
| T6 | `ReciprocalWebhookHandler.ts:62-72` | informational `object` read; kept (decision (b)), comment it |
| T7 | `temporal/activities/grants.ts:440-474` (`requestDelegation`) | per-grant endpoint discovery + POST; batch per `dataOwner`, resolve the issuance endpoint once (the code TODO) |
| T8 | `temporal/activities/grants.ts:261-289` (`getExistingGrants`), consumed only by the dummy `checkEquivalence` (`:322-326`) | HTTP-GETs every grant IRI on our registration of the grantee, including onward delegated grants that live on the **data owner's** registry (the last grantor-side peer dereference in the regeneration path). While equivalence is a dummy, return IRIs only. When real equivalence lands it needs the bodies — [`check-equivalence.md`](check-equivalence.md) §2.1 records the requirement (**replicate the grants where we are `grantedBy`**): link source is our own registration of the grantee, bodies replicate once at issuance (immutability ⇒ no refresh), dropped on unlink. Prefer an issuance-endpoint echo of `finalGrants` over a separate fetch + periodic sync |

## 8. Out of scope

- The drift scan / backfill tooling
  ([`pod-isolation-followup.md`](pod-isolation-followup.md) A1).
- `deleteReciprocalMirror`'s unregister caller (A2) — S4 only uses it for the
  terminal 404/410 case.
- `reconcileActivities` scheduling (`docs/plans/revoke-delegation-chain.md:182`).
- A separate UI completion marker: the `DelegatedGrantsUpdated` `done` activity
  is the barrier.
- Real `checkEquivalence` ([`check-equivalence.md`](check-equivalence.md)).

## 9. Open decisions

- Apply a child-grant mirror closure? **No** — `hasDataGrant` already lists
  parents and children (§2); only a regression test is added.
- Re-fetch mirrored grant *content*? **Never** — grants are immutable; the
  oracle checks existence only (§2, S7).
- Mirror retry cap: keep 5 for now, revisit per `update-deployment.md`
  (decision (a)).
- `DelegatedGrantsUpdated.object`: keep, comment as unconsumed (decision (b)).
- Fixture backfill: keep, documented as a pre-existing federation (§6).

## References

- OpenWiki: `architecture/federation.md` (shortcut 1a), `architecture/social-graph.md`,
  `temporal/workflows.md`, `services/activity-lifecycle.md`.
- Landed code: `services/ReciprocalMirror.ts`, `temporal/activities/reciprocal.ts`,
  `temporal/workflows/reciprocal.ts`, `ReciprocalWebhookHandler.ts`,
  `ActivityWebhookHandler.ts`.
- Related plans: [`pod-isolation-followup.md`](pod-isolation-followup.md),
  [`update-deployment.md`](update-deployment.md),
  [`revoke-delegation-chain.md`](revoke-delegation-chain.md).
