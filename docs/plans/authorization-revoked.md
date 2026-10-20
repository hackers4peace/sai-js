# `authorizationRevoked` activity — typed revocation

> **Status: design only — adopted by the separate plan
> [`authorization-revocation.md`](authorization-revocation.md) (the
> authorization-revocation leg, extracted from the activity-first design now
> documented in the OpenWiki `services/activity-lifecycle.md`).** Extracted from
> `workflow-temporal-decupling.md` Phase 4.4. The routing (handler,
> per-target consumer, reconciliation sweep) already supports
> `authorizationRevoked`; only the **producer** still needs to write it — the
> plan's revokeGrants step makes the UI's revoke target the **authorization**
> (this producer) and moves the grant revocation into a workflow.

## 1. Problem

`recordAuthorization` writes an `authorizationRecorded` activity for **both**
grant and deny:

```ts
await ActivityRegistry.createActivity(activityRegistry, saiSession.factory, {
  activityType: 'authorizationRecorded',   // ← also used for granted: false
  payload: { webId, authorizationGrantee },
  ...
})
```

The deny path (`granted: false`) deletes the grantee's `DataAuthorization`
resources (`replaceDataAuthorizationsForGrantee`) and the consumer's full
regeneration then clears the grantee's grants — the **outcome** is correct, but
the **activity type** is semantically wrong: a denial/revocation is recorded as
an `authorizationRecorded`. This matters for:

- observability (the outbox says "recorded" for something that removed access);
- reconciliation/debugging (an admin can't tell revocations from grants in the
  Activity Registry);
- any future consumer that wants to distinguish (e.g., revocations that skip
  grant generation entirely instead of regenerating-to-empty).

## 2. Current state (as-is)

- **Routed already:** `ActivityWebhookHandler` routes `authorizationRevoked` to
  the per-target consumer (`GRANTEE_ACTIVITY_TYPES`); the consumer's
  `getPendingGranteeActivities` drains it; `reconcileActivities` (Phase 4.2)
  reprocesses it. **No consumer/handler/sweep changes needed.**
- **Produced:** only `authorizationRecorded` — from `recordAuthorization`
  (`services/Authorization.ts`, both grant and deny) and `shareResource`
  (grants only).
- **Revocation semantics today:** deny via `AuthorizeApp` (`granted: false`) →
  `recordAccessAuthorization` deletes the grantee's authorizations → the
  consumer regenerates → `createGrantsForAgent` sees zero authorizations →
  deny case → registration cleared (§4.1 of the main plan). Tests:
  `authorization.test.ts` "creates denied authorization" (grant → deny →
  grants cleared).

## 3. Change

`recordAuthorization` writes the **typed** activity:

```ts
activityType: authorization.granted ? 'authorizationRecorded' : 'authorizationRevoked',
```

Payload unchanged (`{ webId, authorizationGrantee }`) — the consumer's full
regeneration derives the outcome from the *authorization registry state*
(zero authorizations → clear grants), so the type is purely the label.

Nothing else changes:
- `recordAccessAuthorization` already deletes the authorizations for deny.
- The consumer/sweep treat both types identically (drain → regenerate →
  mark `done`).
- `shareResource` only ever grants — stays `authorizationRecorded`.

## 4. Design decisions

- **Why not a separate "revoke" RPC/service method?** The deny-via-`AuthorizeApp`
  (`granted: false`) is the existing revocation path (used by the grant-then-
  deny tests); introducing a second API would duplicate it. Typing the activity
  is the minimal, correct change. A dedicated admin-revoke RPC can build on the
  same activity type later (§6).
- **Regenerate-to-empty vs. skip-regeneration:** the consumer always
  regenerates (idempotent); for `authorizationRevoked` it derives "empty" from
  the registry. A future optimization could special-case revocations, but the
  current uniform regeneration is simpler and already correct.
- **No self-trigger loop:** revoking writes an activity to the Activity
  Registry only; `processRoleDeletion`'s `deleteAuthorizations` writes none (§6.8
  of the main plan) — the main agent never reacts to its own revocations.

## 5. Testing

- `authorization.test.ts` "creates denied authorization" already covers the
  flow; extend it to assert the activity type is `authorizationRevoked` (read
  the activity from bob's Activity Registry after the deny RPC:
  `loadActivity` → `activityType`).
- The grant case asserts `authorizationRecorded` (same test, first half).
- The suite stays green — behavior is unchanged (the type is cosmetic to the
  consumer).

## 6. Out of scope / follow-ups

- **Chain revocation (delegated grants down the chain):** this plan revokes
  only the grantor's own grantee set (regenerate-to-empty). Removing the whole
  delegation subchain — its grant resources and downstream propagation — is
  a separate mechanism: the **revocation operation at the data-owner boundary**
  in [`revoke-delegation-chain.md`](revoke-delegation-chain.md).
- A dedicated admin-revoke RPC/UI (can reuse `authorizationRevoked`).
- Special-casing revocations in the consumer (skip generation, just clear) —
  only if regeneration cost matters.
- Revoking a **single** data authorization vs. the grantee's whole set (today
  revocation is all-or-nothing per grantee via full regeneration).
