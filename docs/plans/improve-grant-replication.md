# Improve delegated grant replication

> **Status:** design only. Follow-up to the reciprocal mirror and durable
> webhook work.

## 1. Problem

`ActivityWebhookHandler` starts two workflows in parallel for a
`DelegatedGrantsUpdated` activity:

- `updateDelegatedGrants` on `create-grants`
- `syncReciprocalMirror` on `reciprocal-registration`

`updateDelegatedGrants` regenerates the org's grants. For an authorization whose
`dataOwner` is a peer, `generateDelegatedDataGrants`
(`packages/authorization-agent/src/grant-generation.ts:198-246`) reads the local
mirror:

- it follows the org's registration of the peer to `reciprocalRegistration`
- loads the mirrored reciprocal registration
- reads its `hasDataGrant` links
- loads those mirrored grant documents
- uses a matching grant as `sourceGrant` and sets
  `delegationOfGrant: sourceGrant.id`

If `updateDelegatedGrants` runs before the mirror sync writes the new grants, it
generates delegated grants from stale data, or generates none because the old
mirror has no matching grant.

The reciprocal webhook carries the peer, the target, and the reciprocal
registration IRI. It does not carry the peer's grant documents. The mirror sync
is the only code that fetches them.

## 2. Goal

For every `DelegatedGrantsUpdated`:

1. Replicate the peer's reciprocal registration and its linked grants into the
   local mirror once.
2. Generate delegated grants only from the local mirror. Do not fetch the
   peer's grant list a second time.
3. Mark the activity done only after both steps. `done` then means the mirror
   and the delegated grants are current.

The only bulk peer fetch is the mirror replication. `requestDelegation` remains a
per-grant call to the data owner's issuance endpoint and is not part of this
fetch.

## 3. Target flow

`ReciprocalWebhookHandler` keeps writing the `DelegatedGrantsUpdated` activity.
The outbox write stays on auth and does not perform the remote fetch. On the
reciprocal webhook path, the activity delivery triggers replication first. No
delegated grant generation runs until the mirror write completes.

`ActivityWebhookHandler` starts one orchestration workflow instead of two
parallel workflows:

1. Replicate. Run `syncReciprocalMirror` to fetch the peer's reciprocal
   registration and linked grant documents and write them to the local mirror.
   This is the only bulk grant fetch.
2. Regenerate. Run `updateDelegatedGrants` with the fresh mirror. The existing
   `findAffectedGrantees` and `createGrantsForAuthorization` children stay
   unchanged. `generateDelegatedDataGrants` reads only local mirror data.
3. Complete. Call `markActivitiesDone` for the `DelegatedGrantsUpdated`
   activity after both steps succeed.

`reconcileActivities` uses the same orchestration for a pending
`DelegatedGrantsUpdated` activity. The current reconcile branch calls
`updateDelegatedGrants` only and misses the mirror sync.

## 4. Serialization

The mirror and the regeneration must serialize per `(webId, peerId)`. A second
`DelegatedGrantsUpdated` for the same peer must not regenerate from a stale
mirror while the first update is still replicating.

Options:

- A per-peer consumer workflow that receives a signal for each update and
  drains the latest state. This matches the existing per-grantee consumer
  pattern.
- A deterministic orchestration id such as
  `delegated-grants:${webId}:${peerId}`, with start-or-signal handling for a
  second event.
- Keep the mirror sync as a child with the existing
  `mirror:${webId}:${peerId}` id, but wait for an already-running sync instead
  of skipping it.

If a running mirror sync started before the newer peer update, joining it is not
enough. The orchestration must make the mirror reflect the latest peer state,
either by running the sync again after the join or by using a consumer that
re-runs after each signal.

## 5. Failure semantics

- If the peer mirror fetch fails and delegated grants are affected, the
  activity stays pending and retries. Regenerating from a stale mirror is worse
  than waiting.
- If the affected authorizations are source-only, the mirror is only a UI
  refresh. The default is still to fail and retry so `done` always means the
  mirror is current.
- A mirror failure must not silently complete the activity with stale
  delegated grants.

## 6. Implementation steps

1. Add the orchestration workflow in
   `packages/components/src/temporal/workflows/`.
2. Change the `DelegatedGrantsUpdated` branch in `ActivityWebhookHandler` to
   start the orchestration. Remove the separate parallel
   `syncReciprocalMirror` start.
3. Change the `DelegatedGrantsUpdated` branch in `reconcileActivities` to use the
   same orchestration.
4. Keep `syncReciprocalMirror` as the replication step. Keep
   `updateDelegatedGrants` as the regeneration step. Do not add a remote grant
   fetch to `generateDelegatedDataGrants`.
5. Decide the task queue placement. The mirror activity currently runs on
   `reciprocal-registration`; the regeneration workflows run on `create-grants`.
   A child workflow with an explicit task queue avoids registering every
   activity on both queues.
6. Update the worker registration and the OpenWiki activity/federation pages
   after the behavior lands.

## 7. Tests

- Peer updates its grants. The org's delegate sees the new delegated grant
  after one `done`, without polling between mirror and generation.
- Seed an old mirror. Deliver a `DelegatedGrantsUpdated`. The orchestration
  replicates first and generates delegated grants from the new grants.
- Send two updates for the same peer in quick succession. Assert no lost update
  and one final mirror/grants state.
- A pending `DelegatedGrantsUpdated` processed by `reconcileActivities` also
  mirrors before regenerating.
- Package tests for the orchestration input and ordering with mocked activities.

### Remove manual mirror setup from tests

- Remove direct mirror reads and mirror polling from `test/roles.test.ts` and
  `test/share.test.ts`. Observe the grantee-facing result after the `done`
  event, through a public RPC or a data-plane request.
- Assert internal grant fields such as `scopeOfGrant` and `dataOwner` on the
  grantor's local registration, not on the peer mirror.
- Do not call `syncReciprocalMirror` or write mirror graphs manually in tests.
  The runtime path under test must produce them.
- Decide the role of `applyReciprocalMirrors` in
  `packages/test-utils/src/fuseki.ts`. It is seed-time fixture setup, not a
  runtime replication path. If it remains, document that it only models an
  already-established federation. If tests must exercise initial replication,
  remove it and seed source data only.

## 8. Out of scope

- The drift scan for mirrors that have no peer update. That remains in
  `pod-isolation-followup.md`.
- `deleteReciprocalMirror` and unregister cleanup. The activity exists but has
  no caller.
- The acceptor-side initial mirror after `acceptInvitation`, if that remains
  separate from the reciprocal update path.
- A separate UI completion marker. The `DelegatedGrantsUpdated` `done` activity
  is the barrier.
